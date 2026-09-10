import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_MANAGE = requireRole('admin', 'director', 'pm', 'finance');
const CAN_APPROVE = requireRole('admin', 'director', 'finance');

/* ── Contract Variance Engine ──────────────────────────────────────
   Tracks committed value (original) against current value (with all
   approved variations), producing a per-contract delta and an
   aggregate project-level scope-creep view. */

// List contracts on a project with computed variance
router.get('/contracts/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.*,
              ct.name AS contractor_name,
              c.original_value AS committed_value,
              c.current_value AS current_committed,
              (c.current_value - c.original_value) AS variance_value,
              CASE WHEN c.original_value > 0
                   THEN ROUND(((c.current_value - c.original_value) / c.original_value * 100)::numeric, 2)
                   ELSE 0 END AS variance_pct,
              (SELECT COUNT(*)::int FROM contract_variations WHERE contract_id = c.id) AS variation_count,
              (SELECT COUNT(*)::int FROM contract_variations WHERE contract_id = c.id AND status = 'approved') AS approved_count
       FROM contracts c
       LEFT JOIN contractors ct ON c.contractor_id = ct.id
       WHERE c.project_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create contract
router.post('/contracts', CAN_MANAGE, async (req, res) => {
  try {
    const { project_id, contractor_id, contract_ref, title, original_value, original_end_date } = req.body;
    if (!project_id || !contract_ref || !title || original_value == null) {
      return res.status(400).json({ error: 'project_id, contract_ref, title, original_value required' });
    }
    const row = await queryOne(
      `INSERT INTO contracts (project_id, contractor_id, contract_ref, title, original_value, original_end_date, current_value, current_end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$5,$6) RETURNING *`,
      [project_id, contractor_id || null, contract_ref, title, original_value, original_end_date || null]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raise a variation (proposed)
router.post('/', CAN_MANAGE, async (req, res) => {
  try {
    const { contract_id, change_request_id, variation_ref, description, cost_impact, time_impact_days, reason } = req.body;
    if (!contract_id || !description) return res.status(400).json({ error: 'contract_id and description required' });
    const count = await queryOne('SELECT COUNT(*)::int AS c FROM contract_variations WHERE contract_id = $1', [contract_id]);
    const vref = variation_ref || 'V-' + String((count?.c || 0) + 1).padStart(3, '0');
    const row = await queryOne(
      `INSERT INTO contract_variations (contract_id, change_request_id, variation_ref, description, cost_impact, time_impact_days, reason, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6,0),$7,$8) RETURNING *`,
      [contract_id, change_request_id || null, vref, description, cost_impact, time_impact_days, reason || null, req.user.id]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List variations for a contract
router.get('/contract/:contractId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT v.*, u.full_name AS created_by_name, a.full_name AS approved_by_name, cr.reference AS change_ref
       FROM contract_variations v
       LEFT JOIN users u ON v.created_by = u.id
       LEFT JOIN users a ON v.approved_by = a.id
       LEFT JOIN change_requests cr ON v.change_request_id = cr.id
       WHERE v.contract_id = $1
       ORDER BY v.created_at DESC`,
      [req.params.contractId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve a variation — updates the contract's current_value and end_date
router.post('/:id/approve', CAN_APPROVE, async (req, res) => {
  try {
    const v = await queryOne('SELECT * FROM contract_variations WHERE id = $1', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'variation not found' });
    if (v.status !== 'proposed') return res.status(400).json({ error: 'only proposed variations can be approved' });

    const approved = await queryOne(
      `UPDATE contract_variations SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    // Roll the cost/time impact into the parent contract
    await queryOne(
      `UPDATE contracts
       SET current_value = COALESCE(current_value, original_value) + $1,
           current_end_date = COALESCE(current_end_date, original_end_date) + ($2 || ' days')::interval,
           updated_at = NOW()
       WHERE id = $3 RETURNING id`,
      [Number(v.cost_impact) || 0, Number(v.time_impact_days) || 0, v.contract_id]
    );
    res.json(approved);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/reject', CAN_APPROVE, async (req, res) => {
  try {
    const row = await queryOne(
      `UPDATE contract_variations SET status = 'rejected', approved_by = $1, approved_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'variation not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Project-level scope-creep summary
router.get('/summary/:projectId', async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT
         COUNT(c.id)::int AS contracts,
         COALESCE(SUM(c.original_value), 0)::numeric AS original_total,
         COALESCE(SUM(c.current_value), 0)::numeric AS current_total,
         COALESCE(SUM(c.current_value - c.original_value), 0)::numeric AS variance_total,
         (SELECT COUNT(*)::int FROM contract_variations v
          JOIN contracts c2 ON v.contract_id = c2.id
          WHERE c2.project_id = $1 AND v.status = 'proposed') AS pending_variations,
         (SELECT COUNT(*)::int FROM contract_variations v
          JOIN contracts c2 ON v.contract_id = c2.id
          WHERE c2.project_id = $1 AND v.status = 'approved') AS approved_variations
       FROM contracts c WHERE c.project_id = $1`,
      [req.params.projectId]
    );
    const orig = Number(row.original_total) || 0;
    row.variance_pct = orig > 0 ? Math.round((Number(row.variance_total) / orig) * 100 * 100) / 100 : 0;
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
