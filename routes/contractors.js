import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_RATE = requireRole('admin', 'director', 'pm', 'risk');

// Org contractor directory with rolled-up performance scores.
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.*,
              COUNT(r.id)::int AS ratings,
              ROUND(AVG((r.delivery_score + r.quality_score + r.safety_score + r.cost_score) / 4.0)::numeric, 1) AS overall_score,
              ROUND(AVG(r.delivery_score)::numeric,1) AS delivery,
              ROUND(AVG(r.quality_score)::numeric,1)  AS quality,
              ROUND(AVG(r.safety_score)::numeric,1)   AS safety,
              ROUND(AVG(r.cost_score)::numeric,1)     AS cost
       FROM contractors c
       LEFT JOIN contractor_ratings r ON r.contractor_id = c.id
       WHERE c.org_id = $1
       GROUP BY c.id
       ORDER BY overall_score DESC NULLS LAST, c.name`,
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', CAN_RATE, async (req, res) => {
  try {
    const { name, sector, registration_no, cidb_grade, bbbee_level, contact_email } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const row = await queryOne(
      `INSERT INTO contractors (org_id, name, sector, registration_no, cidb_grade, bbbee_level, contact_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.org_id, name, sector, registration_no, cidb_grade, bbbee_level, contact_email]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Contractor detail + full rating history.
router.get('/:id', async (req, res) => {
  try {
    const c = await queryOne('SELECT * FROM contractors WHERE id = $1 AND org_id = $2', [req.params.id, req.user.org_id]);
    if (!c) return res.status(404).json({ error: 'Contractor not found' });
    const ratings = await query(
      `SELECT r.*, p.name AS project_name, u.full_name AS rated_name,
              (r.delivery_score + r.quality_score + r.safety_score + r.cost_score)/4.0 AS overall
       FROM contractor_ratings r
       LEFT JOIN projects p ON r.project_id = p.id
       LEFT JOIN users u ON r.rated_by = u.id
       WHERE r.contractor_id = $1 ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    res.json({ contractor: c, ratings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rate a contractor on a project (0–100 on delivery / quality / safety / cost).
router.post('/:id/rate', CAN_RATE, async (req, res) => {
  try {
    const c = await queryOne('SELECT id FROM contractors WHERE id = $1 AND org_id = $2', [req.params.id, req.user.org_id]);
    if (!c) return res.status(404).json({ error: 'Contractor not found' });
    const { project_id, delivery_score, quality_score, safety_score, cost_score, notes } = req.body;
    const clamp = v => Math.max(0, Math.min(100, parseInt(v) || 0));
    const row = await queryOne(
      `INSERT INTO contractor_ratings (contractor_id, project_id, delivery_score, quality_score, safety_score, cost_score, notes, rated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, project_id || null, clamp(delivery_score), clamp(quality_score), clamp(safety_score), clamp(cost_score), notes || null, req.user.id]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
