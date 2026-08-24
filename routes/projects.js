import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_WRITE = requireRole('admin', 'director', 'pm');

router.get('/', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM projects WHERE org_id = $1 ORDER BY created_at DESC',
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await queryOne(
      'SELECT * FROM projects WHERE id = $1 AND org_id = $2',
      [req.params.id, req.user.org_id]
    );
    if (!row) return res.status(404).json({ error: 'Project not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', CAN_WRITE, async (req, res) => {
  try {
    const { name, code, description, methodology, sector, province, budget_total, currency, start_date, target_end_date, programme_name, client_name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const row = await queryOne(
      `INSERT INTO projects (org_id, name, code, description, methodology, sector, province, budget_total, currency, start_date, target_end_date, programme_name, client_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.org_id, name, code, description, methodology || 'hybrid', sector, province, budget_total, currency || 'ZAR', start_date, target_end_date, programme_name, client_name, req.user.id]
    );

    await queryOne(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [row.id, req.user.id, 'owner']
    );

    await queryOne(
      `INSERT INTO audit_log (org_id, project_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,$3,'project.created','project',$2,$4)`,
      [req.user.org_id, row.id, req.user.id, JSON.stringify({ name })]
    );

    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', CAN_WRITE, async (req, res) => {
  try {
    const allowed = ['name','code','description','status','methodology','sector','province','budget_total','budget_spent','currency','start_date','target_end_date','actual_end_date','programme_name','client_name'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = $${i++}`);
        vals.push(req.body[key]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id, req.user.org_id);
    const row = await queryOne(
      `UPDATE projects SET ${sets.join(', ')} WHERE id = $${i++} AND org_id = $${i} RETURNING *`,
      vals
    );

    if (!row) return res.status(404).json({ error: 'Project not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/dashboard', async (req, res) => {
  try {
    const pid = req.params.id;
    const org = req.user.org_id;

    const [project, tasks, risks, milestones, budget] = await Promise.all([
      queryOne('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [pid, org]),
      query('SELECT * FROM tasks WHERE project_id = $1 ORDER BY sort_order', [pid]),
      query('SELECT * FROM risks WHERE project_id = $1 ORDER BY created_at DESC', [pid]),
      query('SELECT * FROM milestones WHERE project_id = $1 ORDER BY due_date', [pid]),
      query('SELECT * FROM budget_items WHERE project_id = $1', [pid])
    ]);

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const taskStats = {
      total: tasks.length,
      todo: tasks.filter(t => t.status === 'todo').length,
      in_progress: tasks.filter(t => t.status === 'in-progress').length,
      done: tasks.filter(t => t.status === 'done').length,
      blocked: tasks.filter(t => t.status === 'blocked').length
    };

    const riskStats = {
      total: risks.length,
      red: risks.filter(r => r.rag_status === 'red').length,
      amber: risks.filter(r => r.rag_status === 'amber').length,
      green: risks.filter(r => r.rag_status === 'green').length
    };

    res.json({ project, tasks, taskStats, risks, riskStats, milestones, budget });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
