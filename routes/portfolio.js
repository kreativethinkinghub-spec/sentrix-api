import { Router } from 'express';
import { query, queryOne } from '../db/client.js';

const router = Router();

// Portfolio-wide rollup across every project in the org — the executive view.
router.get('/', async (req, res) => {
  try {
    const org = req.user.org_id;
    const [projects, budgetAgg, riskAgg, taskAgg, milestoneAgg] = await Promise.all([
      query('SELECT id, name, status, sector, province, budget_total, budget_spent, target_end_date FROM projects WHERE org_id = $1', [org]),
      queryOne(`SELECT COALESCE(SUM(budget_total),0) AS total, COALESCE(SUM(budget_spent),0) AS spent FROM projects WHERE org_id = $1`, [org]),
      query(`SELECT r.rag_status, COUNT(*)::int AS n FROM risks r JOIN projects p ON r.project_id=p.id WHERE p.org_id=$1 AND r.status IN ('open','escalated') GROUP BY r.rag_status`, [org]),
      queryOne(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status='done')::int AS done, COUNT(*) FILTER (WHERE t.status='blocked')::int AS blocked FROM tasks t JOIN projects p ON t.project_id=p.id WHERE p.org_id=$1`, [org]),
      queryOne(`SELECT COUNT(*) FILTER (WHERE m.status!='completed' AND m.due_date < CURRENT_DATE)::int AS overdue FROM milestones m JOIN projects p ON m.project_id=p.id WHERE p.org_id=$1`, [org]),
    ]);

    const risk = { red: 0, amber: 0, green: 0 };
    riskAgg.forEach(r => { risk[r.rag_status] = r.n; });

    // Per-project health flag (red if it has open red risks or overdue milestones).
    const redByProject = await query(
      `SELECT p.id, COUNT(*) FILTER (WHERE r.rag_status='red' AND r.status IN ('open','escalated'))::int AS red_risks,
              COUNT(DISTINCT m.id) FILTER (WHERE m.status!='completed' AND m.due_date < CURRENT_DATE)::int AS overdue_ms
       FROM projects p
       LEFT JOIN risks r ON r.project_id=p.id
       LEFT JOIN milestones m ON m.project_id=p.id
       WHERE p.org_id=$1 GROUP BY p.id`, [org]
    );
    const flags = Object.fromEntries(redByProject.map(x => [x.id, x]));
    const withHealth = projects.map(p => {
      const f = flags[p.id] || { red_risks: 0, overdue_ms: 0 };
      const health = (f.red_risks > 0 || f.overdue_ms >= 2) ? 'red' : (f.overdue_ms > 0 ? 'amber' : 'green');
      const utilisation = p.budget_total ? Math.round((Number(p.budget_spent) || 0) / Number(p.budget_total) * 100) : 0;
      return { id: p.id, name: p.name, status: p.status, sector: p.sector, province: p.province, health, utilisation, red_risks: f.red_risks, overdue_milestones: f.overdue_ms };
    });

    res.json({
      projects_total: projects.length,
      by_health: {
        red: withHealth.filter(p => p.health === 'red').length,
        amber: withHealth.filter(p => p.health === 'amber').length,
        green: withHealth.filter(p => p.health === 'green').length,
      },
      budget: {
        total: Number(budgetAgg.total), spent: Number(budgetAgg.spent),
        utilisation: budgetAgg.total > 0 ? Math.round(Number(budgetAgg.spent) / Number(budgetAgg.total) * 100) : 0,
      },
      risk, tasks: taskAgg, overdue_milestones: milestoneAgg.overdue,
      projects: withHealth.sort((a, b) => ({ red: 0, amber: 1, green: 2 }[a.health] - { red: 0, amber: 1, green: 2 }[b.health])),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
