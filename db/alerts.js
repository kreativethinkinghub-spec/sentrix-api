// WhatsApp / SMS dispatch via Twilio. Inert until Twilio creds are set.
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM (e.g. +27...),
//      TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886).
export function hasKeys() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

async function send(from, to, body) {
  if (!hasKeys() || !from || !to) return { skipped: true };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  const form = new URLSearchParams({ From: from, To: to, Body: body });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Twilio: ' + (j.message || r.status));
  return { sid: j.sid, status: j.status };
}

export function sendSMS(to, body) {
  return send(process.env.TWILIO_SMS_FROM, to, body);
}
export function sendWhatsApp(to, body) {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const dest = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  return send(from, dest, body);
}

// Best-effort broadcast to a list of E.164 numbers; never throws to the caller.
export async function broadcast(numbers, body, channel = 'sms') {
  if (!hasKeys()) return { sent: 0, skipped: true };
  let sent = 0;
  for (const n of numbers.filter(Boolean)) {
    try { await (channel === 'whatsapp' ? sendWhatsApp(n, body) : sendSMS(n, body)); sent++; }
    catch { /* skip a bad number, keep going */ }
  }
  return { sent };
}
