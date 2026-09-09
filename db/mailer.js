// Outbound email via SMTP. Inert until SMTP_HOST / SMTP_USER / SMTP_PASS are set.
// Env:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_SECURE ('true'|'false')
//   SIGNUP_NOTIFY_TO     — where to send new-signup alerts (defaults to enterprise@kth-tech.com)
//   MAIL_FROM            — default From address (defaults to noreply@sentrix-pmo.com)
import nodemailer from 'nodemailer';

const NOTIFY_TO = process.env.SIGNUP_NOTIFY_TO || 'enterprise@kth-tech.com';
const FROM = process.env.MAIL_FROM || 'SENTRIX <noreply@sentrix-pmo.com>';

let cached;
function transport() {
  if (cached !== undefined) return cached;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    cached = null;
    return null;
  }
  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user, pass },
  });
  return cached;
}

export function hasMailer() {
  return transport() !== null;
}

export async function sendMail({ to, subject, text, replyTo }) {
  const t = transport();
  if (!t) return { skipped: true, reason: 'smtp not configured' };
  const info = await t.sendMail({
    from: FROM,
    to,
    subject,
    text,
    replyTo: replyTo || undefined,
  });
  return { messageId: info.messageId };
}

const PLAN_LABEL = { pro: 'Professional', growth: 'Growth', command: 'Command', sovereign: 'Sovereign' };

/* Fires ONE internal alert per signup so the sales team sees it immediately.
   The DB row is the source of truth — this is just a courtesy notification. */
export async function notifySignup(payload) {
  const t = transport();
  if (!t) return { skipped: true };

  const kind = payload.kind === 'invoice' ? 'Invoice request' : 'Trial request';
  const plan = PLAN_LABEL[payload.plan] || payload.plan;
  const cycle = payload.billing || 'monthly';

  const lines = [
    `New SENTRIX ${kind}`,
    '',
    `Plan:       ${plan} (${cycle})`,
    `Company:    ${payload.company || '-'}`,
    `Contact:    ${payload.contactName || [payload.firstName, payload.lastName].filter(Boolean).join(' ') || '-'}`,
    `Email:      ${payload.email || '-'}`,
    `Phone:      ${payload.phone || '-'}`,
  ];

  if (payload.kind === 'invoice') {
    lines.push(
      `Org type:   ${payload.orgType || '-'}`,
      `Reg no:     ${payload.regNo || '-'}`,
      `VAT no:     ${payload.vatNo || '-'}`,
      `Users:      ${payload.users || '-'}`,
      `Start date: ${payload.startDate || '-'}`,
      `PO ref:     ${payload.poRef || '-'}`,
      `Address:    ${payload.billingAddr || '-'}`,
      `Notes:      ${payload.notes || '-'}`
    );
  } else {
    lines.push(
      `Role:       ${payload.role || '-'}`,
      `Use case:   ${payload.use || '-'}`
    );
  }

  lines.push('', `Signup ID:  ${payload.id}`, `Source:     ${payload.source || '-'}`);

  return sendMail({
    to: NOTIFY_TO,
    subject: `[SENTRIX] ${kind} — ${plan} — ${payload.company || payload.email}`,
    text: lines.join('\n'),
    replyTo: payload.email,
  });
}
