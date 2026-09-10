import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
const CAN_LOG = requireRole('admin', 'director', 'pm', 'tech', 'contractor');

/* ── Workforce Intelligence ────────────────────────────────────────
   Computes utilisation, capability coverage, and workload distribution
   from real project_members + tasks + timesheet_entries + user_capabilities.
   No ML — this is aggregated real data plus deterministic scoring. */

// Log a timesheet entry
router.post('/timesheet', CAN_LOG, async (req, res) => {
  try {
    const { project_id, task_id, entry_date, hours, activity, billable } = req.body;
    if (!project_id || !entry_date || hours == null) {
      return res.status(400).json({ error: 'project_id, entry_date, hours required' });
    }
    const row = await queryOne(
      `INSERT INTO timesheet_entries (user_id, project_id, task_id, entry_date, hours, activity, billable)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true)) RETURNING *`,
      [req.user.id, project_id, task_id || null, entry_date, hours, activity || null, billable]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Utilisation report — hours logged / target hours per user in a window
router.get('/utilisation', async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const targetPerDay = Number(req.query.target_hours_per_day) || 8;
    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
    const workingDays = Math.round(days * 5 / 7); // rough weekday count
    const targetHours = workingDays * targetPerDay;

    const rows = await query(
      `SELECT u.id, u.full_name, u.role,
              COALESCE(SUM(t.hours), 0)::numeric AS hours,
              COALESCE(SUM(CASE WHEN t.billable THEN t.hours ELSE 0 END), 0)::numeric AS billable_hours,
              COUNT(DISTINCT t.project_id)::int AS projects
       FROM users u
       LEFT JOIN timesheet_entries t ON t.user_id = u.id AND t.entry_date BETWEEN $1 AND $2
       WHERE u.org_id = $3
       GROUP BY u.id, u.full_name, u.role
       ORDER BY hours DESC`,
      [from, to, req.user.org_id]
    );
    const enriched = rows.map((r) => {
      const hrs = Number(r.hours);
      const bill = Number(r.billable_hours);
      return {
        ...r,
        hours: hrs,
        billable_hours: bill,
        utilisation_pct: targetHours > 0 ? Math.round((hrs / targetHours) * 100) : 0,
        billable_ratio_pct: hrs > 0 ? Math.round((bill / hrs) * 100) : 0,
        status: hrs / targetHours > 1.15 ? 'over-allocated'
              : hrs / targetHours > 0.85 ? 'healthy'
              : hrs / targetHours > 0.5 ? 'under-utilised'
              : 'available',
      };
    });
    res.json({ from, to, target_hours: targetHours, users: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Team allocation heatmap — hours per user per project
router.get('/allocation/:projectId', async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const rows = await query(
      `SELECT u.id, u.full_name, u.role, pm.role AS project_role,
              COALESCE(SUM(t.hours), 0)::numeric AS hours,
              COUNT(t.id)::int AS entries
       FROM project_members pm
       JOIN users u ON pm.user_id = u.id
       LEFT JOIN timesheet_entries t
         ON t.user_id = u.id AND t.project_id = pm.project_id
        AND t.entry_date BETWEEN $2 AND $3
       WHERE pm.project_id = $1
       GROUP BY u.id, u.full_name, u.role, pm.role
       ORDER BY hours DESC`,
      [req.params.projectId, from, to]
    );
    res.json({ project_id: req.params.projectId, from, to, members: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Capability register — who has what skill/cert, expiring-soon flags
router.get('/capabilities', async (req, res) => {
  try {
    const soon = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);
    const rows = await query(
      `SELECT u.id, u.full_name, u.role,
              json_agg(json_build_object(
                'capability', c.capability,
                'proficiency', c.proficiency,
                'certified', c.certified,
                'cert_expiry', c.cert_expiry,
                'expiring_soon', c.cert_expiry IS NOT NULL AND c.cert_expiry <= $2::date
              ) ORDER BY c.capability) FILTER (WHERE c.capability IS NOT NULL) AS capabilities
       FROM users u
       LEFT JOIN user_capabilities c ON c.user_id = u.id
       WHERE u.org_id = $1
       GROUP BY u.id, u.full_name, u.role
       ORDER BY u.full_name`,
      [req.user.org_id, soon]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Register / update a capability for a user
router.post('/capabilities', requireRole('admin', 'director', 'pm'), async (req, res) => {
  try {
    const { user_id, capability, proficiency, certified, cert_expiry } = req.body;
    if (!user_id || !capability || proficiency == null) {
      return res.status(400).json({ error: 'user_id, capability, proficiency required' });
    }
    const row = await queryOne(
      `INSERT INTO user_capabilities (user_id, capability, proficiency, certified, cert_expiry)
       VALUES ($1,$2,$3,COALESCE($4,false),$5)
       ON CONFLICT (user_id, capability)
       DO UPDATE SET proficiency = EXCLUDED.proficiency,
                     certified = EXCLUDED.certified,
                     cert_expiry = EXCLUDED.cert_expiry
       RETURNING *`,
      [user_id, capability, proficiency, certified, cert_expiry || null]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Capability gap: which capabilities does a project need vs the team
router.get('/gap/:projectId', async (req, res) => {
  try {
    const needed = (req.query.needed || '').split(',').filter(Boolean);
    if (!needed.length) return res.status(400).json({ error: 'needed=cap1,cap2 required' });

    const rows = await query(
      `SELECT c.capability,
              COUNT(*)::int AS people,
              AVG(c.proficiency)::numeric(3,1) AS avg_proficiency,
              SUM(CASE WHEN c.certified THEN 1 ELSE 0 END)::int AS certified
       FROM project_members pm
       JOIN user_capabilities c ON c.user_id = pm.user_id
       WHERE pm.project_id = $1 AND c.capability = ANY($2::text[])
       GROUP BY c.capability`,
      [req.params.projectId, needed]
    );
    const covered = new Set(rows.map((r) => r.capability));
    const gaps = needed.filter((n) => !covered.has(n));
    res.json({ needed, coverage: rows, gaps, gap_count: gaps.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
