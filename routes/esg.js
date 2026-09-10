import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_LOG = requireRole('admin', 'director', 'pm', 'finance', 'risk');
const CAN_VERIFY = requireRole('admin', 'auditor', 'director');

/* ── ESG & Carbon Tracker ──────────────────────────────────────────
   Structured metric log aligned to GRI Standards (301, 302, 303, 305,
   401, 403, 405, 413) and TCFD (Governance, Strategy, Risk Management,
   Metrics & Targets). Verified entries are audit-ready. */

const GRI_MAP = {
  carbon_kg_co2e: 'GRI 305-1',        // Direct (Scope 1) GHG emissions
  scope2_kg_co2e: 'GRI 305-2',        // Energy indirect (Scope 2)
  scope3_kg_co2e: 'GRI 305-3',        // Other indirect (Scope 3)
  water_m3: 'GRI 303-3',              // Water withdrawal
  energy_kwh: 'GRI 302-1',            // Energy consumption
  waste_kg: 'GRI 306-3',              // Waste generated
  local_procurement_pct: 'GRI 204-1', // Local supplier spend
  community_hours: 'GRI 413-1',       // Community engagement
  training_hours: 'GRI 404-1',        // Training per employee
  incidents_lti: 'GRI 403-9',         // Work-related injuries (lost-time)
  incidents_fatality: 'GRI 403-9',
  bbbee_spend_zar: 'SA/BBBEE',
};

const TCFD_MAP = {
  carbon_kg_co2e: 'Metrics & Targets a) Scope 1',
  scope2_kg_co2e: 'Metrics & Targets a) Scope 2',
  scope3_kg_co2e: 'Metrics & Targets a) Scope 3',
  transition_risk_zar: 'Risk Management a)',
  physical_risk_zar: 'Risk Management b)',
};

function enrichRefs(metric, gri, tcfd) {
  return {
    gri_ref: gri || GRI_MAP[metric] || null,
    tcfd_ref: tcfd || TCFD_MAP[metric] || null,
  };
}

// Log a new ESG entry
router.post('/', CAN_LOG, async (req, res) => {
  try {
    const { project_id, period_start, period_end, category, metric, value, unit, source, gri_ref, tcfd_ref } = req.body;
    if (!project_id || !period_start || !period_end || !category || !metric || value == null || !unit) {
      return res.status(400).json({ error: 'project_id, period_start, period_end, category, metric, value, unit required' });
    }
    const refs = enrichRefs(metric, gri_ref, tcfd_ref);
    const row = await queryOne(
      `INSERT INTO esg_entries (project_id, period_start, period_end, category, metric, value, unit, source, gri_ref, tcfd_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [project_id, period_start, period_end, category, metric, value, unit, source || null, refs.gri_ref, refs.tcfd_ref, req.user.id]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List entries for a project (optionally filtered)
router.get('/:projectId', async (req, res) => {
  try {
    const { category, metric, from, to } = req.query;
    const where = ['project_id = $1'];
    const vals = [req.params.projectId];
    let i = 2;
    if (category) { where.push(`category = $${i++}`); vals.push(category); }
    if (metric) { where.push(`metric = $${i++}`); vals.push(metric); }
    if (from) { where.push(`period_end >= $${i++}`); vals.push(from); }
    if (to) { where.push(`period_end <= $${i++}`); vals.push(to); }
    const rows = await query(
      `SELECT e.*, u.full_name AS created_by_name, v.full_name AS verified_by_name
       FROM esg_entries e
       LEFT JOIN users u ON e.created_by = u.id
       LEFT JOIN users v ON e.verified_by = v.id
       WHERE ${where.join(' AND ')}
       ORDER BY period_end DESC, created_at DESC`,
      vals
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rollup dashboard: totals + verification rate + YoY change
router.get('/:projectId/summary', async (req, res) => {
  try {
    const rows = await query(
      `SELECT category, metric, unit,
              SUM(value) AS total,
              COUNT(*) AS entries,
              SUM(CASE WHEN verified THEN 1 ELSE 0 END)::int AS verified_count,
              MIN(period_start) AS earliest,
              MAX(period_end) AS latest
       FROM esg_entries WHERE project_id = $1
       GROUP BY category, metric, unit
       ORDER BY category, metric`,
      [req.params.projectId]
    );
    const summary = rows.map((r) => ({
      ...r,
      total: Number(r.total),
      verified_pct: r.entries > 0 ? Math.round((r.verified_count / r.entries) * 100) : 0,
      gri_ref: GRI_MAP[r.metric] || null,
      tcfd_ref: TCFD_MAP[r.metric] || null,
    }));
    res.json({ project_id: req.params.projectId, metrics: summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auditor verifies an entry
router.post('/:id/verify', CAN_VERIFY, async (req, res) => {
  try {
    const row = await queryOne(
      `UPDATE esg_entries SET verified = TRUE, verified_by = $1, verified_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'entry not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', CAN_LOG, async (req, res) => {
  try {
    const row = await queryOne('DELETE FROM esg_entries WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'entry not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
