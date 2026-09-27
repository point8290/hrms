import { useState } from 'react';
import { can, formatDate, formatMoney, get, post, today } from '../lib/api.ts';
import { Alert, Card, Empty, ErrorMessage, Field, Loading, Modal, Table, useLoad } from '../components/ui.tsx';

type Structure = {
  id: string; name: string; effective_from: string; currency: string;
  component_count?: number;
};
type Employee = {
  id: string; employee_code: string; first_name: string; last_name: string;
};

/**
 * Salary structures and what each employee is on.
 *
 * Built because payroll cannot run without it — a run over employees with no compensation
 * assignment is refused with "no employees are eligible", which is the wall a new tenant hits
 * immediately after configuring everything else.
 *
 * Deliberately the minimum: a structure expressed as percentages of a base plus fixed
 * amounts, and an assignment of a CTC to a person from a date. The richer parts of the
 * compensation API — arbitrary component catalogues, formula components, revisions with
 * arrears — remain API-only and are recorded as such rather than half-built here.
 *
 * No money is computed in this screen. The structure describes proportions; the payroll
 * engine turns them into a payslip.
 */
export function CompensationSetup() {
  const structures = useLoad(
    () => get<{ structures: Structure[] }>('/api/compensation/structures'),
    [],
  );
  const employees = useLoad(
    () => get<{ employees: Employee[] }>('/api/employees?scope=all&limit=200')
      .catch(() => ({ employees: [] as Employee[] })),
    [],
  );
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const manages = can('compensation.manage');

  return (
    <>
      {message && <Alert kind="success">{message}</Alert>}
      <ErrorMessage error={structures.error} />

      <Card
        title="Salary structures"
        flush
        actions={manages && !creating
          ? <button className="small primary" onClick={() => setCreating(true)}>Add structure</button>
          : undefined}
      >
        {structures.loading ? (
          <Loading label="Loading salary structures" />
        ) : (
          <Table
            caption="Salary structures"
            rows={structures.data?.structures ?? []}
            keyOf={(row) => row.id}
            empty={
              <Empty title="No salary structure yet">
                Payroll cannot run until employees are on a structure — a run with nobody
                assigned is refused as having no eligible employees.
              </Empty>
            }
            columns={[
              { header: 'Structure', render: (r) => r.name },
              { header: 'Effective from', render: (r) => formatDate(r.effective_from) },
              { header: 'Currency', render: (r) => r.currency },
            ]}
          />
        )}
      </Card>

      {manages && (
        <Card
          title="Assignment"
          actions={!assigning
            ? <button className="small" onClick={() => setAssigning(true)}>Assign compensation</button>
            : undefined}
        >
          <p className="muted small" style={{ margin: 0 }}>
            An assignment puts one employee on a structure from a date, with their annual CTC.
            Assigning again supersedes the previous one rather than overwriting it, so the
            history stays intact.
          </p>
        </Card>
      )}

      {creating && (
        <NewStructure
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); structures.reload(); }}
        />
      )}
      {assigning && (
        <AssignCompensation
          structures={structures.data?.structures ?? []}
          employees={employees.data?.employees ?? []}
          onClose={() => setAssigning(false)}
          onDone={(line) => { setAssigning(false); setMessage(line); }}
        />
      )}
    </>
  );
}

/**
 * A structure, built from the two component shapes that need no formula language: a
 * percentage of something, and a fixed amount.
 *
 * The components themselves are created here too, because a structure references component
 * ids and a new tenant has none. `BASE` is the notional full salary an assignment supplies;
 * `BASIC` is a percentage of it, and everything else is a percentage of `BASIC` or a fixed
 * figure — which is how the statutory rules downstream expect to find `basic`.
 */
function NewStructure({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('Standard');
  const [effectiveFrom, setEffectiveFrom] = useState(`${new Date().getUTCFullYear()}-04-01`);
  const [basicPercent, setBasicPercent] = useState('50');
  const [hraPercent, setHraPercent] = useState('40');
  const [specialAmount, setSpecialAmount] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Components are per tenant and may already exist from a previous structure; a
      // conflict is not a failure here, so the existing id is reused.
      const ensure = async (spec: Record<string, unknown>) => {
        try {
          return (await post<{ id: string }>('/api/compensation/components', spec)).id;
        } catch (err) {
          if ((err as { status?: number }).status !== 409) throw err;
          const existing = await get<{ components: Array<{ id: string; code: string }> }>(
            '/api/compensation/components',
          ).catch(() => ({ components: [] as Array<{ id: string; code: string }> }));
          const found = existing.components.find((c) => c.code === spec.code);
          if (!found) throw err;
          return found.id;
        }
      };

      const basic = await ensure({
        code: 'BASIC', name: 'Basic', componentType: 'earning',
        calculationType: 'percentage', taxable: true, semanticRole: 'basic',
      });
      const hra = await ensure({
        code: 'HRA', name: 'House Rent Allowance', componentType: 'earning',
        calculationType: 'percentage', taxable: true, semanticRole: 'house_rent_allowance',
      });
      const special = await ensure({
        code: 'SPECIAL', name: 'Special Allowance', componentType: 'earning',
        calculationType: 'fixed', taxable: true,
      });

      await post('/api/compensation/structures', {
        name: name.trim(),
        effectiveFrom,
        components: [
          { componentId: basic, sequenceNo: 1, percentage: Number(basicPercent), percentageOfCode: 'BASE' },
          { componentId: hra, sequenceNo: 2, percentage: Number(hraPercent), percentageOfCode: 'BASIC' },
          ...(Number(specialAmount) > 0
            ? [{ componentId: special, sequenceNo: 3, fixedAmount: Number(specialAmount) }]
            : []),
        ],
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New salary structure"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Create structure</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      <p className="muted small" style={{ marginTop: 0 }}>
        A structure describes proportions, not amounts. Each employee's own figures come from
        the CTC on their assignment.
      </p>

      <div className="row">
        <Field label="Name" required htmlFor="cs-name">
          <input id="cs-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Effective from" required htmlFor="cs-from"
          hint="Usually the start of the financial year.">
          <input id="cs-from" type="date" value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
      </div>

      <Field label="Basic" required htmlFor="cs-basic" hint="Percentage of the monthly base.">
        <input id="cs-basic" type="number" min="1" max="100" value={basicPercent}
          onChange={(e) => setBasicPercent(e.target.value)} />
      </Field>
      <Field label="House rent allowance" required htmlFor="cs-hra"
        hint="Percentage of basic. Drives the HRA exemption.">
        <input id="cs-hra" type="number" min="0" max="100" value={hraPercent}
          onChange={(e) => setHraPercent(e.target.value)} />
      </Field>
      <Field label="Special allowance" htmlFor="cs-special"
        hint="A fixed monthly amount, if any.">
        <input id="cs-special" type="number" min="0" value={specialAmount}
          onChange={(e) => setSpecialAmount(e.target.value)} />
      </Field>
    </Modal>
  );
}

function AssignCompensation({
  structures, employees, onClose, onDone,
}: {
  structures: Structure[];
  employees: Employee[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState({
    employeeId: '', salaryStructureId: structures[0]?.id ?? '',
    annualCtc: '1200000', effectiveFrom: today(), reason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The API takes both the annual CTC and the monthly base the structure's percentages apply
  // to. Deriving one from the other keeps them consistent rather than asking twice.
  const baseAmount = Number(form.annualCtc) / 12;

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.employeeId) found.employeeId = 'Choose an employee.';
    if (!form.salaryStructureId) found.salaryStructureId = 'Choose a structure.';
    if (!(Number(form.annualCtc) > 0)) found.annualCtc = 'Enter the annual CTC.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/compensation/assignments', {
        employeeId: form.employeeId,
        salaryStructureId: form.salaryStructureId,
        annualCtc: Number(form.annualCtc),
        baseAmount: Number(baseAmount.toFixed(2)),
        effectiveFrom: form.effectiveFrom,
        ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
      });
      const who = employees.find((e) => e.id === form.employeeId);
      onDone(`${who?.first_name ?? 'Employee'} assigned ${formatMoney(form.annualCtc)} CTC.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Assign compensation"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Assign</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      {structures.length === 0 && (
        <Alert kind="warning">Create a salary structure first — an assignment needs one.</Alert>
      )}

      <Field label="Employee" required htmlFor="ca-emp" error={errors.employeeId}>
        <select id="ca-emp" value={form.employeeId}
          aria-invalid={errors.employeeId ? 'true' : undefined}
          onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
          <option value="">Choose&hellip;</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.first_name} {e.last_name} ({e.employee_code})
            </option>
          ))}
        </select>
      </Field>

      <div className="row">
        <Field label="Structure" required htmlFor="ca-struct" error={errors.salaryStructureId}>
          <select id="ca-struct" value={form.salaryStructureId}
            aria-invalid={errors.salaryStructureId ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, salaryStructureId: e.target.value })}>
            <option value="">Choose&hellip;</option>
            {structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Annual CTC" required htmlFor="ca-ctc" error={errors.annualCtc}
          hint={`Monthly base ${formatMoney(String(baseAmount || 0))}`}>
          <input id="ca-ctc" type="number" min="0" value={form.annualCtc}
            aria-invalid={errors.annualCtc ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
        </Field>
        <Field label="Effective from" required htmlFor="ca-from">
          <input id="ca-from" type="date" value={form.effectiveFrom}
            onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
        </Field>
      </div>

      <Field label="Reason" htmlFor="ca-reason" hint="Recorded on the compensation history.">
        <input id="ca-reason" value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </Field>
    </Modal>
  );
}
