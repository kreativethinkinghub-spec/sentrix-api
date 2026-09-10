import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_MANAGE = requireRole('admin', 'director', 'pm', 'finance');

/* ── Supply Chain Intelligence ─────────────────────────────────────
   Procurement pipeline + supplier risk scoring. Risk is computed
   from contractor rating history + certification currency +
   concentration (spend %) — deterministic, auditable. */

async function computeSupplierRisk(contractorId, orgId) {
  if (!contractorId) return { risk_score: null };
  const c = await queryOne('SELECT * FROM contractors WHERE id = $1', [contractorId]);
  if (!c) return { risk_score: null };

  const ratings = await queryOne(
    `SELECT AVG(rating)::numeric AS avg_rating, COUNT(*)::int AS count
     FROM contractor_ratings WHERE contractor_id = $1`,
    [contractorId]
  );

  // Concentration: what % of this org's spend goes to this contractor
  const spend = await queryOne(
    `SELECT COALESCE(SUM(awarded_value), 0)::numeric AS this_supplier,
            (SELECT COALESCE(SUM(awarded_value), 0)::numeric FROM procurement_items pi
             JOIN projects p ON pi.project_id = p.id WHERE p.org_id = $2) AS total_spend
     FROM procurement_items pi
     JOIN projects p ON pi.project_id = p.id
     WHERE pi.contractor_id = $1 AND p.org_id = $2`,
    [contractorId, orgId]
  );
  const concentration = Number(spend?.total_spend) > 0
    ? Number(spend.this_supplier) / Number(spend.total_spend)
    : 0;

  // Cert currency: expired = risk
  const now = Date.now();
  let certRisk = 0;
  if (c.cidb_expiry && new Date(c.cidb_expiry).getTime() < now) certRisk += 0.3;
  if (c.bbbee_expiry && new Date(c.bbbee_expiry).getTime() < now) certRisk += 0.2;

  const perfRisk = ratings?.avg_rating != null ? Math.max(0, (5 - Number(ratings.avg_rating)) / 5) : 0.4;

  const risk = Math.min(1, perfRisk * 0.5 + certRisk + Math.min(0.3, concentration * 0.6));

  return {
    risk_score: Math.round(risk * 100) / 100,
    verdict: risk >= 0.65 ? 'high' : risk >= 0.35 ? 'medium' : 'low',
    factors: {
      performance_risk: Math.round(perfRisk * 100) / 100,
      cert_expiry_risk: Math.round(certRisk * 100) / 100,
      concentration_pct: Math.round(concentration * 100),
      rating_avg: ratings?.avg_rating != null ? Number(ratings.avg_rating) : null,
      rating_count: ratings?.count || 0,
    },
  };
}

// Pipeline view — every procurement item on a project
router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT pi.*, c.name AS contractor_name, c.bbbee_level, c.cidb_grade
       FROM procurement_items pi
       LEFT JOIN contractors c ON pi.contractor_id = c.id
       WHERE pi.project_id = $1
       ORDER BY pi.planned_award_date NULLS LAST, pi.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create procurement item
router.post('/', CAN_MANAGE, async (req, res) => {
  try {
    const { project_id, description, category, estimated_value, contractor_id, stage, planned_award_date, bbbee_spend_pct, local_content_pct } = req.body;
    if (!project_id || !description) return res.status(400).json({ error: 'project_id and description required' });
    const row = await queryOne(
      `INSERT INTO procurement_items (project_id, description, category, estimated_value, contractor_id, stage, planned_award_date, bbbee_spend_pct, local_content_pct)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'planned'),$7,$8,$9) RETURNING *`,
      [project_id, description, category || null, estimated_value || null, contractor_id || null, stage, planned_award_date || null, bbbee_spend_pct || null, local_content_pct || null]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', CAN_MANAGE, async (req, res) => {
  try {
    const allowed = ['description', 'category', 'estimated_value', 'awarded_value', 'contractor_id', 'stage', 'planned_award_date', 'actual_award_date', 'bbbee_spend_pct', 'local_content_pct'];
    const sets = [], vals = []; let i = 1;
    for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(req.body[k]); }
    if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    const row = await queryOne(`UPDATE procurement_items SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'procurement item not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supplier risk register — every contractor with a computed risk score
router.get('/risk/register', async (req, res) => {
  try {
    const contractors = await query(
      `SELECT c.id, c.name, c.bbbee_level, c.cidb_grade, c.cidb_expiry, c.bbbee_expiry
       FROM contractors c WHERE c.org_id = $1
       ORDER BY c.name`,
      [req.user.org_id]
    );
    const enriched = [];
    for (const c of contractors) {
      const r = await computeSupplierRisk(c.id, req.user.org_id);
      enriched.push({ ...c, ...r });
    }
    enriched.sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0));
    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Single supplier risk detail
router.get('/risk/:contractorId', async (req, res) => {
  try {
    const c = await queryOne('SELECT * FROM contractors WHERE id = $1', [req.params.contractorId]);
    if (!c) return res.status(404).json({ error: 'contractor not found' });
    const r = await computeSupplierRisk(c.id, req.user.org_id);
    res.json({ ...c, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pipeline summary — total planned vs awarded, by stage
router.get('/:projectId/summary', async (req, res) => {
  try {
    const rows = await query(
      `SELECT stage,
              COUNT(*)::int AS items,
              COALESCE(SUM(estimated_value), 0)::numeric AS planned_value,
              COALESCE(SUM(awarded_value), 0)::numeric AS awarded_value
       FROM procurement_items WHERE project_id = $1
       GROUP BY stage
       ORDER BY stage`,
      [req.params.projectId]
    );
    res.json({ project_id: req.params.projectId, by_stage: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', CAN_MANAGE, async (req, res) => {
  try {
    const row = await queryOne('DELETE FROM procurement_items WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'procurement item not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
