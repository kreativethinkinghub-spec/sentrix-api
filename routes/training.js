import { Router } from 'express';
import { query, queryOne } from '../db/client.js';

const router = Router();

// Starter catalogue — auto-seeded on first request if the table is empty.
const CATALOG = [
  ['pm-fundamentals',   'PMO Fundamentals',                'Foundations', 'core',         20, 'How a command centre works: projects, RAID, milestones, and the governance loop.'],
  ['raid-mastery',      'Mastering the RAID Log',          'Risk',        'core',         25, 'Risks, assumptions, issues, dependencies — scoring, RAG status, and escalation.'],
  ['evm-cost-control',  'Earned Value & Cost Control',     'Cost',        'intermediate', 30, 'CPI/SPI, EAC forecasting, cost-of-delay — reading the money before it slips.'],
  ['change-control',    'Change Control & Variation Orders','Change',     'intermediate', 25, 'Running a change-control board: impact assessment, approval, and scope discipline.'],
  ['cyber-for-pms',     'Cyber & OT Risk for PMs',         'Cyber',       'advanced',     30, 'IEC 62443, ISO 27001 and supply-chain risk on infrastructure and SCADA programmes.'],
  ['pfma-governance',   'PFMA, MFMA & Programme Governance','Governance', 'intermediate', 25, 'Public-sector governance: PFMA/MFMA reporting, audit trails, and evidence packs.'],
  ['stakeholders',      'Stakeholder & Sponsor Management','People',      'core',         20, 'Managing sponsors, steering committees, and multi-stakeholder programmes.'],
  ['fingerprint-benchmarking','Benchmarking with Project Fingerprint','Intelligence','advanced',20,'Using DNA matching against 100k profiles to predict outcomes and set baselines.'],
];

async function ensureSeed() {
  const c = await queryOne('SELECT COUNT(*)::int AS c FROM training_modules');
  if (c && c.c > 0) return;
  for (let i = 0; i < CATALOG.length; i++) {
    const [slug, title, category, level, duration_min, summary] = CATALOG[i];
    await queryOne(
      `INSERT INTO training_modules (slug, title, category, level, duration_min, summary, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (slug) DO NOTHING`,
      [slug, title, category, level, duration_min, summary, i]
    );
  }
}

// Catalogue + the caller's progress on each module.
router.get('/modules', async (req, res) => {
  try {
    await ensureSeed();
    const rows = await query(
      `SELECT m.id, m.slug, m.title, m.category, m.level, m.duration_min, m.summary, m.sort_order,
              COALESCE(p.status,'not-started') AS status, COALESCE(p.progress_pct,0) AS progress_pct, p.completed_at
       FROM training_modules m
       LEFT JOIN training_progress p ON p.module_id = m.id AND p.user_id = $1
       WHERE m.is_active = TRUE ORDER BY m.sort_order`,
      [req.user.id]
    );
    const completed = rows.filter(r => r.status === 'completed').length;
    res.json({ modules: rows, completed, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update the caller's progress on a module (upsert).
router.post('/progress', async (req, res) => {
  try {
    const { module_id, status, progress_pct } = req.body;
    if (!module_id) return res.status(400).json({ error: 'module_id is required' });
    const st = ['not-started','in-progress','completed'].includes(status) ? status : 'in-progress';
    const pct = st === 'completed' ? 100 : Math.max(0, Math.min(100, parseInt(progress_pct) || 0));
    const row = await queryOne(
      `INSERT INTO training_progress (user_id, module_id, status, progress_pct, completed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id, module_id) DO UPDATE SET
         status=$3, progress_pct=$4, completed_at=$5, updated_at=NOW()
       RETURNING *`,
      [req.user.id, module_id, st, pct, st === 'completed' ? new Date().toISOString() : null]
    );
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
