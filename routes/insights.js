import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_WRITE = requireRole('admin', 'director', 'pm', 'risk');

// List cached insights for a project (optionally ?type=)
router.get('/:projectId', async (req, res) => {
  try {
    const params = [req.params.projectId];
    let sql = 'SELECT * FROM ai_insights WHERE project_id = $1';
    if (req.query.type) { params.push(req.query.type); sql += ` AND type = $${params.length}`; }
    sql += ' ORDER BY generated_at DESC';
    res.json(await query(sql, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Store an externally-produced insight (e.g. an LLM board-pack)
router.post('/', CAN_WRITE, async (req, res) => {
  try {
    const { project_id, type, content, expires_at } = req.body;
    if (!project_id || !type || !content) {
      return res.status(400).json({ error: 'project_id, type and content are required' });
    }
    const row = await queryOne(
      `INSERT INTO ai_insights (project_id, type, content, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [project_id, type, JSON.stringify(content), expires_at || null]
    );
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate rule-based insights from live project data and cache them.
// Deterministic, no external API key required. An LLM layer can later POST richer
// insights via the endpoint above; this guarantees the surface always has signal.
router.post('/:projectId/generate', CAN_WRITE, async (req, res) => {
  try {
    const pid = req.params.projectId;
    const project = await queryOne('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [pid, req.user.org_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [tasks, risks, milestones, budget] = await Promise.all([
      query('SELECT * FROM tasks WHERE project_id = $1', [pid]),
      query('SELECT * FROM risks WHERE project_id = $1', [pid]),
      query('SELECT * FROM milestones WHERE project_id = $1', [pid]),
      query('SELECT * FROM budget_items WHERE project_id = $1', [pid])
    ]);

    const today = new Date();
    const isPast = d => d && new Date(d) < today;

    // ── Delivery forecast ──────────────────────────────────────────
    const doneTasks = tasks.filter(t => t.status === 'done').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;
    const completion = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
    const overdueMs = milestones.filter(m => m.status !== 'completed' && isPast(m.due_date)).length;
    let deliveryConfidence = 'on-track';
    if (overdueMs > 0 || blocked > 2) deliveryConfidence = 'at-risk';
    if (overdueMs >= 2 || (tasks.length > 5 && completion < 25)) deliveryConfidence = 'critical';

    // ── Risk prediction ────────────────────────────────────────────
    const redRisks = risks.filter(r => r.rag_status === 'red').length;
    const openRisks = risks.filter(r => r.status === 'open' || r.status === 'escalated').length;
    const highExposure = risks.filter(r =>
      ['high','very-high'].includes(r.probability) && ['high','very-high'].includes(r.impact)).length;
    let riskLevel = redRisks >= 3 || highExposure >= 2 ? 'elevated' : redRisks || highExposure ? 'watch' : 'stable';

    // ── Budget forecast ────────────────────────────────────────────
    const planned = budget.reduce((a, b) => a + (Number(b.planned_amount) || 0), 0);
    const actual  = budget.reduce((a, b) => a + (Number(b.actual_amount) || 0), 0);
    const utilisation = planned ? Math.round((actual / planned) * 100) : 0;
    const overrun = actual > planned;

    const insights = [
      { type: 'delivery-forecast', content: {
        headline: `Delivery ${deliveryConfidence}`,
        completion_pct: completion,
        blocked_tasks: blocked,
        overdue_milestones: overdueMs,
        note: `${doneTasks}/${tasks.length} tasks complete. ${overdueMs} milestone(s) overdue, ${blocked} task(s) blocked.`
      }},
      { type: 'risk-prediction', content: {
        headline: `Risk posture: ${riskLevel}`,
        red_risks: redRisks,
        open_risks: openRisks,
        high_exposure: highExposure,
        note: highExposure
          ? `${highExposure} risk(s) at high probability & high impact — prioritise mitigation this week.`
          : 'No high/high risks currently logged.'
      }},
      { type: 'budget-forecast', content: {
        headline: overrun ? 'Budget overrun' : `Budget ${utilisation}% utilised`,
        planned, actual, utilisation_pct: utilisation, variance: planned - actual,
        note: overrun
          ? `Actual spend exceeds plan by ${(actual - planned).toLocaleString()} ${project.currency || 'ZAR'}.`
          : `${utilisation}% of planned budget committed.`
      }},
      { type: 'recommendation', content: {
        headline: 'Priority actions',
        actions: [
          overdueMs > 0 && `Re-baseline ${overdueMs} overdue milestone(s).`,
          blocked > 0 && `Unblock ${blocked} stalled task(s).`,
          highExposure > 0 && `Escalate ${highExposure} high/high risk(s) to the sponsor.`,
          overrun && 'Review cost lines exceeding plan.',
          !overdueMs && !blocked && !highExposure && !overrun && 'Programme healthy — maintain cadence.'
        ].filter(Boolean)
      }}
    ];

    const expires = new Date(today.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    const stored = [];
    for (const ins of insights) {
      // keep one live insight per type: clear prior, insert fresh
      await query('DELETE FROM ai_insights WHERE project_id = $1 AND type = $2', [pid, ins.type]);
      stored.push(await queryOne(
        `INSERT INTO ai_insights (project_id, type, content, expires_at)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [pid, ins.type, JSON.stringify(ins.content), expires]
      ));
    }

    res.status(201).json({ generated: stored.length, insights: stored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
