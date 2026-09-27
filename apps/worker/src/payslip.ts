import type { TenantTx } from '@hrms/api/src/infra/db/pool.ts';

/**
 * Payslip PDF generation.
 *
 * Writes a minimal, self-contained PDF with no third-party dependency. A payslip is a
 * table of numbers the employee must be able to read and keep, and a pinned rendering
 * library is a supply-chain surface for a document containing salary data.
 *
 * The figures come from the finalized slip, never recomputed — regenerating the document
 * must never be able to change what it says.
 */

type SlipRow = {
  slip_number: string;
  employee_code: string;
  employee_name: string;
  company_name: string;
  period_start: string;
  period_end: string;
  total_days: string;
  payable_days: string;
  lop_days: string;
  gross_amount: string;
  deduction_amount: string;
  tax_amount: string;
  employer_contribution: string;
  net_amount: string;
  currency: string;
  calculation_version: string;
};

type ComponentRow = {
  code: string;
  name: string;
  component_type: string;
  amount: string;
};

export async function renderPayslipPdf(tx: TenantTx, slipId: string): Promise<Buffer> {
  const header = await tx.query<SlipRow>(
    `SELECT s.slip_number, e.employee_code,
            e.first_name || ' ' || e.last_name AS employee_name,
            c.name AS company_name,
            to_char(s.period_start, 'DD Mon YYYY') AS period_start,
            to_char(s.period_end, 'DD Mon YYYY') AS period_end,
            s.total_days::text, s.payable_days::text, s.lop_days::text,
            s.gross_amount::text, s.deduction_amount::text, s.tax_amount::text,
            s.employer_contribution::text, s.net_amount::text, s.currency, s.calculation_version
       FROM payroll.salary_slip s
       JOIN core.employee e ON e.id = s.employee_id
       JOIN core.company c ON c.id = e.company_id
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [tx.tenantId, slipId],
  );

  const slip = header.rows[0];
  if (!slip) throw new Error(`salary slip ${slipId} not found`);

  const components = await tx.query<ComponentRow>(
    `SELECT component_code_snapshot AS code, component_name_snapshot AS name,
            component_type, amount::text
       FROM payroll.salary_slip_component
      WHERE tenant_id = $1 AND salary_slip_id = $2
      ORDER BY component_type, display_order`,
    [tx.tenantId, slipId],
  );

  const earnings = components.rows.filter((c) => c.component_type === 'earning');
  const deductions = components.rows.filter((c) => c.component_type === 'deduction');
  const employer = components.rows.filter((c) => c.component_type === 'employer_contribution');

  const lines: string[] = [
    slip.company_name,
    `Payslip ${slip.slip_number}`,
    `Period: ${slip.period_start} to ${slip.period_end}`,
    '',
    `Employee: ${slip.employee_name} (${slip.employee_code})`,
    `Payable days: ${slip.payable_days} of ${slip.total_days}   LOP: ${slip.lop_days}`,
    '',
    'EARNINGS',
    ...earnings.map((c) => `  ${pad(c.name, 34)}${align(c.amount, slip.currency)}`),
    `  ${pad('Gross earnings', 34)}${align(slip.gross_amount, slip.currency)}`,
    '',
    'DEDUCTIONS',
    ...deductions.map((c) => `  ${pad(c.name, 34)}${align(c.amount, slip.currency)}`),
    `  ${pad('Total deductions', 34)}${align(
      String(Number(slip.deduction_amount) + Number(slip.tax_amount)),
      slip.currency,
    )}`,
    '',
    `NET PAY: ${slip.currency} ${slip.net_amount}`,
    '',
  ];

  if (employer.length > 0) {
    lines.push(
      'EMPLOYER CONTRIBUTIONS (not deducted from net pay)',
      ...employer.map((c) => `  ${pad(c.name, 34)}${align(c.amount, slip.currency)}`),
      '',
    );
  }

  lines.push(
    'This is a computer-generated payslip and does not require a signature.',
    `Calculation version: ${slip.calculation_version}`,
  );

  return buildPdf(lines);
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width, ' ');
}

function align(amount: string, currency: string): string {
  return `${currency} ${Number(amount).toFixed(2)}`.padStart(16, ' ');
}

/** Escapes the three characters that are structural inside a PDF string literal. */
function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Builds a single-page PDF 1.4 document with a monospaced font.
 *
 * Byte offsets in the cross-reference table must be exact, so the objects are assembled
 * into a buffer first and each offset measured rather than estimated.
 */
function buildPdf(lines: string[]): Buffer {
  const fontSize = 10;
  const leading = 14;
  const top = 780;

  const content =
    `BT\n/F1 ${fontSize} Tf\n${leading} TL\n50 ${top} Td\n` +
    lines.map((line) => `(${escapePdf(line)}) Tj T*`).join('\n') +
    `\nET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
