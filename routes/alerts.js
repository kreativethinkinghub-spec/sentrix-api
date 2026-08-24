import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireOrgAdmin } from '../middleware/auth.js';
import * as alerts from '../db/alerts.js';

const router = Router();

// Is alerting configured, and who in the org can receive?
router.get('/', async (req, res) => {
  try {
    const recipients = await query(
      `SELECT full_name, role, phone FROM users
       WHERE org_id = $1 AND is_active = TRUE AND alerts_optin = TRUE AND phone IS NOT NULL`,
      [req.user.org_id]
    );
    res.json({ configured: alerts.hasKeys(), recipients: recipients.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The caller sets their own alert phone number + opt-in.
router.post('/me', async (req, res) => {
  try {
    const { phone, alerts_optin } = req.body;
    const row = await queryOne(
      `UPDATE users SET phone = COALESCE($2, phone), alerts_optin = COALESCE($3, alerts_optin)
       WHERE id = $1 RETURNING full_name, phone, alerts_optin`,
      [req.user.id, phone ?? null, alerts_optin ?? null]
    );
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Org admin: send a test alert to a number (or to opted-in org members).
router.post('/test', requireOrgAdmin, async (req, res) => {
  try {
    if (!alerts.hasKeys()) return res.status(503).json({ error: 'Alerts not configured — set Twilio env vars' });
    const { to, channel } = req.body;
    const body = 'SENTRIX test alert — notifications are working.';
    if (to) { const r = await alerts.broadcast([to], body, channel || 'sms'); return res.json(r); }
    const rows = await query(
      `SELECT phone FROM users WHERE org_id=$1 AND is_active=TRUE AND alerts_optin=TRUE AND phone IS NOT NULL`,
      [req.user.org_id]
    );
    const r = await alerts.broadcast(rows.map(x => x.phone), body, channel || 'sms');
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
