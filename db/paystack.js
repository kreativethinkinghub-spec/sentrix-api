// Paystack integration (ZAR). Activates only when PAYSTACK_SECRET_KEY is set.
// Never hard-code keys. Test keys start sk_test_/pk_test_, live keys sk_live_/pk_live_.
import crypto from 'crypto';

export function hasKeys() { return !!process.env.PAYSTACK_SECRET_KEY; }
export function publicKey() { return process.env.PAYSTACK_PUBLIC_KEY || ''; }

// Org subscription tiers (ZAR). Matches the site pricing.
// Sovereign is custom (government/SOE) — no self-serve checkout.
export const TIERS = {
  professional: { name: 'Professional', monthly: 1100, annual: 13200, blurb: 'Single PMO' },
  growth:       { name: 'Growth',       monthly: 3300, annual: 39600, blurb: 'Multi-Project PMO' },
  command:      { name: 'Command',      monthly: 9200, annual: 110400, blurb: 'Full Command Centre' },
  sovereign:    { name: 'Sovereign',    custom: true, blurb: 'Government & SOEs — contact sales' },
};

export function priceFor(tier, cycle) {
  const t = TIERS[tier];
  if (!t || t.custom) return null;
  return cycle === 'annual' ? t.annual : t.monthly;
}

// Initialize a transaction; returns { authorization_url, reference } to redirect the payer to.
export async function initTransaction({ email, amount, reference, callback_url, metadata }) {
  if (!hasKeys()) throw new Error('Paystack not configured');
  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, amount: Math.round(amount * 100), currency: 'ZAR', reference, callback_url, metadata }),
  });
  const j = await r.json();
  if (!r.ok || !j.status) throw new Error('Paystack init: ' + (j.message || r.status));
  return j.data; // { authorization_url, access_code, reference }
}

// Verify a transaction by reference (used on callback + as a webhook backup).
export async function verify(reference) {
  if (!hasKeys()) throw new Error('Paystack not configured');
  const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
    headers: { authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY },
  });
  const j = await r.json();
  if (!r.ok || !j.status) throw new Error('Paystack verify: ' + (j.message || r.status));
  return j.data; // { status: 'success', amount, ... }
}

// Validate a webhook signature (Paystack signs the raw body with HMAC-SHA512 of the secret key).
export function validSignature(rawBody, signature) {
  if (!hasKeys() || !signature) return false;
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature)); } catch { return false; }
}

export function ref(prefix) { return prefix + '_' + crypto.randomBytes(8).toString('hex'); }
