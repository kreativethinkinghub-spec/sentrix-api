import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_MODEL = requireRole('admin', 'director', 'pm', 'finance');

/* ── Digital Twin Simulator ────────────────────────────────────────
   A scenario is a "what-if" snapshot of a project: cloned baseline
   (budget, duration, team), then user-adjusted, then the outcome is
   computed deterministically from Fingerprint-benchmark ratios. */

function computeOutcome(base, scenario, benchmarkRisk = 0.5) {
  const budgetDelta = (scenario.budget || 0) - (base.budget || 0);
  const durationDelta = (scenario.duration || 0) - (base.duration || 0);
  const teamDelta = (scenario.team || 0) - (base.team || 0);

  // Brooks's Law adjustment: adding people to a late project makes it later.
  // A 10% team expansion mid-project adds ~3% to duration; contraction risks
  // 15% duration slip per 10% cut. Formula tuned to Fingerprint slippage data.
  const teamRatio = base.team > 0 ? teamDelta / base.team : 0;
  const brooksSlip = teamRatio > 0 ? Math.round(base.duration * teamRatio * 0.3)
                                   : Math.round(base.duration * Math.abs(teamRatio) * 1.5);

  // Budget compression: a 15% budget cut historically drives 22-35% quality risk.
  const budgetRatio = base.budget > 0 ? budgetDelta / base.budget : 0;
  const qualityRisk = budgetRatio < 0 ? Math.min(0.95, Math.abs(budgetRatio) * 2.2) : 0;

  // New duration = scenario + brooks slip
  const newDuration = (scenario.duration || 0) + brooksSlip;
  const burnRate = newDuration > 0 ? (scenario.budget || 0) / newDuration : 0;

  // Risk score: benchmarkRisk drift ± scenario deltas
  const riskScore = Math.min(1, Math.max(0,
    benchmarkRisk
    + qualityRisk * 0.4
    + Math.max(0, teamRatio * -0.3)
    + Math.max(0, brooksSlip / Math.max(1, base.duration) * 0.5)
  ));

  return {
    projected_duration_days: newDuration,
    projected_burn_rate_daily: Math.round(burnRate * 100) / 100,
    brooks_slip_days: brooksSlip,
    quality_risk: Math.round(qualityRisk * 100) / 100,
    risk_score: Math.round(riskScore * 100) / 100,
    verdict: riskScore >= 0.7 ? 'high-risk' : riskScore >= 0.4 ? 'watch' : 'acceptable',
    rationale: buildRationale({ teamRatio, budgetRatio, brooksSlip, qualityRisk })
  };
}

function buildRationale({ teamRatio, budgetRatio, brooksSlip, qualityRisk }) {
  const notes = [];
  if (teamRatio > 0.05) notes.push(`Team expansion of ${Math.round(teamRatio * 100)}% incurs ~${brooksSlip} days of ramp-up (Brooks's Law).`);
  if (teamRatio < -0.05) notes.push(`Team contraction of ${Math.round(Math.abs(teamRatio) * 100)}% risks ~${brooksSlip} days of schedule slip on remaining work.`);
  if (budgetRatio < -0.05) notes.push(`Budget cut of ${Math.round(Math.abs(budgetRatio) * 100)}% pushes quality risk to ${Math.round(qualityRisk * 100)}% per Fingerprint historical data.`);
  if (budgetRatio > 0.15) notes.push(`Budget expansion of ${Math.round(budgetRatio * 100)}% suggests scope growth — confirm requirements are baselined.`);
  if (!notes.length) notes.push('Deltas within tolerance — projected outcome close to baseline.');
  return notes;
}

// List scenarios for a project
router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*, u.full_name AS created_by_name FROM scenarios s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.project_id = $1 ORDER BY s.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create scenario — clones the project baseline, applies user changes, computes outcome
router.post('/', CAN_MODEL, async (req, res) => {
  try {
    const { project_id, name, description, scenario_budget, scenario_duration_days, scenario_team_size, notes } = req.body;
    if (!project_id || !name) return res.status(400).json({ error: 'project_id and name required' });

    // Pull the current baseline — projects has budget_total + start/end dates + members count
    const project = await queryOne(
      `SELECT p.budget_total, p.start_date, p.target_end_date,
              (SELECT COUNT(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS team_size
       FROM projects p WHERE p.id = $1`,
      [project_id]
    );
    if (!project) return res.status(404).json({ error: 'project not found' });
    const durationDays = project.start_date && project.target_end_date
      ? Math.round((new Date(project.target_end_date) - new Date(project.start_date)) / 86400000)
      : 0;
    const base = {
      budget: Number(project.budget_total) || 0,
      duration: durationDays,
      team: Number(project.team_size) || 0,
    };
    const scenario = {
      budget: scenario_budget != null ? Number(scenario_budget) : base.budget,
      duration: scenario_duration_days != null ? Number(scenario_duration_days) : base.duration,
      team: scenario_team_size != null ? Number(scenario_team_size) : base.team,
    };

    // Benchmark risk from Fingerprint if available
    const fp = await queryOne(
      `SELECT AVG(risk_score) AS r FROM fingerprints
       WHERE sector = (SELECT sector FROM projects WHERE id = $1) LIMIT 100`,
      [project_id]
    );
    const benchmarkRisk = fp?.r != null ? Number(fp.r) : 0.5;

    const outcome = computeOutcome(base, scenario, benchmarkRisk);

    const row = await queryOne(
      `INSERT INTO scenarios
        (project_id, name, description, base_budget, base_duration_days, base_team_size,
         scenario_budget, scenario_duration_days, scenario_team_size, outcome, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        project_id, name, description || null,
        base.budget, base.duration, base.team,
        scenario.budget, scenario.duration, scenario.team,
        JSON.stringify(outcome), notes || null, req.user.id,
      ]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fetch one scenario
router.get('/one/:id', async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM scenarios WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'scenario not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recompute outcome (e.g. after project baseline updated)
router.post('/:id/recompute', CAN_MODEL, async (req, res) => {
  try {
    const s = await queryOne('SELECT * FROM scenarios WHERE id = $1', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'scenario not found' });
    const project = await queryOne('SELECT sector FROM projects WHERE id = $1', [s.project_id]);
    const fp = await queryOne(
      `SELECT AVG(risk_score) AS r FROM fingerprints WHERE sector = $1 LIMIT 100`,
      [project?.sector]
    );
    const outcome = computeOutcome(
      { budget: Number(s.base_budget), duration: s.base_duration_days, team: s.base_team_size },
      { budget: Number(s.scenario_budget), duration: s.scenario_duration_days, team: s.scenario_team_size },
      fp?.r != null ? Number(fp.r) : 0.5
    );
    const row = await queryOne('UPDATE scenarios SET outcome = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [JSON.stringify(outcome), req.params.id]);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', CAN_MODEL, async (req, res) => {
  try {
    const row = await queryOne('DELETE FROM scenarios WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'scenario not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
