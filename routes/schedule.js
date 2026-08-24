import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';
import { computeCPM } from '../db/cpm.js';

const router = Router();
const CAN_EDIT = requireRole('admin', 'director', 'pm', 'tech');

// Critical-path analysis for a project.
router.get('/:projectId/critical-path', async (req, res) => {
  try {
    const pid = req.params.projectId;
    const [tasks, deps] = await Promise.all([
      query('SELECT id, title, status, duration_days FROM tasks WHERE project_id = $1', [pid]),
      query('SELECT d.* FROM task_dependencies d JOIN tasks t ON d.task_id = t.id WHERE t.project_id = $1', [pid]),
    ]);
    if (!tasks.length) return res.json({ project_duration_days: 0, critical_path: [], tasks: [], note: 'No tasks to schedule yet' });
    const cpm = computeCPM(tasks, deps);
    if (cpm.error) return res.status(400).json({ error: cpm.error });
    const titles = Object.fromEntries(tasks.map(t => [t.id, t.title]));
    res.json({
      project_duration_days: cpm.project_duration_days,
      critical_path: cpm.critical_path.map(id => ({ id, title: titles[id] })),
      tasks: cpm.tasks.map(t => ({ ...t, title: titles[t.id] })).sort((a, b) => a.es - b.es),
      dependencies: deps.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add / remove a dependency (predecessor → successor).
router.post('/dependency', CAN_EDIT, async (req, res) => {
  try {
    const { task_id, depends_on_task_id, type } = req.body;
    if (!task_id || !depends_on_task_id) return res.status(400).json({ error: 'task_id and depends_on_task_id are required' });
    if (task_id === depends_on_task_id) return res.status(400).json({ error: 'A task cannot depend on itself' });
    const row = await queryOne(
      `INSERT INTO task_dependencies (task_id, depends_on_task_id, type) VALUES ($1,$2,$3)
       ON CONFLICT (task_id, depends_on_task_id) DO UPDATE SET type = $3 RETURNING *`,
      [task_id, depends_on_task_id, type || 'FS']
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/dependency/:id', CAN_EDIT, async (req, res) => {
  try {
    await queryOne('DELETE FROM task_dependencies WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
