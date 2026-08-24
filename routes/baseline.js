import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_BASELINE = requireRole('admin', 'director', 'pm');

// Assemble the current programme state into a snapshot object.
async function snapshotOf(pid) {
  const [project, tasks, milestones, budget] = await Promise.all([
    queryOne('SELECT budget_total, start_date, target_end_date FROM projects WHERE id = $1', [pid]),
    queryOne('SELECT COUNT(*)::int AS n, COALESCE(SUM(duration_days),0)::int AS dur FROM tasks WHERE project_id = $1', [pid]),
    query('SELECT id, title, due_date FROM milestones WHERE project_id = $1', [pid]),
    queryOne('SELECT COALESCE(SUM(planned_amount),0) AS planned FROM budget_items WHERE project_id = $1', [pid]),
  ]);
  return {
    budget_total: Number(project?.budget_total) || 0,
    budget_planned: Number(budget?.planned) || 0,
    start_date: project?.start_date, target_end_date: project?.target_end_date,
    task_count: tasks?.n || 0, total_task_days: tasks?.dur || 0,
    milestone_count: milestones.length,
    milestones: milestones.map(m => ({ id: m.id, title: m.title, due_date: m.due_date })),
  };
}

router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT b.id, b.name, b.type, b.is_current, b.created_at, u.full_name AS created_name
       FROM baselines b LEFT JOIN users u ON b.created_by = u.id
       WHERE b.project_id = $1 ORDER BY b.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Capture a new baseline (sets it current; clears the previous current flag).
router.post('/:projectId', CAN_BASELINE, async (req, res) => {
  try {
    const pid = req.params.projectId;
    const project = await queryOne('SELECT id FROM projects WHERE id = $1 AND org_id = $2', [pid, req.user.org_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const snapshot = await snapshotOf(pid);
    await query('UPDATE baselines SET is_current = FALSE WHERE project_id = $1', [pid]);
    const row = await queryOne(
      `INSERT INTO baselines (project_id, name, type, snapshot, is_current, created_by)
       VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id, name, type, created_at`,
      [pid, req.body.name || ('Baseline ' + new Date().toISOString().slice(0, 10)), req.body.type || 'full', JSON.stringify(snapshot), req.user.id]
    );
    await queryOne(
      `INSERT INTO audit_log (org_id, project_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,$3,'baseline.captured','baseline',$4,$5)`,
      [req.user.org_id, pid, req.user.id, row.id, JSON.stringify({ name: row.name })]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Variance: current state vs the current baseline.
router.get('/:projectId/variance', async (req, res) => {
  try {
    const pid = req.params.projectId;
    const bl = await queryOne('SELECT * FROM baselines WHERE project_id = $1 AND is_current = TRUE', [pid]);
    if (!bl) return res.json({ baselined: false });
    const base = bl.snapshot;
    const now = await snapshotOf(pid);
    const budgetVar = now.budget_total - (base.budget_total || 0);
    // Milestone slippage: compare due dates for milestones present in both.
    const baseById = Object.fromEntries((base.milestones || []).map(m => [m.id, m.due_date]));
    let slipped = 0, totalSlipDays = 0;
    now.milestones.forEach(m => {
      const was = baseById[m.id];
      if (was && m.due_date && new Date(m.due_date) > new Date(was)) {
        slipped++; totalSlipDays += Math.round((new Date(m.due_date) - new Date(was)) / 86400000);
      }
    });
    res.json({
      baselined: true, baseline: { id: bl.id, name: bl.name, captured: bl.created_at },
      budget: { baseline: base.budget_total, current: now.budget_total, variance: budgetVar,
                variance_pct: base.budget_total ? Math.round(budgetVar / base.budget_total * 100) : 0 },
      scope: { baseline_tasks: base.task_count, current_tasks: now.task_count, added: now.task_count - base.task_count },
      schedule: { milestones_slipped: slipped, total_slip_days: totalSlipDays,
                  added_milestones: now.milestone_count - base.milestone_count },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
