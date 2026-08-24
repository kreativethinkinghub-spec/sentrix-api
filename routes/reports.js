import { Router } from 'express';
import { query, queryOne } from '../db/client.js';

const router = Router();
const fmt = (n, cur = 'ZAR') => (cur === 'ZAR' ? 'R' : cur + ' ') + Math.round(Number(n) || 0).toLocaleString('en-ZA');

// Generate a board pack for a project from live data. Deterministic narrative
// (no external key needed); an LLM layer can later enrich the `narrative` field.
router.get('/:projectId/board-pack', async (req, res) => {
  try {
    const pid = req.params.projectId;
    const project = await queryOne('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [pid, req.user.org_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [tasks, risks, milestones, budget, changes, cyber, insights] = await Promise.all([
      query('SELECT status FROM tasks WHERE project_id=$1', [pid]),
      query("SELECT title, rag_status, status, probability, impact FROM risks WHERE project_id=$1 AND status IN ('open','escalated')", [pid]),
      query('SELECT title, status, due_date FROM milestones WHERE project_id=$1 ORDER BY due_date', [pid]),
      query('SELECT planned_amount, actual_amount FROM budget_items WHERE project_id=$1', [pid]),
      query("SELECT reference, title, status, cost_impact, schedule_impact_days FROM change_requests WHERE project_id=$1 AND status IN ('submitted','under-review','approved')", [pid]),
      queryOne('SELECT posture_score, ot_exposure, has_ot FROM cyber_assessments WHERE project_id=$1', [pid]),
      query("SELECT type, content FROM ai_insights WHERE project_id=$1", [pid]),
    ]);

    const cur = project.currency || 'ZAR';
    const BAC = budget.reduce((s, b) => s + (+b.planned_amount || 0), 0) || +project.budget_total || 0;
    const AC = budget.reduce((s, b) => s + (+b.actual_amount || 0), 0) || +project.budget_spent || 0;
    const done = tasks.filter(t => t.status === 'done').length;
    const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const CPI = AC > 0 ? +(BAC * (pct / 100) / AC).toFixed(2) : null;
    const today = new Date();
    const overdue = milestones.filter(m => m.status !== 'completed' && m.due_date && new Date(m.due_date) < today);
    const redRisks = risks.filter(r => r.rag_status === 'red');
    const pendingChanges = changes.filter(c => ['submitted', 'under-review'].includes(c.status));

    const rag = (redRisks.length || overdue.length >= 2 || (CPI && CPI < 0.9)) ? 'RED'
              : (overdue.length || pendingChanges.length || (CPI && CPI < 1)) ? 'AMBER' : 'GREEN';

    const highlights = [
      `${pct}% of tasks complete (${done}/${tasks.length}).`,
      `Budget: ${fmt(AC, cur)} spent of ${fmt(BAC, cur)} (${BAC ? Math.round(AC / BAC * 100) : 0}%).${CPI ? ' CPI ' + CPI + (CPI < 1 ? ' — over-running.' : ' — on/under cost.') : ''}`,
      cyber?.posture_score != null ? `Cyber posture ${cyber.posture_score}/100${cyber.has_ot ? ' (OT in scope, exposure ' + cyber.ot_exposure + ')' : ''}.` : null,
    ].filter(Boolean);

    const attention = [
      ...redRisks.slice(0, 5).map(r => `Red risk: ${r.title}`),
      ...overdue.slice(0, 5).map(m => `Overdue milestone: ${m.title}`),
      ...pendingChanges.slice(0, 5).map(c => `Change awaiting decision: ${c.reference} ${c.title}`),
      cyber && cyber.posture_score != null && cyber.posture_score < 40 ? `Cyber posture critical (${cyber.posture_score}/100).` : null,
    ].filter(Boolean);

    const narrative =
      `${project.name} is currently rated ${rag}. ` +
      `Delivery is at ${pct}% with ${fmt(AC, cur)} of ${fmt(BAC, cur)} committed${CPI ? ` (CPI ${CPI})` : ''}. ` +
      (redRisks.length ? `${redRisks.length} red risk(s) are open. ` : 'No red risks are open. ') +
      (overdue.length ? `${overdue.length} milestone(s) are overdue. ` : 'Milestones are on schedule. ') +
      (pendingChanges.length ? `${pendingChanges.length} change request(s) await a board decision. ` : '') +
      (attention.length ? `Priority actions this period: ${attention.slice(0, 3).join('; ')}.` : 'No escalations this period.');

    res.json({
      generated_at: today.toISOString(),
      project: { name: project.name, client: project.client_name, sector: project.sector, province: project.province, status: project.status },
      rag_status: rag,
      narrative,
      sections: {
        summary: highlights,
        attention,
        schedule: { total: milestones.length, overdue: overdue.length, upcoming: milestones.filter(m => m.status !== 'completed').slice(0, 5) },
        cost: { BAC, AC, CPI, utilisation: BAC ? Math.round(AC / BAC * 100) : 0 },
        risk: { open: risks.length, red: redRisks.length },
        change: { pending: pendingChanges.length, approved: changes.filter(c => c.status === 'approved').length },
        cyber: cyber || null,
        ai_insights: insights.map(i => ({ type: i.type, content: i.content })),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
