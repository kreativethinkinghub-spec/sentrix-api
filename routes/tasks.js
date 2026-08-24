import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_WRITE = requireRole('admin', 'director', 'pm', 'tech');

router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT t.*, u.full_name AS assigned_name, u.email AS assigned_email
       FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.project_id = $1 ORDER BY t.sort_order`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', CAN_WRITE, async (req, res) => {
  try {
    const { project_id, title, description, status, priority, assigned_to, due_date } = req.body;
    if (!project_id || !title) return res.status(400).json({ error: 'project_id and title are required' });

    const row = await queryOne(
      `INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [project_id, title, description, status || 'todo', priority || 'medium', assigned_to, due_date, req.user.id]
    );

    if (assigned_to) {
      await queryOne(
        `INSERT INTO notifications (user_id, project_id, type, title, body, action_url)
         VALUES ($1,$2,'task','New task assigned',$3,$4)`,
        [assigned_to, project_id, title, `/dashboard?project=${project_id}&view=tasks`]
      );
    }

    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', CAN_WRITE, async (req, res) => {
  try {
    const allowed = ['title','description','status','priority','assigned_to','due_date','sort_order','start_date','duration_days'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = $${i++}`);
        vals.push(req.body[key]);
      }
    }
    if (req.body.status === 'done') {
      sets.push(`completed_at = $${i++}`);
      vals.push(new Date().toISOString());
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id);
    const row = await queryOne(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Task not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', CAN_WRITE, async (req, res) => {
  try {
    await queryOne('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
