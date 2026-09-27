import { randomUUID } from 'node:crypto';

/**
 * Transactional email.
 *
 * Templates are rendered here rather than in the domain modules so that a copy change is
 * not a business-logic change. The console driver keeps local development free of AWS
 * credentials while exercising the same code path.
 */

export type MailInput = {
  to: string;
  subject: string;
  template: string;
  data: Record<string, unknown>;
};

/** Line separator for templates built as an array of lines. */
const LINE = String.fromCharCode(10);

const TEMPLATES: Record<string, (data: Record<string, unknown>) => string> = {
  'employee.welcome': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour employee record has been created. ` +
    `Your onboarding tasks are available in the employee portal.`,

  'leave.awaiting_approval': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\n${d.employee_name} has requested leave from ` +
    `${d.start_date} to ${d.end_date} and is waiting for your decision.`,

  'leave.approved': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour leave request has been approved.`,

  'leave.rejected': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour leave request was not approved. ` +
    `Speak to your manager if you need more detail.`,

  'auth.password_reset': (d) =>
    [
      `Hello ${d.first_name ?? 'there'},`,
      '',
      'Use this token to set a new password. It expires in 30 minutes and can be used once:',
      '',
      String(d.token),
      '',
      'If you did not ask for this you can ignore it - your password has not changed.',
    ].join(LINE),

  'auth.verify_email': (d) =>
    [
      `Hello ${d.first_name ?? 'there'},`,
      '',
      'Confirm your email address with this token:',
      '',
      String(d.token),
    ].join(LINE),

  'onboarding.task_assigned': (d) =>
    [
      `Hello ${d.first_name ?? 'there'},`,
      '',
      `You have ${d.task_count} onboarding task(s) for ${d.joiner_name ?? 'a new joiner'}.`,
    ].join(LINE),

  'payroll.payslip_available': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour payslip ${d.slip_number} is now available ` +
    `in the employee portal. Payslips are only accessible to you and authorised payroll staff.`,

  // PRD s.19. None of these carries an amount: s.18.8 keeps salary, tax and bank detail out
  // of email bodies and previews, and every one of them is a click away behind authorization.
  'leave.cancelled': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\n${d.employee_name ?? 'An employee'} has cancelled a ` +
    `leave request that was waiting for your decision. No action is needed.`,

  'expense.awaiting_approval': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\n${d.employee_name} has submitted expense claim ` +
    `${d.claim_number} and is waiting for your decision.`,

  'expense.approved': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour expense claim ${d.claim_number} has been approved ` +
    `and passed to finance. The amount is shown on the claim in the employee portal.`,

  'expense.rejected': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour expense claim ${d.claim_number} was not approved. ` +
    `The reason is recorded on the claim in the employee portal.`,

  'expense.paid': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour expense claim ${d.claim_number} has been reimbursed. ` +
    `The details are on the claim in the employee portal.`,

  'attendance.correction_decided': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nYour attendance correction for ${d.attendance_date} ` +
    `has been reviewed. The outcome is in the employee portal.`,

  'onboarding.completed': (d) =>
    `Hello ${d.first_name ?? 'there'},\n\nAll of your onboarding tasks are complete. Welcome!`,
};

function render(template: string, data: Record<string, unknown>): string {
  const renderer = TEMPLATES[template];
  if (!renderer) {
    // An unknown template must not lose the notification; send a minimal message and
    // make the gap visible in the body rather than throwing it away.
    return `Notification: ${template}\n\n${JSON.stringify(data, null, 2)}`;
  }
  return renderer(data);
}

async function sendViaConsole(input: MailInput): Promise<string> {
  const id = `console-${randomUUID()}`;
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'email (console driver)',
      to: input.to,
      subject: input.subject,
      template: input.template,
      message_id: id,
    }),
  );
  return id;
}

async function sendViaSes(input: MailInput): Promise<string> {
  const mod = await import('@aws-sdk/client-ses' as string);
  const client = new mod.SESClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });
  const result = await client.send(
    new mod.SendEmailCommand({
      Source: process.env.SES_FROM_ADDRESS,
      Destination: { ToAddresses: [input.to] },
      Message: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: render(input.template, input.data), Charset: 'UTF-8' } },
      },
    }),
  );
  return result.MessageId ?? randomUUID();
}

export async function sendMail(input: MailInput): Promise<string> {
  return (process.env.MAILER_DRIVER ?? 'console') === 'ses'
    ? sendViaSes(input)
    : sendViaConsole(input);
}
