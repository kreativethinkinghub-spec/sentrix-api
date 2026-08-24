import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_RAISE = requireRole('admin', 'director', 'pm');

// Delegation-of-authority: role authority rank vs the level a change needs.
const AUTH = { contractor: 0, pm: 1, tech: 1, risk: 1, finance: 1, auditor: 1, director: 2, ceo: 3, minister: 3, admin: 3 };
const NEED = { pm: 1, director: 2, sponsor: 3 };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + (n || 0)); return x.toISOString().slice(0, 10); };

async function requiredApprover(orgId, cost) {
  const org = await queryOne('SELECT change_threshold_pm, change_threshold_director FROM organisations WHERE id = $1', [orgId]);
  const c = Number(cost) || 0;
  if (c <= Number(org?.change_threshold_pm ?? 100000)) return 'pm';
  if (c <= Number(org?.change_threshold_director ?? 1000000)) return 'director';
  return 'sponsor';
}

// List change requests + rollup incl. cumulative scope-creep vs the current baseline.
router.get('/:projectId', async (req, res) => {
  try {
    const pid = req.params.projectId;
    const rows = await query(
      `SELECT c.*, r.full_name AS raised_name, d.full_name AS decided_name, ct.name AS contractor_name
       FROM change_requests c
       LEFT JOIN users r ON c.raised_by = r.id
       LEFT JOIN users d ON c.decided_by = d.id
       LEFT JOIN contractors ct ON c.contractor_id = ct.id
       WHERE c.project_id = $1 ORDER BY c.created_at DESC`,
      [pid]
    );
    const summary = rows.reduce((a, c) => {
      a.total++; a[c.status] = (a[c.status] || 0) + 1;
      if (c.status === 'approved') { a.approved_cost += Number(c.cost_impact) || 0; a.approved_days += c.schedule_impact_days || 0; }
      if (['submitted', 'under-review'].includes(c.status)) a.pending++;
      return a;
    }, { total: 0, pending: 0, approved_cost: 0, approved_days: 0 });

    const bl = await queryOne('SELECT snapshot FROM baselines WHERE project_id = $1 AND is_current = TRUE', [pid]);
    const baseBudget = bl?.snapshot?.budget_total || 0;
    summary.scope_creep_pct = baseBudget ? Math.round(summary.approved_cost / baseBudget * 100) : null;
    summary.baseline_budget = baseBudget;
    res.json({ changes: rows, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', CAN_RAISE, async (req, res) => {
  try {
    const { project_id, title, type, description, justification, cost_impact, schedule_impact_days, priority, contractor_id } = req.body;
    if (!project_id || !title) return res.status(400).json({ error: 'project_id and title are required' });
    const count = await queryOne('SELECT COUNT(*)::int AS c FROM change_requests WHERE project_id = $1', [project_id]);
    const reference = 'CR-' + String((count?.c || 0) + 1).padStart(3, '0');
    const required = await requiredApprover(req.user.org_id, cost_impact);
    const row = await queryOne(
      `INSERT INTO change_requests (project_id, reference, title, type, description, justification, cost_impact, schedule_impact_days, priority, status, raised_by, required_approver, contractor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10,$11,$12) RETURNING *`,
      [project_id, reference, title, type || 'scope', description, justification, cost_impact || 0, schedule_impact_days || 0, priority || 'medium', req.user.id, required, contractor_id || null]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', CAN_RAISE, async (req, res) => {
  try {
    const allowed = ['title', 'type', 'description', 'justification', 'cost_impact', 'schedule_impact_days', 'priority', 'status', 'contractor_id'];
    const sets = [], vals = []; let i = 1;
    for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(req.body[k]); }
    // Re-route authority if the cost impact changed.
    if (req.body.cost_impact !== undefined) { sets.push(`required_approver = $${i++}`); vals.push(await requiredApprover(req.user.org_id, req.body.cost_impact)); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    const row = await queryOne(`UPDATE change_requests SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Simulate the impact of a change: cost (BAC delta), schedule (milestone slips), scope creep.
router.get('/:id/impact', async (req, res) => {
  try {
    const cr = await queryOne('SELECT * FROM change_requests WHERE id = $1', [req.params.id]);
    if (!cr) return res.status(404).json({ error: 'Change request not found' });
    const pid = cr.project_id;
    const [budget, project, ms, approved, bl] = await Promise.all([
      query('SELECT planned_amount FROM budget_items WHERE project_id = $1', [pid]),
      queryOne('SELECT budget_total, currency FROM projects WHERE id = $1', [pid]),
      query("SELECT title, due_date FROM milestones WHERE project_id = $1 AND status != 'completed' AND due_date IS NOT NULL ORDER BY due_date", [pid]),
      queryOne("SELECT COALESCE(SUM(cost_impact),0) c, COALESCE(SUM(schedule_impact_days),0) d FROM change_requests WHERE project_id = $1 AND status = 'approved'", [pid]),
      queryOne('SELECT snapshot FROM baselines WHERE project_id = $1 AND is_current = TRUE', [pid]),
    ]);
    const BAC = budget.reduce((s, b) => s + (+b.planned_amount || 0), 0) || Number(project?.budget_total) || 0;
    const change = Number(cr.cost_impact) || 0;
    const baseBudget = bl?.snapshot?.budget_total || BAC;
    const approvedCost = Number(approved?.c) || 0;
    res.json({
      change: { reference: cr.reference, title: cr.title, required_approver: cr.required_approver },
      cost: { current_bac: BAC, change, projected_bac: BAC + change, currency: project?.currency || 'ZAR' },
      schedule: { days: cr.schedule_impact_days || 0, affected_milestones: ms.slice(0, 10).map(m => ({ title: m.title, from: m.due_date, to: addDays(m.due_date, cr.schedule_impact_days) })) },
      scope_creep: {
        approved_to_date: approvedCost, plus_this: approvedCost + change,
        baseline_budget: baseBudget, days_to_date: Number(approved?.d) || 0,
        creep_pct: baseBudget ? Math.round((approvedCost + change) / baseBudget * 100) : null,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Change-control-board decision — enforces delegated authority (PM small, director medium, sponsor large).
router.post('/:id/decision', async (req, res) => {
  try {
    const { decision, notes } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    const cr = await queryOne('SELECT id, project_id, reference, required_approver FROM change_requests WHERE id = $1', [req.params.id]);
    if (!cr) return res.status(404).json({ error: 'Change request not found' });
    if ((AUTH[req.user.role] || 0) < (NEED[cr.required_approver] || 1)) {
      return res.status(403).json({ error: `This change needs ${cr.required_approver}-level authority to decide.`, required_approver: cr.required_approver });
    }
    const row = await queryOne(
      `UPDATE change_requests SET status=$2, decided_by=$3, decision_notes=$4, decided_date=CURRENT_DATE, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, decision, req.user.id, notes || null]
    );
    await queryOne(
      `INSERT INTO audit_log (org_id, project_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,$3,'change.decided','change_request',$4,$5)`,
      [req.user.org_id, cr.project_id, req.user.id, cr.id, JSON.stringify({ reference: cr.reference, decision, authority: cr.required_approver })]
    );
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
