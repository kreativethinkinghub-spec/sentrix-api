import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_WRITE = requireRole('admin', 'director', 'finance');

// List budget line items for a project, plus a rollup summary
router.get('/:projectId', async (req, res) => {
  try {
    const items = await query(
      'SELECT * FROM budget_items WHERE project_id = $1 ORDER BY category, created_at',
      [req.params.projectId]
    );
    const summary = items.reduce((acc, it) => {
      acc.planned += Number(it.planned_amount) || 0;
      acc.actual  += Number(it.actual_amount) || 0;
      return acc;
    }, { planned: 0, actual: 0 });
    summary.variance = summary.planned - summary.actual;
    summary.utilisation = summary.planned ? Math.round((summary.actual / summary.planned) * 100) : 0;
    res.json({ items, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', CAN_WRITE, async (req, res) => {
  try {
    const { project_id, category, description, planned_amount, actual_amount, currency, period } = req.body;
    if (!project_id || !category || planned_amount === undefined) {
      return res.status(400).json({ error: 'project_id, category and planned_amount are required' });
    }
    const row = await queryOne(
      `INSERT INTO budget_items (project_id, category, description, planned_amount, actual_amount, currency, period)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [project_id, category, description, planned_amount, actual_amount || 0, currency || 'ZAR', period]
    );
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', CAN_WRITE, async (req, res) => {
  try {
    const allowed = ['category','description','planned_amount','actual_amount','currency','period'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) { sets.push(`${key} = $${i++}`); vals.push(req.body[key]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id);
    const row = await queryOne(`UPDATE budget_items SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Budget item not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', CAN_WRITE, async (req, res) => {
  try {
    await queryOne('DELETE FROM budget_items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
