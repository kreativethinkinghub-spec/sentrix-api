import { Router } from 'express';
import { query, queryOne } from '../db/client.js';

const router = Router();

// Earned-Value Management + cost-of-delay for a project, computed from live data.
router.get('/:projectId/evm', async (req, res) => {
  try {
    const pid = req.params.projectId;
    const project = await queryOne('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [pid, req.user.org_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [budget, tasks, milestones] = await Promise.all([
      query('SELECT planned_amount, actual_amount FROM budget_items WHERE project_id = $1', [pid]),
      query('SELECT status FROM tasks WHERE project_id = $1', [pid]),
      query('SELECT status, due_date FROM milestones WHERE project_id = $1', [pid]),
    ]);

    // Budget At Completion (prefer budget lines, fall back to project total).
    const plannedFromLines = budget.reduce((s, b) => s + (Number(b.planned_amount) || 0), 0);
    const BAC = plannedFromLines || Number(project.budget_total) || 0;
    const AC  = budget.reduce((s, b) => s + (Number(b.actual_amount) || 0), 0) || Number(project.budget_spent) || 0;

    // % complete from task completion.
    const done = tasks.filter(t => t.status === 'done').length;
    const pctComplete = tasks.length ? done / tasks.length : 0;

    // Planned % from schedule elapsed (start → target end).
    const today = new Date();
    const start = project.start_date ? new Date(project.start_date) : null;
    const end = project.target_end_date ? new Date(project.target_end_date) : null;
    let plannedPct = pctComplete;
    let durationDays = 0;
    if (start && end && end > start) {
      durationDays = (end - start) / 86400000;
      plannedPct = Math.max(0, Math.min(1, (today - start) / (end - start)));
    }

    const EV = BAC * pctComplete;            // earned value
    const PV = BAC * plannedPct;             // planned value
    const CPI = AC > 0 ? EV / AC : null;     // cost performance
    const SPI = PV > 0 ? EV / PV : null;     // schedule performance
    const EAC = CPI ? BAC / CPI : (AC + (BAC - EV));   // estimate at completion
    const VAC = BAC - EAC;                    // variance at completion (negative = overrun)

    // Cost of delay: R/day burn proxy × overdue milestones' lateness.
    const dailyValue = durationDays > 0 ? BAC / durationDays : 0;
    const overdue = milestones.filter(m => m.status !== 'completed' && m.due_date && new Date(m.due_date) < today);
    const overdueDays = overdue.reduce((s, m) => s + Math.round((today - new Date(m.due_date)) / 86400000), 0);
    const costOfDelay = Math.round(dailyValue * overdueDays);

    const round = n => (n == null ? null : Math.round(n * 100) / 100);
    res.json({
      currency: project.currency || 'ZAR',
      BAC: round(BAC), AC: round(AC), EV: round(EV), PV: round(PV),
      CPI: round(CPI), SPI: round(SPI), EAC: round(EAC), VAC: round(VAC),
      pct_complete: Math.round(pctComplete * 100), planned_pct: Math.round(plannedPct * 100),
      cost_of_delay: costOfDelay, daily_value: Math.round(dailyValue), overdue_milestones: overdue.length, overdue_days: overdueDays,
      verdict: CPI == null ? 'insufficient data'
             : CPI >= 1 && (SPI == null || SPI >= 0.95) ? 'on track'
             : CPI < 0.9 || (SPI != null && SPI < 0.85) ? 'critical' : 'watch'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
