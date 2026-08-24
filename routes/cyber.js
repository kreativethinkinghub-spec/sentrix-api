import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_ASSESS = requireRole('admin', 'director', 'risk', 'tech');

// Frameworks Sentrix scores a programme against (reference metadata for the UI).
const FRAMEWORKS = [
  { key: 'iec62443_score',    name: 'IEC 62443',   scope: 'OT / SCADA / ICS security' },
  { key: 'iso27001_score',    name: 'ISO 27001',   scope: 'Information security management' },
  { key: 'nist_score',        name: 'NIST CSF',    scope: 'Cyber identify/protect/detect/respond' },
  { key: 'popia_score',       name: 'POPIA',       scope: 'Personal-data protection (SA)' },
  { key: 'supply_chain_score',name: 'Supply Chain',scope: 'Third-party / vendor cyber risk' },
];
const OT_PENALTY = { none: 0, low: 3, medium: 8, high: 15, critical: 25 };

function computePosture(a) {
  const keys = FRAMEWORKS.map(f => f.key);
  const vals = keys.map(k => Number(a[k])).filter(v => !isNaN(v));
  if (!vals.length) return null;
  // Weight OT (IEC 62443) heavier when OT is in scope.
  const base = Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
  // If OT is present, penalise a weak IEC 62443 score and the exposure level.
  let posture = base;
  if (a.has_ot) {
    const iec = Number(a.iec62443_score);
    if (!isNaN(iec)) posture = base * 0.6 + iec * 0.4;      // OT security dominates for OT projects
    posture -= (OT_PENALTY[a.ot_exposure] || 0);
  }
  return Math.max(0, Math.min(100, Math.round(posture * 10) / 10));
}

router.get('/frameworks', (_req, res) => res.json({ frameworks: FRAMEWORKS, ot_exposure_levels: Object.keys(OT_PENALTY) }));

router.get('/:projectId', async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM cyber_assessments WHERE project_id = $1', [req.params.projectId]);
    res.json(row || { project_id: req.params.projectId, posture_score: null, assessed: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create or update a project's cyber assessment (upsert). Recomputes posture.
router.post('/', CAN_ASSESS, async (req, res) => {
  try {
    const { project_id, has_ot, iec62443_score, iso27001_score, nist_score, popia_score, supply_chain_score, ot_exposure, findings } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });
    const posture_score = computePosture({ has_ot, iec62443_score, iso27001_score, nist_score, popia_score, supply_chain_score, ot_exposure });
    const row = await queryOne(
      `INSERT INTO cyber_assessments (project_id, has_ot, iec62443_score, iso27001_score, nist_score, popia_score, supply_chain_score, ot_exposure, posture_score, findings, assessed_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (project_id) DO UPDATE SET
         has_ot=$2, iec62443_score=$3, iso27001_score=$4, nist_score=$5, popia_score=$6,
         supply_chain_score=$7, ot_exposure=$8, posture_score=$9, findings=$10, assessed_by=$11, updated_at=NOW()
       RETURNING *`,
      [project_id, !!has_ot, iec62443_score, iso27001_score, nist_score, popia_score, supply_chain_score,
       ot_exposure || 'none', posture_score, findings ? JSON.stringify(findings) : null, req.user.id]
    );
    // Auto-raise a red risk if posture is critical.
    if (posture_score != null && posture_score < 40) {
      await queryOne(
        `INSERT INTO risks (project_id, type, title, description, rag_status, probability, impact, status, created_by)
         VALUES ($1,'risk','Cyber/OT posture critical','Cyber posture score '||$2||'/100 — remediation required.','red','high','high','open',$3)`,
        [project_id, posture_score, req.user.id]
      );
    }
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
