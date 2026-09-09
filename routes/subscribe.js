import { Router } from 'express';
import { queryOne } from '../db/client.js';
import { notifySignup } from '../db/mailer.js';

const router = Router();

const VALID_PLANS = new Set(['pro', 'growth', 'command', 'sovereign']);
const VALID_BILLING = new Set(['monthly', 'annual']);

function clean(s, max = 500) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.slice(0, max);
}

function validEmail(s) {
  if (!s || typeof s !== 'string') return false;
  // conservative check — length + one @ + a dot in the domain half
  if (s.length > 254) return false;
  const i = s.indexOf('@');
  if (i < 1 || i > 64) return false;
  const domain = s.slice(i + 1);
  return domain.includes('.') && domain.length <= 253;
}

function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  return (typeof xf === 'string' ? xf.split(',')[0].trim() : '') || req.ip || null;
}

/* ── POST /api/subscribe/trial ─────────────────────────────────────
   Public. Captures a 14-day-trial signup for Professional or Growth.
   Command tier does not accept trial signups (front-end redirects to invoice). */
router.post('/trial', async (req, res, next) => {
  try {
    const b = req.body || {};
    const plan = clean(b.plan, 20)?.toLowerCase() || 'pro';
    const billing = clean(b.billing, 10)?.toLowerCase() || 'monthly';
    const email = clean(b.email, 254)?.toLowerCase();
    const company = clean(b.company, 200);

    if (!VALID_PLANS.has(plan)) return res.status(400).json({ error: 'invalid plan' });
    if (plan === 'command' || plan === 'sovereign') return res.status(400).json({ error: 'plan requires invoice — use /api/subscribe/invoice' });
    if (!VALID_BILLING.has(billing)) return res.status(400).json({ error: 'invalid billing' });
    if (!validEmail(email)) return res.status(400).json({ error: 'valid email required' });
    if (!company) return res.status(400).json({ error: 'company required' });
    if (b.terms !== 'on' && b.terms !== true && b.terms !== 'true') return res.status(400).json({ error: 'terms must be accepted' });

    const row = await queryOne(
      `INSERT INTO signup_requests
         (kind, plan, billing, email, first_name, last_name, phone, company, role, use_case, source, ip, user_agent, raw)
       VALUES ('trial', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, created_at`,
      [
        plan, billing, email,
        clean(b.firstName, 80), clean(b.lastName, 80),
        clean(b.phone, 40), company, clean(b.role, 80),
        clean(b.use, 2000),
        clean(b.source, 120), ipOf(req), clean(req.headers['user-agent'], 500),
        JSON.stringify(b),
      ]
    );

    // Fire the internal notification but don't block the response on it
    notifySignup({ ...b, kind: 'trial', plan, billing, email, id: row.id }).catch((e) =>
      console.error('[subscribe] notify failed:', e.message)
    );

    return res.status(201).json({
      ok: true,
      id: row.id,
      message: 'Trial request received. Our team will email a login link within 1 business day.',
    });
  } catch (e) {
    // Duplicate rapid-fire submits: swallow into a friendly 201 rather than 500
    if (/duplicate|unique/i.test(e.message)) {
      return res.status(201).json({ ok: true, message: 'Request received.' });
    }
    return next(e);
  }
});

/* ── POST /api/subscribe/invoice ───────────────────────────────────
   Public. Captures a procurement / invoice request for any tier. */
router.post('/invoice', async (req, res, next) => {
  try {
    const b = req.body || {};
    const plan = clean(b.plan, 20)?.toLowerCase() || 'command';
    const billing = clean(b.billing, 10)?.toLowerCase() || 'monthly';
    const email = clean(b.email, 254)?.toLowerCase();
    const company = clean(b.company, 200);
    const orgType = clean(b.orgType, 80);
    const contactName = clean(b.contactName, 160);
    const billingAddress = clean(b.billingAddr, 2000);

    if (!VALID_PLANS.has(plan)) return res.status(400).json({ error: 'invalid plan' });
    if (!VALID_BILLING.has(billing)) return res.status(400).json({ error: 'invalid billing' });
    if (!validEmail(email)) return res.status(400).json({ error: 'valid email required' });
    if (!company) return res.status(400).json({ error: 'company required' });
    if (!orgType) return res.status(400).json({ error: 'organisation type required' });
    if (!contactName) return res.status(400).json({ error: 'contact name required' });
    if (!billingAddress) return res.status(400).json({ error: 'billing address required' });
    if (b.terms !== 'on' && b.terms !== true && b.terms !== 'true') return res.status(400).json({ error: 'terms must be accepted' });

    const usersN = Number(b.users);
    const startDate = clean(b.startDate, 10);

    const row = await queryOne(
      `INSERT INTO signup_requests
         (kind, plan, billing, email, contact_name, contact_title, phone, company, reg_no, vat_no,
          org_type, billing_address, users, start_date, po_ref, notes, cycle, source, ip, user_agent, raw)
       VALUES ('invoice', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id, created_at`,
      [
        plan, billing, email,
        contactName, clean(b.contactTitle, 120),
        clean(b.phone, 40), company,
        clean(b.regNo, 40), clean(b.vatNo, 40),
        orgType, billingAddress,
        Number.isFinite(usersN) && usersN > 0 ? Math.min(usersN, 100000) : null,
        startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null,
        clean(b.poRef, 80), clean(b.notes, 4000),
        clean(b.cycle, 10),
        clean(b.source, 120), ipOf(req), clean(req.headers['user-agent'], 500),
        JSON.stringify(b),
      ]
    );

    notifySignup({ ...b, kind: 'invoice', plan, billing, email, id: row.id }).catch((e) =>
      console.error('[subscribe] notify failed:', e.message)
    );

    return res.status(201).json({
      ok: true,
      id: row.id,
      message: 'Invoice request received. A member of our team will email a pro-forma within 1 business day.',
    });
  } catch (e) {
    if (/duplicate|unique/i.test(e.message)) {
      return res.status(201).json({ ok: true, message: 'Request received.' });
    }
    return next(e);
  }
});

export default router;
