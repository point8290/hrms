#!/usr/bin/env node
/**
 * End-to-end demonstration of the critical MVP journey (PRD s.30), over HTTP against a
 * running API, with the outbox publisher and both Python calculation engines doing the
 * asynchronous work.
 *
 *   Create Tenant -> Organization -> Employee -> Assign Shift -> Check In ->
 *   Calculate Attendance -> Apply Leave -> Calculate LOP -> Assign Salary ->
 *   Run Payroll -> Review -> Finalize -> Generate Payslip -> Notify
 *
 * This is a proof that the pieces fit together, not a test fixture: it uses only public
 * API endpoints and real queue delivery, so anything it exercises is something a client
 * could do.
 *
 * Usage:  node scripts/demo/mvp-journey.mjs [--base http://localhost:4000]
 */

import { createHmac } from 'node:crypto';

const BASE = argValue('--base') ?? process.env.API_BASE ?? 'http://localhost:4000';
const SLUG = `demo-${Date.now().toString(36)}`;
const ADMIN_EMAIL = `admin@${SLUG}.example.com`;
const ADMIN_PASSWORD = 'DemoPassword123';

// June 2026 starts on a Monday. A mid-year period also shows TDS behaving as intended:
// the annual liability is spread over the months still to be paid, rather than landing
// entirely in March as it would for a year-end run with nothing deducted earlier.
const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-30';

let token = null;
const steps = [];

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function log(step, detail = '') {
  steps.push(step);
  console.log(`  ${String(steps.length).padStart(2, ' ')}. ${step}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.error?.message ?? response.statusText;
    const details = payload?.error?.details ? ` ${JSON.stringify(payload.error.details)}` : '';
    throw new Error(`${method} ${path} -> ${response.status} ${message}${details}`);
  }
  return payload;
}

/** Waits for an asynchronously produced result instead of guessing at a sleep duration. */
async function waitFor(description, check, { timeoutMs = 60_000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

/**
 * Signs in, completing the second factor when the account needs one.
 *
 * A holder of any sensitive permission cannot get a session from a password alone
 * (ADR-012), and the tenant admin holds several. The journey enrols an authenticator the
 * way a real administrator would on first sign-in, then answers the challenge with a code
 * it generates itself — which is also a working end-to-end check of the TOTP flow.
 */
async function signIn(email, password) {
  const outcome = await api('POST', '/api/auth/login', { slug: SLUG, email, password });
  if (!outcome.mfa_required) return outcome;

  let challenge = outcome.challenge_token;
  if (outcome.stage === 'enroll') {
    const offer = await api('POST', '/api/auth/mfa/enroll', { challenge_token: challenge });
    const confirmed = await api('POST', '/api/auth/mfa/confirm', {
      challenge_token: challenge,
      code: totp(offer.secret),
    });
    return confirmed;
  }

  return api('POST', '/api/auth/mfa/verify', {
    challenge_token: challenge,
    // Unreachable in this journey: every run creates a fresh tenant, so the admin always
    // enrols rather than verifying. Left explicit so the branch is not silently wrong.
    code: (() => {
      throw new Error(`${email} already has an authenticator this journey cannot reproduce`);
    })(),
  });
}

/** RFC 6238, six digits, thirty-second step — the same arithmetic the API verifies. */
function totp(secret, step = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  const counter = Math.floor(Date.now() / 1000 / 30) + step;
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}


async function main() {
  console.log(`\nHRMS MVP journey against ${BASE}\n`);

  // ---------------------------------------------------------------- tenant
  await api('POST', '/api/tenants', {
    tenantName: 'Demo Industries',
    slug: SLUG,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    adminName: 'Demo Admin',
  });
  log('Created tenant', SLUG);

  const session = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  token = session.access_token;
  log(
    'Authenticated',
    `${session.permissions.length} permissions, second factor ${session.mfa ? 'verified' : 'not required'}`,
  );

  // ---------------------------------------------------------------- organization
  const company = await api('POST', '/api/companies', {
    name: 'Demo Industries Pvt Ltd',
    legalName: 'Demo Industries Private Limited',
  });
  const location = await api('POST', '/api/locations', {
    name: 'Bengaluru',
    timezone: 'Asia/Kolkata',
    stateCode: 'KA',
  });
  const department = await api('POST', '/api/departments', { name: 'Engineering' });
  const designation = await api('POST', '/api/designations', { name: 'Software Engineer' });
  log('Created organization', 'company, location, department, designation');

  const holidayList = await api('POST', '/api/holiday-lists', {
    name: 'India 2026',
    year: 2026,
    isDefault: true,
    weeklyOffs: [0],
    holidays: [{ date: '2026-06-25', name: 'Company Foundation Day' }],
  });
  log('Created holiday calendar', '1 holiday, Sunday weekly off');

  // ---------------------------------------------------------------- employees
  const manager = await api('POST', '/api/employees', {
    companyId: company.id,
    locationId: location.id,
    departmentId: department.id,
    designationId: designation.id,
    firstName: 'Priya',
    lastName: 'Sharma',
    workEmail: `priya@${SLUG}.example.com`,
    joiningDate: '2024-06-01',
    employmentStatus: 'active',
  });

  const employee = await api('POST', '/api/employees', {
    companyId: company.id,
    locationId: location.id,
    departmentId: department.id,
    designationId: designation.id,
    managerEmployeeId: manager.id,
    firstName: 'Arun',
    lastName: 'Kumar',
    workEmail: `arun@${SLUG}.example.com`,
    joiningDate: '2025-04-01',
    employmentStatus: 'active',
  });
  log('Created employees', `${manager.employee_code} (manager), ${employee.employee_code}`);

  await api('PUT', `/api/employees/${employee.id}/tax-profile`, {
    taxRegime: 'new',
    pfApplicable: true,
    esiApplicable: false,
    ptStateCode: 'KA',
    effectiveFrom: '2025-04-01',
  });
  await api('PUT', `/api/employees/${employee.id}/bank-account`, {
    accountHolder: 'Arun Kumar',
    accountNumber: '123456789012',
    bankName: 'HDFC Bank',
    ifsc: 'HDFC0001234',
    effectiveFrom: '2025-04-01',
  });
  log('Recorded tax profile and bank details', 'account number encrypted at rest');

  // ---------------------------------------------------------------- shift
  const shiftType = await api('POST', '/api/shift-types', {
    name: 'General Shift',
    code: 'GEN',
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 60,
    graceInMinutes: 10,
    graceOutMinutes: 10,
    fullDayThresholdMinutes: 480,
    halfDayThresholdMinutes: 240,
    overtimeEnabled: true,
    overtimeAfterMinutes: 480,
  });
  await api('POST', '/api/shift-assignments', {
    employeeId: employee.id,
    shiftTypeId: shiftType.id,
    holidayListId: holidayList.id,
    effectiveFrom: '2025-04-01',
  });
  log('Assigned shift', 'GEN 09:00-18:00');

  // ---------------------------------------------------------------- check in
  const checkin = await api('POST', '/api/attendance/checkins', {
    employeeId: employee.id,
    checkinAt: '2026-06-10T03:30:00Z', // 09:00 IST
    direction: 'in',
    source: 'web',
  });
  await api('POST', '/api/attendance/checkins', {
    employeeId: employee.id,
    checkinAt: '2026-06-10T12:35:00Z', // 18:05 IST
    direction: 'out',
    source: 'web',
  });
  log('Recorded check-ins', `attendance date ${checkin.attendance_date}`);

  // The workforce engine derives the day asynchronously via the outbox and SQS.
  const attendance = await waitFor('the workforce engine to derive attendance', async () => {
    const result = await api(
      'GET',
      `/api/attendance?employeeId=${employee.id}&from=2026-06-10&to=2026-06-10`,
    );
    const day = result.days.find((d) => d.date === '2026-06-10');
    return day && day.status !== 'not_marked' ? day : null;
  });
  log(
    'Attendance calculated by the workforce engine',
    `${attendance.status}, ${attendance.working_minutes} min worked, ${attendance.overtime_minutes} min overtime`,
  );

  // ---------------------------------------------------------------- leave
  const leaveType = await api('POST', '/api/leave/types', {
    name: 'Earned Leave',
    code: 'EL',
    requiresApproval: true,
    includeHolidays: false,
  });
  const lopType = await api('POST', '/api/leave/types', {
    name: 'Loss of Pay',
    code: 'LOP',
    isPaid: false,
    isLop: true,
    requiresApproval: false,
    allowNegativeBalance: true,
    maxNegativeBalance: 365,
  });

  await api('POST', '/api/leave/allocations', {
    employeeId: employee.id,
    leaveTypeId: leaveType.id,
    quantity: 18,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    source: 'policy',
  });
  log('Allocated leave', '18 days earned leave');

  await api('PUT', '/api/workflows/leave_application', {
    name: 'Leave approval',
    steps: [{ sequence: 1, approver: 'reporting_manager', sla_hours: 24 }],
  });
  log('Configured leave approval workflow', 'reporting manager, 24h SLA');

  const application = await api('POST', '/api/leave/applications', {
    employeeId: employee.id,
    leaveTypeId: leaveType.id,
    startDate: '2026-06-15',
    endDate: '2026-06-17',
    reason: 'Family function',
  });
  log('Applied for leave', `${application.quantity} days, status ${application.status}`);

  // The manager approves through the approvals inbox.
  const managerUser = await api('POST', '/api/users', {
    email: `priya@${SLUG}.example.com`,
    fullName: 'Priya Sharma',
    password: 'ManagerPassword123',
    roleNames: ['Manager'],
    employeeId: manager.id,
  });
  const adminToken = token;
  const managerSession = await signIn(`priya@${SLUG}.example.com`, 'ManagerPassword123');
  token = managerSession.access_token;

  const inbox = await api('GET', '/api/approvals');
  if (inbox.approvals.length === 0) throw new Error('the manager has no pending approvals');
  await api('POST', `/api/approvals/${inbox.approvals[0].id}/decision`, {
    decision: 'approved',
    note: 'Approved',
  });
  token = adminToken;
  log('Manager approved leave', `via approvals inbox (user ${managerUser.user_id.slice(0, 8)})`);

  const balance = await api('GET', `/api/leave/balance?employeeId=${employee.id}&asOf=2026-12-31`);
  const earned = balance.balances.find((b) => b.code === 'EL');
  log('Leave balance derived from the ledger', `allocated ${earned.allocated}, consumed ${earned.consumed}, balance ${earned.balance}`);

  // A day of LOP so payroll has something to pro-rate.
  await api('POST', '/api/leave/applications', {
    employeeId: employee.id,
    leaveTypeId: lopType.id,
    startDate: '2026-06-19',
    endDate: '2026-06-19',
    reason: 'Unpaid day',
  });
  log('Recorded a loss-of-pay day', '2026-06-19');

  // ---------------------------------------------------------------- compensation
  const components = {};
  for (const spec of [
    // `semanticRole` is what statute-aware calculations match on. Without it the HRA
    // exemption is zero however the component is named, which is the safe direction: a
    // tenant that has not said which component is the basic has not told us enough to
    // exempt anything.
    { code: 'BASIC', name: 'Basic', componentType: 'earning', calculationType: 'percentage', displayOrder: 1, semanticRole: 'basic' },
    { code: 'HRA', name: 'House Rent Allowance', componentType: 'earning', calculationType: 'percentage', displayOrder: 2, semanticRole: 'house_rent_allowance' },
    { code: 'SPECIAL', name: 'Special Allowance', componentType: 'earning', calculationType: 'fixed', displayOrder: 3 },
  ]) {
    components[spec.code] = (await api('POST', '/api/compensation/components', spec)).id;
  }

  const structure = await api('POST', '/api/compensation/structures', {
    name: 'Engineering Standard',
    effectiveFrom: '2025-04-01',
    components: [
      { componentId: components.BASIC, sequenceNo: 1, percentage: 50, percentageOfCode: 'BASE' },
      { componentId: components.HRA, sequenceNo: 2, percentage: 40, percentageOfCode: 'BASIC' },
      { componentId: components.SPECIAL, sequenceNo: 3, fixedAmount: 30000 },
    ],
  });

  await api('POST', '/api/compensation/assignments', {
    employeeId: employee.id,
    salaryStructureId: structure.id,
    annualCtc: 1_200_000,
    baseAmount: 100_000,
    effectiveFrom: '2025-04-01',
  });
  log('Assigned compensation', 'INR 12,00,000 CTC, effective 2025-04-01');

  // ---------------------------------------------------------------- payroll
  // Payroll refuses to build a snapshot over days attendance never evaluated (ADR-007).
  // In production the scheduler closes each day automatically; the demo has to wait for it
  // or close the period explicitly, so it asserts the guard and then satisfies it.
  const period = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'June 2026',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    payDate: '2026-07-01',
  });

  await expectRejection(
    'payroll is refused while attendance is unclosed',
    () => api('POST', '/api/payroll-runs', { payrollPeriodId: period.id, employeeIds: [employee.id] }),
  );

  const readiness = await api('GET', `/api/payroll-periods/${period.id}/attendance-readiness`);
  log(
    'Attendance readiness checked',
    `${readiness.closed_days}/${readiness.expected_days} days closed`,
  );

  // The scheduler closes days as each tenant's local cutoff passes. A demo cannot wait a
  // month, so it overrides with a stated reason — which is itself audited as sensitive.
  const run = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: period.id,
    employeeIds: [employee.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });
  log(
    'Created payroll run',
    `${run.employee_count} employee(s), inputs snapshotted, status ${run.status}`,
  );

  const calculated = await waitFor('the payroll engine to calculate the run', async () => {
    const detail = await api('GET', `/api/payroll-runs/${run.id}`);
    if (detail.status === 'failed') throw new Error(`payroll run failed: ${detail.failure_reason}`);
    return detail.status === 'calculated' ? detail : null;
  });
  log(
    'Payroll calculated by the payroll engine',
    `gross ${calculated.total_gross}, net ${calculated.total_net}`,
  );

  const payrollEmployees = await api('GET', `/api/payroll-runs/${run.id}/employees`);
  const line = payrollEmployees.employees[0];
  if (line.status === 'failed') throw new Error(`employee calculation failed: ${line.failure_reason}`);
  log('LOP applied', `${line.lop_days} LOP day(s), ${line.payable_days} payable days`);

  await api('POST', `/api/payroll-runs/${run.id}/review`);
  await api('POST', `/api/payroll-runs/${run.id}/approve`);
  log('Payroll reviewed and approved');

  const finalized = await api('POST', `/api/payroll-runs/${run.id}/finalize`);
  log('Payroll finalized', `${finalized.slips_finalized} payslip(s) now immutable`);

  const payslips = await waitFor('the worker to generate the payslip document', async () => {
    const result = await api('GET', `/api/payslips?employeeId=${employee.id}`);
    return result.payslips[0]?.document_id ? result.payslips[0] : null;
  });
  log('Payslip document generated', `${payslips.slip_number}, net ${payslips.net_amount}`);

  const detail = await api('GET', `/api/payslips/${payslips.id}`);
  console.log('\n     Payslip breakdown');
  for (const component of detail.components) {
    console.log(
      `       ${component.component_type.padEnd(22)} ${component.name.padEnd(28)} ${String(component.amount).padStart(12)}`,
    );
  }
  console.log(`       ${'NET PAY'.padEnd(51)} ${String(detail.net_amount).padStart(12)}\n`);

  const download = await api('GET', `/api/documents/${payslips.document_id}/download-url`);
  log('Payslip download authorized', `presigned for ${download.expires_in}s`);

  // ---------------------------------------------------------------- guarantees
  const audit = await api('GET', '/api/audit?sensitiveOnly=true&limit=100');
  log('Sensitive actions audited', `${audit.entries.length} records`);

  // ------------------------------------------------------------ HRA exemption
  //
  // A second period, this time with rent declared, because the June run above is the
  // regression baseline and must keep producing exactly the figures it always has. This is
  // the only place the whole chain is exercised: Node resolves the rent, the metro
  // classification and the forward plan, freezes them, and the *Python* engine reads them
  // back and applies the least of three. A shape mismatch between the two would pass every
  // unit test on both sides and fail here.
  // June was calculated on the new regime, which trades section 10(13A) away for lower
  // slabs. Its payslip must therefore carry no exemption line at all, whatever the rent —
  // and checking that first is what makes the positive case below mean something.
  if ((detail.components ?? []).some((c) => c.component_type === 'exemption')) {
    throw new Error('the new regime must not exempt HRA');
  }
  log('New regime forfeits the HRA exemption', 'no exemption line on the June payslip');

  await api('PUT', '/api/tax/rent-declarations', {
    employeeId: employee.id,
    periodStart: '2026-07-01',
    periodEnd: '2027-03-31',
    monthlyRent: 30000,
    metroClassification: 'metro',
  });
  log('Declared rent', 'INR 30,000/month from July 2026, metro');

  // Employees elect their regime, and the election changes what is exempt. Switching here
  // is what a real employee choosing the old regime would cause.
  await api('PUT', `/api/employees/${employee.id}/tax-profile`, {
    taxRegime: 'old',
    pfApplicable: true,
    esiApplicable: false,
    ptStateCode: 'KA',
    effectiveFrom: '2026-07-01',
  });
  log('Elected the old regime', 'section 10(13A) now applies');

  // Declared before any payslip for 2026-27 is finalized. Afterwards it is refused:
  // the exemption those payslips allowed was computed from this declaration, and
  // changing it would make a finalized payslip unexplainable.
  await api('PUT', '/api/tax/exemption-declarations', {
    employeeId: employee.id,
    financialYear: '2026-27',
    regime: 'old',
    sectionCode: '80C',
    declaredAmount: 200000,
  });
  await api('PUT', '/api/tax/exemption-declarations', {
    employeeId: employee.id,
    financialYear: '2026-27',
    sectionCode: '80D',
    declaredAmount: 18000,
  });
  log('Declared section exemptions', '80C INR 2,00,000 (over the ceiling), 80D INR 18,000');

  await expectRejection(
    'a section with no configured ceiling is refused',
    () =>
      api('PUT', '/api/tax/exemption-declarations', {
        employeeId: employee.id,
        financialYear: '2026-27',
        sectionCode: '80ZZZ',
        declaredAmount: 500000,
      }),
  );

  const julyPeriod = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'July 2026',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    payDate: '2026-08-01',
  });
  const julyRun = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: julyPeriod.id,
    employeeIds: [employee.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });

  await waitFor('the engine to apply the HRA exemption', async () => {
    const detail = await api('GET', `/api/payroll-runs/${julyRun.id}`);
    return detail.status === 'calculated' ? detail : null;
  });

  // Finalize it, both because /api/payslips deliberately shows an employee only finalized
  // slips and because it proves the exemption survives the guard that makes them immutable.
  await api('POST', `/api/payroll-runs/${julyRun.id}/review`);
  await api('POST', `/api/payroll-runs/${julyRun.id}/approve`);
  await api('POST', `/api/payroll-runs/${julyRun.id}/finalize`);

  const julyList = await api('GET', `/api/payslips?employeeId=${employee.id}`);
  const julyHeader = julyList.payslips.find((p) => p.period_start === '2026-07-01');
  if (!julyHeader) throw new Error('no July payslip was produced');
  const julySlip = await api('GET', `/api/payslips/${julyHeader.id}`);
  const exemptionLine = (julySlip.components ?? []).find((c) => c.component_type === 'exemption');

  if (!exemptionLine) {
    throw new Error('the payslip has no HRA exemption line; the engine did not read hra_json');
  }

  // Basic is 50% of 100,000 = 50,000 and HRA is 40% of basic = 20,000, both undiminished
  // because July has no loss of pay.
  //   A actual HRA                 20,000
  //   B 30,000 - 10% of 50,000     25,000
  //   C 50% of 50,000 (metro)      25,000
  const hraDetail = exemptionLine.calculation_detail ?? {};
  const expected = '20000.00';
  if (hraDetail.period_hra_exemption !== expected) {
    throw new Error(
      `HRA exemption is ${hraDetail.period_hra_exemption}, expected ${expected}`
        + ` (basic ${hraDetail.basic}, rent ${hraDetail.rent_paid}, ${hraDetail.metro_classification})`,
    );
  }
  log(
    'HRA exemption applied by the engine',
    `least of ${hraDetail.actual_hra_limit} / ${hraDetail.rent_minus_ten_percent_basic} / `
      + `${hraDetail.salary_limit} = ${hraDetail.period_hra_exemption}, ${hraDetail.metro_classification}`,
  );
  log(
    'Taxable income reduced, pay untouched',
    `gross ${julySlip.gross_amount}, taxable ${julySlip.taxable_earnings}, `
      + `exemption ${julySlip.hra_exemption}`,
  );

  // ------------------------------------------------ chapter VI-A exemptions
  //
  // Declared over the 80C ceiling on purpose. The whole point of the phase is that the
  // ceiling binds and that the payslip says so — storing only the allowed figure would make
  // "declared 150,000" and "declared 200,000, capped" look identical.
  const augPeriod = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'August 2026',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    payDate: '2026-09-01',
  });
  const augRun = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: augPeriod.id,
    employeeIds: [employee.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });
  await waitFor('the engine to cap the section exemptions', async () => {
    const detail = await api('GET', `/api/payroll-runs/${augRun.id}`);
    return detail.status === 'calculated' ? detail : null;
  });
  await api('POST', `/api/payroll-runs/${augRun.id}/review`);
  await api('POST', `/api/payroll-runs/${augRun.id}/approve`);
  await api('POST', `/api/payroll-runs/${augRun.id}/finalize`);

  const augList = await api('GET', `/api/payslips?employeeId=${employee.id}`);
  const augHeader = augList.payslips.find((p) => p.period_start === '2026-08-01');
  if (!augHeader) throw new Error('no August payslip was produced');
  const augSlip = await api('GET', `/api/payslips/${augHeader.id}`);

  const capped = (augSlip.components ?? []).find((c) => c.code === 'EXEMPTION_80C');
  const uncapped = (augSlip.components ?? []).find((c) => c.code === 'EXEMPTION_80D');
  if (!capped || !uncapped) {
    throw new Error('the payslip has no section exemption lines; the engine did not read exemption_json');
  }

  const c80 = capped.calculation_detail ?? {};
  if (c80.allowed_exemption !== '150000.00' || c80.declared_amount !== '200000.00') {
    throw new Error(
      `80C allowed ${c80.allowed_exemption} of declared ${c80.declared_amount}, expected 150000.00 of 200000.00`,
    );
  }
  if (c80.capped_by_statute !== true) throw new Error('80C should be marked as capped');

  const d80 = uncapped.calculation_detail ?? {};
  if (d80.allowed_exemption !== '18000.00' || d80.capped_by_statute !== false) {
    throw new Error(`80D allowed ${d80.allowed_exemption}, capped=${d80.capped_by_statute}`);
  }

  log(
    'Section 80C capped by statute',
    `declared ${c80.declared_amount}, eligible ${c80.eligible_amount}, `
      + `ceiling ${c80.configured_cap} (v${c80.rule_version}, ${c80.tax_year}) -> allowed ${c80.allowed_exemption}`,
  );
  log(
    'Section 80D allowed in full',
    `declared ${d80.declared_amount}, ceiling ${d80.configured_cap} -> allowed ${d80.allowed_exemption}`,
  );
  log(
    'Sections capped independently',
    `total ${augSlip.section_exemption_total}, not one shared ceiling`,
  );

  // ----------------------------------------------------------- proof cutoff
  //
  // The August run above allowed 80C in full on the employee's word alone. A proof cutoff
  // is what turns that word into a deduction or takes it away: after the date, an
  // unproved declaration is worth nothing, while the declared figure stays on the record.
  //
  // This is also the one place the whole chain is exercised — Node resolves the cutoff
  // against the period end and freezes a boolean, and the *Python* engine reads it back.
  const years = await api('GET', '/api/tax/years');
  const fy = years.tax_years.find((y) => y.label === '2026-27');
  if (!fy) throw new Error('no 2026-27 tax year');

  await api('PUT', `/api/tax/years/${fy.id}/proof-cutoff`, {
    proofCutoffDate: '2027-01-31',
  });
  log('Configured the proof cutoff', '2026-27 proof due before 2027-01-31');

  // A February period: the cutoff has gone and 80C was never proved.
  const febPeriod = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'February 2027',
    periodStart: '2027-02-01',
    periodEnd: '2027-02-28',
    payDate: '2027-03-01',
  });
  const febRun = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: febPeriod.id,
    employeeIds: [employee.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });
  await waitFor('the engine to apply the proof cutoff', async () => {
    const detail = await api('GET', `/api/payroll-runs/${febRun.id}`);
    return detail.status === 'calculated' ? detail : null;
  });
  await api('POST', `/api/payroll-runs/${febRun.id}/review`);
  await api('POST', `/api/payroll-runs/${febRun.id}/approve`);
  await api('POST', `/api/payroll-runs/${febRun.id}/finalize`);

  const febList = await api('GET', `/api/payslips?employeeId=${employee.id}`);
  const febHeader = febList.payslips.find((p) => p.period_start === '2027-02-01');
  if (!febHeader) throw new Error('no February payslip was produced');
  const febSlip = await api('GET', `/api/payslips/${febHeader.id}`);

  const lapsed = (febSlip.components ?? []).find((c) => c.code === 'EXEMPTION_80C');
  if (!lapsed) throw new Error('the payslip has no 80C line; the engine did not read exemption_json');
  const lapsedDetail = lapsed.calculation_detail ?? {};

  if (lapsedDetail.effective_status !== 'unverified' || lapsedDetail.cutoff_passed !== true) {
    throw new Error(
      `80C is ${lapsedDetail.effective_status}, cutoff_passed=${lapsedDetail.cutoff_passed}; expected unverified/true`,
    );
  }
  if (lapsedDetail.allowed_exemption !== '0.00' && lapsedDetail.allowed_exemption !== '0') {
    throw new Error(`80C allowed ${lapsedDetail.allowed_exemption} after the cutoff, expected 0`);
  }
  // The declaration is not deleted and not rewritten — only made ineligible.
  if (lapsedDetail.declared_amount !== '200000.00') {
    throw new Error(`80C declared amount became ${lapsedDetail.declared_amount}`);
  }
  log(
    'Unproved 80C lapsed at the cutoff',
    `declared ${lapsedDetail.declared_amount} still on record, allowed `
      + `${lapsedDetail.allowed_exemption}, cutoff ${lapsedDetail.proof_cutoff_date}`,
  );

  // The August payslip, finalized before the cutoff, is untouched by any of this.
  const augCheck = await api('GET', `/api/payslips/${augHeader.id}`);
  if (augCheck.section_exemption_total !== augSlip.section_exemption_total) {
    throw new Error(
      `the finalized August payslip moved: ${augSlip.section_exemption_total} -> ${augCheck.section_exemption_total}`,
    );
  }
  log(
    'Finalized payroll unmoved',
    `August still allows ${augCheck.section_exemption_total}; the cutoff is not retroactive`,
  );

  // And proof accepted late restores eligibility for the periods still to come: the cutoff
  // decides what an *unproved* declaration is worth, not whether proof may still be seen.
  const declarations = await api('GET', `/api/tax/exemption-declarations?employeeId=${employee.id}`);
  const c80item = declarations.declarations.find((d) => d.section_code === '80C');
  const proof = await api('POST', `/api/tax/exemption-declarations/${c80item.id}/proof`, {
    status: 'verified',
    eligibleAmount: 150000,
    reason: 'late submission accepted under HR policy',
  });
  if (proof.status !== 'verified' || proof.previous_status !== 'declared') {
    throw new Error(`proof outcome ${proof.previous_status} -> ${proof.status}`);
  }
  log(
    'Late proof accepted',
    `${proof.previous_status} -> ${proof.status} for ${proof.eligible_amount}, `
      + 'eligible again for the periods still to be paid',
  );

  // -------------------------------------------- surcharge and marginal relief
  //
  // A senior hire whose *annualised* income crosses the first surcharge threshold. Her
  // monthly figure is nowhere near fifty lakh, which is exactly the point: surcharge is
  // decided by the year's total income, and a monthly band test would miss her entirely.
  //
  // The salary is chosen to land just inside the marginal-relief zone, where crossing the
  // threshold would otherwise cost more tax than the income that crossed it.
  const senior = await api('POST', '/api/employees', {
    companyId: company.id,
    locationId: location.id,
    departmentId: department.id,
    designationId: designation.id,
    firstName: 'Priya',
    lastName: 'Raghavan',
    workEmail: `priya@${SLUG}.example.com`,
    joiningDate: '2025-04-01',
    employmentStatus: 'active',
  });
  await api('PUT', `/api/employees/${senior.id}/tax-profile`, {
    taxRegime: 'old',
    pfApplicable: false,
    esiApplicable: false,
    effectiveFrom: '2025-04-01',
  });

  const seniorStructure = await api('POST', '/api/compensation/structures', {
    name: 'Executive',
    effectiveFrom: '2025-04-01',
    components: [
      { componentId: components.BASIC, sequenceNo: 1, percentage: 100, percentageOfCode: 'BASE' },
    ],
  });
  await api('POST', '/api/compensation/assignments', {
    employeeId: senior.id,
    salaryStructureId: seniorStructure.id,
    annualCtc: 5_150_000,
    baseAmount: 429_166.67,
    effectiveFrom: '2025-04-01',
  });
  log('Created a senior hire', 'INR 4,29,166.67/month, old regime');

  // April 2026 — the first period of the tax year, so the whole year is still projection.
  // It also resolves income-tax rule version 2, which is the first version carrying
  // surcharge bands; a run in 2025-26 still resolves version 1 and has none.
  const aprPeriod = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'April 2026',
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    payDate: '2026-05-01',
  });
  const aprRun = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: aprPeriod.id,
    employeeIds: [senior.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });
  await waitFor('the engine to apply surcharge and marginal relief', async () => {
    const detail = await api('GET', `/api/payroll-runs/${aprRun.id}`);
    return detail.status === 'calculated' ? detail : null;
  });

  const seniorLine = (await api('GET', `/api/payroll-runs/${aprRun.id}/employees`))
    .employees.find((e) => e.employee_id === senior.id);
  if (!seniorLine || seniorLine.status === 'failed') {
    throw new Error(`senior calculation failed: ${seniorLine && seniorLine.failure_reason}`);
  }

  await api('POST', `/api/payroll-runs/${aprRun.id}/review`);
  await api('POST', `/api/payroll-runs/${aprRun.id}/approve`);
  await api('POST', `/api/payroll-runs/${aprRun.id}/finalize`);

  const readTds = async () => {
    const list = await api('GET', `/api/payslips?employeeId=${senior.id}`);
    const header = list.payslips.find((p) => p.period_start === '2026-04-01');
    if (!header) throw new Error('no April payslip for the senior hire');
    const slip = await api('GET', `/api/payslips/${header.id}`);
    const line = (slip.components ?? []).find((c) => c.code === 'TDS');
    if (!line) throw new Error('no TDS line on the senior payslip');
    return { slip, line, detail: line.calculation_detail ?? {} };
  };

  const { line: tdsLine, detail: t } = await readTds();
  const sd = t.surcharge_detail ?? {};
  const num = (v) => Number(v ?? 0);

  if (sd.applicable !== true) throw new Error(`surcharge not applied: ${JSON.stringify(sd)}`);
  if (!(num(t.surcharge_before_relief) > 0)) throw new Error('no surcharge before relief');
  if (!(num(t.marginal_relief) > 0)) throw new Error('marginal relief did not apply');
  if (!(num(t.surcharge) < num(t.surcharge_before_relief))) {
    throw new Error('relief did not reduce the surcharge');
  }

  // The statutory guarantee, checked against the real figures rather than asserted in prose:
  // crossing the threshold must not cost more tax than the income that crossed it.
  const liabilityHere = num(t.base_tax) + num(t.surcharge);
  const ceiling = num(sd.tax_at_threshold) + num(sd.income_above_threshold);
  if (liabilityHere > ceiling + 0.01) {
    throw new Error(`marginal relief failed: ${liabilityHere} > ${ceiling}`);
  }

  // And the annual liability reconciles: base tax + relieved surcharge + cess.
  const reconciled = num(t.base_tax) + num(t.surcharge) + num(t.cess);
  if (Math.abs(reconciled - num(t.annual_tax)) > 0.01) {
    throw new Error(`annual tax ${t.annual_tax} does not reconcile with ${reconciled}`);
  }

  log('Annualised income crossed a surcharge threshold',
      `taxable ${t.annual_taxable} over threshold ${sd.threshold} at rate ${sd.rate}`);
  log('Base tax', `${t.base_tax}`);
  log('Surcharge before marginal relief', `${t.surcharge_before_relief}`);
  log('Marginal relief',
      `${t.marginal_relief} — tax at threshold ${sd.tax_at_threshold} + income above ${sd.income_above_threshold}`);
  log('Surcharge after marginal relief', `${t.surcharge}`);
  log('Health and education cess', `${t.cess}`);
  log('Final annual tax liability', `${t.annual_tax}, spread as monthly TDS ${tdsLine.amount}`);

  await expectRejection(
    'a finalized surcharge run cannot be recalculated',
    () => api('POST', `/api/payroll-runs/${aprRun.id}/recalculate`),
  );

  // Deterministic: reading the finalized figures again gives byte-identical numbers, and
  // the run cannot be recalculated into different ones.
  const { detail: again } = await readTds();
  for (const key of ['base_tax', 'surcharge_before_relief', 'marginal_relief', 'surcharge',
                     'cess', 'annual_tax', 'annual_taxable']) {
    if (again[key] !== t[key]) {
      throw new Error(`${key} moved after finalization: ${t[key]} -> ${again[key]}`);
    }
  }
  log('Finalized surcharge output is immutable', 'every figure identical on re-read');

  // ------------------------------------------------------- professional tax
  //
  // PT is a state levy, so the only question is *where*. The chain is: an explicit
  // pt_state_code on the tax profile if there is one, otherwise the work location's state.
  // Both resolve as at the payroll period's end, which is what keeps history honest when
  // someone transfers.
  //
  // Publishing a rule is deliberately not in this section: statutory rules are read-only
  // over HTTP (ADR-005) because a version a finalized run consumed is never edited, and this
  // journey only uses endpoints a client could call. That a later rule cannot reach back
  // into a snapshotted run is proved in the integration suite, where direct database access
  // is legitimate. What is proved here is what a client can see: jurisdiction resolution,
  // the trace, a transfer, and history staying put.
  const ptSlip = await api('GET', `/api/payslips/${augHeader.id}`);
  const ptLine = (ptSlip.components ?? []).find((c) => c.code === 'PT');
  if (!ptLine) throw new Error('no professional tax line on the August payslip');
  const ptDetail = ptLine.calculation_detail ?? {};

  if (ptDetail.jurisdiction !== 'KA') {
    throw new Error(`PT jurisdiction is ${ptDetail.jurisdiction}, expected KA`);
  }
  if (ptDetail.jurisdiction_source !== 'tax_profile') {
    throw new Error(`PT state came from ${ptDetail.jurisdiction_source}, expected tax_profile`);
  }
  if (!ptDetail.rule_id || !ptDetail.rule_version) {
    throw new Error('the PT line does not identify the rule that produced it');
  }
  log(
    'Professional tax resolved from the work jurisdiction',
    `${ptDetail.jurisdiction} via ${ptDetail.jurisdiction_source}, rule v${ptDetail.rule_version} `
      + `effective ${ptDetail.rule_effective_from}`,
  );
  log(
    'PT explained by its slab',
    `wage ${ptDetail.wage_basis} matched "${ptDetail.matched_slab}" -> ${ptDetail.final_amount}`,
  );

  // A transfer to Maharashtra from December. The tax profile is effective-dated, so this is
  // a new assertion rather than an edit and August keeps the state it was paid under.
  await api('PUT', `/api/employees/${employee.id}/tax-profile`, {
    taxRegime: 'old',
    pfApplicable: true,
    esiApplicable: false,
    ptStateCode: 'MH',
    effectiveFrom: '2026-12-01',
  });
  log('Transferred the employee to Maharashtra', 'effective 2026-12-01');

  const decPeriod = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'December 2026',
    periodStart: '2026-12-01',
    periodEnd: '2026-12-31',
    payDate: '2027-01-01',
  });
  const decRun = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: decPeriod.id,
    employeeIds: [employee.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });
  await waitFor('the engine to apply the new jurisdiction', async () => {
    const detail = await api('GET', `/api/payroll-runs/${decRun.id}`);
    return detail.status === 'calculated' ? detail : null;
  });
  await api('POST', `/api/payroll-runs/${decRun.id}/review`);
  await api('POST', `/api/payroll-runs/${decRun.id}/approve`);
  await api('POST', `/api/payroll-runs/${decRun.id}/finalize`);

  const decList = await api('GET', `/api/payslips?employeeId=${employee.id}`);
  const decHeader = decList.payslips.find((p) => p.period_start === '2026-12-01');
  if (!decHeader) throw new Error('no December payslip');
  const decSlip = await api('GET', `/api/payslips/${decHeader.id}`);
  const decPt = (decSlip.components ?? []).find((c) => c.code === 'PT');
  if (!decPt) throw new Error('no PT line on the December payslip');
  const decDetail = decPt.calculation_detail ?? {};

  if (decDetail.jurisdiction !== 'MH') {
    throw new Error(`December PT jurisdiction is ${decDetail.jurisdiction}, expected MH`);
  }
  log(
    'New payroll uses the new state',
    `December resolved ${decDetail.jurisdiction} via ${decDetail.jurisdiction_source}, `
      + `matched "${decDetail.matched_slab}" -> ${decDetail.final_amount}`,
  );

  // The already-finalized August payslip is untouched by the transfer: it was paid under
  // Karnataka and reads its own frozen snapshot, not today's tax profile.
  const augAfterTransfer = await api('GET', `/api/payslips/${augHeader.id}`);
  const augPtAfter = (augAfterTransfer.components ?? []).find((c) => c.code === 'PT');
  if (augPtAfter.calculation_detail.jurisdiction !== 'KA' || augPtAfter.amount !== ptLine.amount) {
    throw new Error(
      `the transfer moved historical payroll: ${ptLine.amount} in ${ptDetail.jurisdiction} `
        + `became ${augPtAfter.amount} in ${augPtAfter.calculation_detail.jurisdiction}`,
    );
  }
  log(
    'Historical payroll keeps its old jurisdiction',
    `August is still ${augPtAfter.calculation_detail.jurisdiction} at ${augPtAfter.amount}`,
  );

  await expectRejection(
    'a finalized PT run cannot be recalculated',
    () => api('POST', `/api/payroll-runs/${decRun.id}/recalculate`),
  );

  // ------------------------------------------------------- provident fund
  //
  // PF has been on every payslip in this journey; what was never shown is *why* the figure
  // is what it is. The PRD asks statutory rules to be versioned data "rather than scattered
  // as hard-coded logic", so the wage basis, both rates and the ceiling all come from a
  // resolvable rule — and the payslip now names the rule that produced the number.
  //
  // Publishing a rule is not demonstrated here: statutory rules are read-only over HTTP
  // (ADR-005), and this journey only uses endpoints a client could call. That a later rule
  // cannot re-price a snapshotted run is proved in the integration suite.
  const pfSlip = await api('GET', `/api/payslips/${augHeader.id}`);
  const pfEmployee = (pfSlip.components ?? []).find((c) => c.code === 'PF_EMPLOYEE');
  const pfEmployer = (pfSlip.components ?? []).find((c) => c.code === 'PF_EMPLOYER');
  if (!pfEmployee) throw new Error('no employee PF line on the August payslip');
  if (!pfEmployer) throw new Error('no employer PF line on the August payslip');

  const pfDetail = pfEmployee.calculation_detail ?? {};
  if (!pfDetail.rule_id || !pfDetail.rule_version) {
    throw new Error('the PF line does not identify the rule that produced it');
  }
  const contributing = (pfDetail.contributing_components ?? []).map((c) => c.code);
  if (contributing.length === 0) {
    throw new Error('the PF trace does not say which components formed the PF wage');
  }
  log(
    'Provident fund wage basis resolved from the rule',
    `components [${contributing.join(', ')}] -> wage ${pfDetail.wage_basis}, `
      + `contributory ${pfDetail.contributory_wage} (ceiling applied: ${pfDetail.ceiling_applied})`,
  );
  log(
    'PF contributions computed from versioned rates',
    `employee ${pfDetail.employee_rate} -> ${pfDetail.employee_contribution}, `
      + `employer ${pfDetail.employer_rate} -> ${pfDetail.employer_contribution} `
      + `(rule v${pfDetail.rule_version}, ${pfDetail.rule_source})`,
  );

  // The separation that matters: the employee's contribution comes out of their pay, the
  // employer's does not.
  const grossNum = Number(pfSlip.gross_amount);
  const deductionsNum = Number(pfSlip.deduction_amount);
  const taxNum = Number(pfSlip.tax_amount);
  const netNum = Number(pfSlip.net_amount);
  if (Math.abs(grossNum - deductionsNum - taxNum - netNum) > 0.01) {
    throw new Error(
      `net pay does not reconcile: ${grossNum} - ${deductionsNum} - ${taxNum} != ${netNum}`,
    );
  }
  if (Number(pfSlip.employer_contribution) < Number(pfEmployer.amount)) {
    throw new Error('the employer PF contribution is not reported as an employer cost');
  }
  log(
    'Employee PF reduces net pay; employer PF does not',
    `net ${pfSlip.net_amount} reconciles from gross less employee deductions; `
      + `employer contribution ${pfEmployer.amount} sits outside it`,
  );

  // ------------------------------------------- employees' state insurance
  //
  // Every employee so far earns well over the ESI wage ceiling, so none of them is in the
  // scheme — which is correct, and is why ESI has never appeared on a payslip in this
  // journey. Demonstrating it needs someone under the ceiling.
  //
  // Eligibility is derived from the period's gross against the configured ceiling. There is
  // no "ESI eligible" attribute on the employee and none is needed.
  const junior = await api('POST', '/api/employees', {
    companyId: company.id,
    locationId: location.id,
    departmentId: department.id,
    designationId: designation.id,
    firstName: 'Meera',
    lastName: 'Nair',
    workEmail: `meera@${SLUG}.example.com`,
    joiningDate: '2025-04-01',
    employmentStatus: 'active',
  });
  await api('PUT', `/api/employees/${junior.id}/tax-profile`, {
    taxRegime: 'new',
    pfApplicable: false,
    esiApplicable: true,
    effectiveFrom: '2025-04-01',
  });

  const juniorStructure = await api('POST', '/api/compensation/structures', {
    name: 'Support',
    effectiveFrom: '2025-04-01',
    components: [
      { componentId: components.BASIC, sequenceNo: 1, percentage: 100, percentageOfCode: 'BASE' },
    ],
  });
  await api('POST', '/api/compensation/assignments', {
    employeeId: junior.id,
    salaryStructureId: juniorStructure.id,
    annualCtc: 240_000,
    baseAmount: 20_000,
    effectiveFrom: '2025-04-01',
  });
  log('Created an ESI-covered employee', 'INR 20,000/month, under the wage ceiling');

  const esiPeriod = await api('POST', '/api/payroll-periods', {
    companyId: company.id,
    name: 'May 2026',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    payDate: '2026-06-01',
  });
  const esiRun = await api('POST', '/api/payroll-runs', {
    payrollPeriodId: esiPeriod.id,
    employeeIds: [junior.id],
    allowIncompleteAttendance: true,
    incompleteAttendanceReason: 'Demonstration run over a historical period the scheduler has not closed',
  });
  await waitFor('the engine to calculate ESI', async () => {
    const detail = await api('GET', `/api/payroll-runs/${esiRun.id}`);
    return detail.status === 'calculated' ? detail : null;
  });
  await api('POST', `/api/payroll-runs/${esiRun.id}/review`);
  await api('POST', `/api/payroll-runs/${esiRun.id}/approve`);
  await api('POST', `/api/payroll-runs/${esiRun.id}/finalize`);

  const esiList = await api('GET', `/api/payslips?employeeId=${junior.id}`);
  const esiHeader = esiList.payslips.find((p) => p.period_start === '2026-05-01');
  if (!esiHeader) throw new Error('no May payslip for the ESI-covered employee');
  const esiSlip = await api('GET', `/api/payslips/${esiHeader.id}`);

  const esiEmployee = (esiSlip.components ?? []).find((c) => c.code === 'ESI_EMPLOYEE');
  const esiEmployer = (esiSlip.components ?? []).find((c) => c.code === 'ESI_EMPLOYER');
  if (!esiEmployee) throw new Error('no employee ESI line on the payslip');
  if (!esiEmployer) throw new Error('no employer ESI line on the payslip');

  const e = esiEmployee.calculation_detail ?? {};
  if (e.eligible !== true) throw new Error(`ESI eligibility is ${e.eligible}, expected true`);
  if (!e.rule_id || !e.rule_version) {
    throw new Error('the ESI line does not identify the rule that produced it');
  }
  log(
    'ESI eligibility derived from the wage',
    `gross ${e.wage_basis} against ceiling ${e.gross_wage_ceiling} -> covered `
      + `(rule v${e.rule_version}, ${e.rule_source})`,
  );
  log(
    'ESI contributions computed from versioned rates',
    `employee ${e.employee_rate} -> ${e.employee_contribution}, `
      + `employer ${e.employer_rate} -> ${e.employer_contribution}`,
  );

  // The separation: the employee's contribution comes out of their pay, the employer's does
  // not. Checked by reconciling the payslip rather than by reading the line types.
  const esiGross = Number(esiSlip.gross_amount);
  const esiDeductions = Number(esiSlip.deduction_amount);
  const esiTax = Number(esiSlip.tax_amount);
  const esiNet = Number(esiSlip.net_amount);
  if (Math.abs(esiGross - esiDeductions - esiTax - esiNet) > 0.01) {
    throw new Error(
      `net pay does not reconcile: ${esiGross} - ${esiDeductions} - ${esiTax} != ${esiNet}`,
    );
  }
  if (Number(esiSlip.employer_contribution) < Number(esiEmployer.amount)) {
    throw new Error('the employer ESI contribution is not reported as an employer cost');
  }
  log(
    'Employee ESI reduces net pay; employer ESI does not',
    `net ${esiSlip.net_amount} reconciles from gross less employee deductions; `
      + `employer contribution ${esiEmployer.amount} sits outside it`,
  );

  // The high earner in the same tenant is outside the scheme, on the same rule. Eligibility
  // is a fact about the wage, not about the configuration.
  const highEarnerSlip = await api('GET', `/api/payslips/${augHeader.id}`);
  if ((highEarnerSlip.components ?? []).some((c) => c.code === 'ESI_EMPLOYEE')) {
    throw new Error('an employee over the ESI ceiling should have no ESI line');
  }
  log(
    'An employee over the ceiling is outside the scheme',
    'the August payslip carries no ESI line at all',
  );

  await expectRejection(
    'a finalized ESI run cannot be recalculated',
    () => api('POST', `/api/payroll-runs/${esiRun.id}/recalculate`),
  );

  // ------------------------------------------------------------------- reporting
  //
  // PRD s.22: core reports, asynchronous and exportable. Nothing here is computed by the
  // API — the request returns 202 with a run id, the worker generates it, and the client
  // asks the run how it went (s.25).
  const reportTypes = await api('GET', '/api/reports/types');
  const offered = reportTypes.types.map((t) => t.type).sort();
  log('Report catalogue', offered.join(', '));
  if (offered.includes('attrition') || offered.includes('hiring')) {
    throw new Error('attrition and hiring have no defined semantics and must not be offered');
  }

  const headcountRun = await api('POST', '/api/reports', {
    reportType: 'headcount',
    parameters: { dateFrom: PERIOD_START, dateTo: PERIOD_END },
  });
  if (headcountRun.status !== 'pending') {
    throw new Error(`a report request must come back pending, got ${headcountRun.status}`);
  }
  log('Headcount report requested', `run ${headcountRun.id} accepted as pending, not calculated inline`);

  const finishedHeadcount = await waitFor('the worker to generate the headcount report', async () => {
    const run = await api('GET', `/api/reports/${headcountRun.id}`);
    return run.status === 'completed' || run.status === 'failed' ? run : null;
  });
  if (finishedHeadcount.status !== 'completed') {
    throw new Error(`headcount report failed: ${finishedHeadcount.failure_reason}`);
  }
  log(
    'Headcount generated asynchronously',
    `${finishedHeadcount.row_count} row(s), export document ${finishedHeadcount.document_id}`,
  );

  const headcountLink = await api('GET', `/api/reports/${headcountRun.id}/download-url`);
  // The local storage driver signs a path on this API; S3 returns an absolute URL. Resolve
  // against the base either way, so the journey exercises the same download either driver
  // hands back.
  const headcountCsv = await (await fetch(new URL(headcountLink.url, BASE))).text();
  if (!headcountCsv.startsWith('"department","location","employment_status","headcount"')) {
    throw new Error(`unexpected export header: ${headcountCsv.slice(0, 80)}`);
  }
  log('Export downloaded through a presigned link', `${headcountLink.filename}, ${headcountCsv.split('\r\n').length - 2} data row(s)`);

  // The sensitive one. Same endpoint, different permission — this admin holds payroll.read,
  // so it is allowed, and the export is marked sensitive on the document itself.
  const costRun = await api('POST', '/api/reports', {
    reportType: 'payroll_cost',
    parameters: { dateFrom: PERIOD_START, dateTo: PERIOD_END },
  });
  const finishedCost = await waitFor('the worker to generate the payroll cost report', async () => {
    const run = await api('GET', `/api/reports/${costRun.id}`);
    return run.status === 'completed' || run.status === 'failed' ? run : null;
  });
  if (finishedCost.status !== 'completed') {
    throw new Error(`payroll cost report failed: ${finishedCost.failure_reason}`);
  }
  const costLink = await api('GET', `/api/reports/${costRun.id}/download-url`);
  const costCsv = await (await fetch(new URL(costLink.url, BASE))).text();
  const costRows = costCsv.trim().split('\r\n').slice(1);
  log('Payroll cost generated from finalized slips', `${finishedCost.row_count} row(s)`);

  // The June run is the one this journey finalized, so the export has to contain its gross.
  if (!costRows.some((row) => row.includes('96666.66'))) {
    throw new Error(`payroll cost export does not contain the finalized June gross: ${costCsv}`);
  }
  log(
    'Report reconciles with the finalized payroll',
    'the June gross in the export is the gross on the payslip',
  );

  // The boundary that matters: the same endpoint, a caller without the permission the report
  // needs. A manager can run headcount and cannot touch the audit trail, and the difference
  // is decided by the report type rather than by reaching the endpoint at all (PRD s.7).
  const reportingAdminToken = token;
  token = (await signIn(`priya@${SLUG}.example.com`, 'ManagerPassword123')).access_token;

  const managerTypes = await api('GET', '/api/reports/types');
  const managerOffered = managerTypes.types.map((t) => t.type);
  if (managerOffered.includes('audit_activity') || managerOffered.includes('payroll_cost')) {
    throw new Error('the catalogue must not advertise reports this caller cannot run');
  }

  await expectRejection(
    'a report the caller has no permission for is refused',
    () => api('POST', '/api/reports', {
      reportType: 'audit_activity',
      parameters: { dateFrom: PERIOD_START, dateTo: PERIOD_END },
    }),
  );
  await expectRejection(
    'and the sensitive payroll cost export is refused for the same reason',
    () => api('POST', '/api/reports', {
      reportType: 'payroll_cost',
      parameters: { dateFrom: PERIOD_START, dateTo: PERIOD_END },
    }),
  );
  await expectRejection(
    'an already-generated sensitive export cannot be downloaded either',
    () => api('GET', `/api/reports/${costRun.id}/download-url`),
  );
  log(
    'Reports are gated on the permission protecting their data',
    `manager may run ${managerOffered.join(', ')} and nothing else`,
  );

  token = reportingAdminToken;

  // A link can be re-issued as often as it is asked for; each one is short-lived and each
  // issuance is audited, so "who downloaded the payroll cost export" stays answerable.
  const secondLink = await api('GET', `/api/reports/${costRun.id}/download-url`);
  if (!secondLink.url) throw new Error('a completed report must stay downloadable');
  const downloadAudit = await api('GET', '/api/audit?action=report.downloaded&limit=50');
  if (!downloadAudit.entries.some((e) => e.entity_id === costRun.id)) {
    throw new Error('downloading a sensitive export must be audited');
  }
  log('Every export download is audited', `${downloadAudit.entries.length} report.downloaded entries`);

  const requestedAudit = await api('GET', '/api/audit?action=report.requested&limit=50');
  if (!requestedAudit.entries.some((e) => e.entity_id === headcountRun.id)) {
    throw new Error('requesting a report must be audited');
  }

  // A report that has not finished has nothing to hand over, and says so rather than
  // returning a link to an object that does not exist.
  const pendingRun = await api('POST', '/api/reports', {
    reportType: 'leave',
    parameters: { dateFrom: PERIOD_START, dateTo: PERIOD_END },
  });
  if (pendingRun.status === 'pending') {
    await expectRejection(
      'a report that has not finished cannot be downloaded',
      () => api('GET', `/api/reports/${pendingRun.id}/download-url`),
    );
  }

  await expectRejection(
    'a report id that does not exist is not found',
    () => api('GET', '/api/reports/11111111-1111-4111-8111-111111111111'),
  );

  // No cap on how wide a report may be: the PRD does not define one, no other date-filtered
  // endpoint here has one, and the export size is bounded in the generator instead.
  const wideRun = await api('POST', '/api/reports', {
    reportType: 'attendance',
    parameters: { dateFrom: '2020-01-01', dateTo: '2026-12-31' },
  });
  log('A multi-year range is accepted', `${wideRun.report_type} over 2020-2026 queued as ${wideRun.status}`);

  await expectRejection(
    'a reversed date range is refused rather than reported as empty',
    () => api('POST', '/api/reports', {
      reportType: 'headcount',
      parameters: { dateFrom: PERIOD_END, dateTo: PERIOD_START },
    }),
  );



  // Expense types, so the expense journey is demoable at all. Without at least one type
  // there is nothing to claim against and the whole domain is unreachable from the UI.
  // Without a definition for expense_claim the engine has nothing to route to, and a
  // submitted claim goes straight to finance review — correct, but it means the approval
  // journey cannot be demonstrated.
  await api('PUT', '/api/workflows/expense_claim', {
    name: 'Expense approval',
    steps: [{ sequence: 1, approver: 'reporting_manager', sla_hours: 24 }],
  });
  log('Configured expense approval', 'reporting manager, 24h SLA');

  const expenseTypes = [];
  for (const spec of [
    { code: 'TRAVEL', name: 'Travel', receiptRequired: true, requiresBusinessPurpose: true },
    { code: 'MEALS', name: 'Meals', receiptRequired: true, requiresBusinessPurpose: false },
    { code: 'SUPPLIES', name: 'Office supplies', receiptRequired: false, requiresBusinessPurpose: false },
  ]) {
    expenseTypes.push(await api('POST', '/api/expense-types', spec));
  }
  log('Created expense types', expenseTypes.map((t) => t.code ?? t.name).join(', '));

  // -------------------------------------------------------------------- demo actors
  //
  // Every role that the product supports gets a real, login-capable account, because a demo
  // that can only be driven by one user is not a demo of an HRMS — the whole point is that
  // work moves between people.
  //
  // Two things are deliberate here:
  //
  //   * These are created through /api/users like any other account. Nothing is inserted
  //     into a table directly, so what the demo shows is what the product actually does.
  //   * Roles holding a sensitive permission (payroll, compensation, bank, tax, audit) still
  //     require a second factor — ADR-012 — and that is NOT bypassed for the demo. Each such
  //     account is enrolled the way a real administrator would be on first sign-in, and the
  //     secret is printed so an operator can add it to an authenticator app and sign in as
  //     that person in a browser.
  //
  // The password is shared across demo accounts on purpose: this provisions a throwaway
  // demonstration tenant, and one fewer thing to remember on stage is worth more than
  // per-account secrets that are printed on the same screen anyway.

  const DEMO_PASSWORD = 'DemoPassword123';
  const actors = [];

  async function demoActor(label, roleNames, person) {
    const email = `${label.toLowerCase().replace(/[^a-z]+/g, '')}@${SLUG}.example.com`;
    await api('POST', '/api/users', {
      email,
      fullName: person.fullName,
      password: DEMO_PASSWORD,
      roleNames,
      ...(person.employeeId ? { employeeId: person.employeeId } : {}),
    });

    // Sign in exactly as a person would, enrolling a second factor if the role demands one.
    const keep = token;
    let secret = null;
    const outcome = await api('POST', '/api/auth/login', { slug: SLUG, email, password: DEMO_PASSWORD });

    // Whether this sign-in actually produced a session is the proof that the account works,
    // so it is recorded here rather than by logging in a second time. The login route is
    // rate-limited (correctly), and a verification pass that re-authenticated every actor
    // would trip that limiter on the demo's own accounts.
    let session = outcome.access_token ? outcome : null;
    if (outcome.mfa_required) {
      const offer = await api('POST', '/api/auth/mfa/enroll', { challenge_token: outcome.challenge_token });
      secret = offer.secret;
      session = await api('POST', '/api/auth/mfa/confirm', {
        challenge_token: outcome.challenge_token,
        code: totp(offer.secret),
      });
    }
    token = keep;

    if (!session?.access_token) throw new Error(`${label} could not obtain a session`);

    // And that the session carries the permissions the role is supposed to grant.
    const identity = await (async () => {
      const held = token;
      token = session.access_token;
      try {
        return await api('GET', '/api/auth/me');
      } finally {
        token = held;
      }
    })();

    actors.push({
      label, email, secret,
      roles: roleNames.join(', '),
      permissions: identity.permissions.length,
    });
    return email;
  }

  await demoActor('HR', ['HR Admin'], { fullName: 'Kavya Iyer' });
  await demoActor('Payroll', ['Payroll Admin'], { fullName: 'Rahul Desai' });
  await demoActor('Finance', ['Finance'], { fullName: 'Sneha Patil' });
  // Not 'Admin': the journey's own bootstrap administrator already owns admin@<slug>.
  await demoActor('TenantAdmin', ['Tenant Admin'], { fullName: 'Vikram Rao' });
  // The employee the rest of this journey is about, so the demo can be driven from both
  // sides of every approval rather than only the approver's.
  await demoActor('Employee', ['Employee'], { fullName: 'Arun Kumar', employeeId: employee.id });

  log(
    'Provisioned demo actors',
    `${actors.length} login-capable roles; ${actors.filter((a) => a.secret).length} required a second factor`,
  );

  log(
    'Every demo actor authenticated and carries its role',
    actors.map((a) => `${a.label} ${a.permissions}p`).join(', '),
  );


  console.log('\nInvariant checks');
  await expectRejection(
    'a finalized payroll run cannot be recalculated',
    () => api('POST', `/api/payroll-runs/${run.id}/recalculate`),
  );
  await expectRejection(
    'a second regular run for the same period is refused',
    () => api('POST', '/api/payroll-runs', { payrollPeriodId: period.id }),
  );
  await expectRejection(
    'leave beyond the available balance is refused',
    () =>
      api('POST', '/api/leave/applications', {
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: '2026-09-01',
        endDate: '2026-11-30',
      }),
  );


  console.log('\nDemo accounts');
  console.log(`  tenant slug   ${SLUG}`);
  console.log(`  password      ${DEMO_PASSWORD}`);
  for (const actor of actors) {
    console.log(`  ${actor.label.padEnd(9)} ${actor.email}`);
    console.log(`  ${''.padEnd(9)} roles: ${actor.roles}  ·  ${actor.permissions} permissions${actor.secret ? `  ·  authenticator secret: ${actor.secret}` : '  ·  no second factor required'}`);
  }
  console.log(`  ${'Manager'.padEnd(9)} priya@${SLUG}.example.com  ·  roles: Manager  ·  no second factor required`);

  console.log(`\nJourney complete: ${steps.length} steps.\n`);
}

async function expectRejection(description, fn) {
  try {
    await fn();
    throw new Error(`EXPECTED REJECTION: ${description} — but it succeeded`);
  } catch (err) {
    if (String(err.message).startsWith('EXPECTED REJECTION')) throw err;
    console.log(`  ok  ${description}`);
  }
}

main().catch((err) => {
  console.error(`\nFAILED at step ${steps.length + 1}: ${err.message}\n`);
  process.exit(1);
});
