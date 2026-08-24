import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_WRITE = requireRole('admin', 'director', 'pm');

// List milestones for a project
router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM milestones WHERE project_id = $1 ORDER BY sort_order, due_date',
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', CAN_WRITE, async (req, res) => {
  try {
    const { project_id, title, description, due_date, status, phase, sort_order } = req.body;
    if (!project_id || !title || !due_date) {
      return res.status(400).json({ error: 'project_id, title and due_date are required' });
    }
    const row = await queryOne(
      `INSERT INTO milestones (project_id, title, description, due_date, status, phase, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [project_id, title, description, due_date, status || 'pending', phase, sort_order || 0]
    );
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', CAN_WRITE, async (req, res) => {
  try {
    const allowed = ['title','description','due_date','status','phase','sort_order'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) { sets.push(`${key} = $${i++}`); vals.push(req.body[key]); }
    }
    if (req.body.status === 'completed') { sets.push(`completed_at = $${i++}`); vals.push(new Date().toISOString()); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id);
    const row = await queryOne(`UPDATE milestones SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Milestone not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', CAN_WRITE, async (req, res) => {
  try {
    await queryOne('DELETE FROM milestones WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
