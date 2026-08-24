import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireOrgAdmin } from '../middleware/auth.js';
import * as ps from '../db/paystack.js';

const router = Router();

// Available plans + whether billing is configured (for the pricing UI).
router.get('/plans', (req, res) => {
  res.json({ tiers: ps.TIERS, configured: ps.hasKeys(), public_key: ps.publicKey() });
});

// Current org's subscription + recent payments.
router.get('/', async (req, res) => {
  try {
    const org = await queryOne(
      'SELECT id, name, tier, billing_cycle, is_active FROM organisations WHERE id = $1',
      [req.user.org_id]
    );
    const payments = await query(
      `SELECT reference, tier, billing_cycle, amount, currency, status, created_at, paid_at
       FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.user.org_id]
    );
    res.json({ org, payments, configured: ps.hasKeys() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a subscription — org admin only. Returns a Paystack authorization_url.
router.post('/subscribe', requireOrgAdmin, async (req, res) => {
  try {
    if (!ps.hasKeys()) return res.status(503).json({ error: 'Billing is not configured yet' });
    const { tier, billing_cycle } = req.body;
    const cycle = billing_cycle === 'annual' ? 'annual' : 'monthly';
    const amount = ps.priceFor(tier, cycle);
    if (!amount) return res.status(400).json({ error: 'Invalid tier — Sovereign is contact-sales only' });

    const user = await queryOne('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const reference = ps.ref('sx');
    await queryOne(
      `INSERT INTO payments (org_id, reference, tier, billing_cycle, amount, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [req.user.org_id, reference, tier, cycle, amount]
    );

    const callback_url = (process.env.APP_URL || 'https://sentrix-pmo.com') + '/dashboard.html?billing=return';
    const data = await ps.initTransaction({
      email: user.email, amount, reference, callback_url,
      metadata: { org_id: req.user.org_id, tier, cycle },
    });
    res.json({ authorization_url: data.authorization_url, reference });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify a payment by reference (called on return from Paystack; backs up the webhook).
router.get('/verify', async (req, res) => {
  try {
    const reference = req.query.reference;
    if (!reference) return res.status(400).json({ error: 'reference is required' });
    const data = await ps.verify(reference);
    if (data.status === 'success') await applyPayment(reference, data);
    res.json({ status: data.status, tier: (await queryOne('SELECT tier FROM payments WHERE reference=$1', [reference]))?.tier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Idempotently mark a payment paid and upgrade the org's tier.
async function applyPayment(reference, data) {
  const pay = await queryOne('SELECT * FROM payments WHERE reference = $1', [reference]);
  if (!pay || pay.status === 'success') return;
  await queryOne(
    `UPDATE payments SET status='success', paystack_data=$2, paid_at=NOW() WHERE reference=$1`,
    [reference, JSON.stringify(data)]
  );
  await queryOne(
    `UPDATE organisations SET tier=$2, billing_cycle=$3, is_active=TRUE WHERE id=$1`,
    [pay.org_id, pay.tier, pay.billing_cycle]
  );
  await queryOne(
    `INSERT INTO audit_log (org_id, action, entity_type, details)
     VALUES ($1,'billing.paid','payment',$2)`,
    [pay.org_id, JSON.stringify({ reference, tier: pay.tier, amount: pay.amount })]
  );
}

// Public webhook (no auth) — mounted with express.raw in server.js so the HMAC
// signature is validated against the exact raw body Paystack signed.
export const paystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const raw = req.body; // Buffer (express.raw)
    if (!ps.validSignature(raw, signature)) return res.status(401).send('invalid signature');
    const event = JSON.parse(raw.toString('utf8'));
    if (event.event === 'charge.success') await applyPayment(event.data.reference, event.data);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).send('error');
  }
};

export default router;
