import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';
import { logMeetingAttendance } from '../db/autotrack.js';

const router = Router();
const CAN_MANAGE = requireRole('admin', 'director', 'pm');

/* ── Meeting Intelligence ──────────────────────────────────────────
   Agenda -> minutes -> action items. Summary is deterministic
   extractive: pulls decisions, risks, and dated commitments from
   the minutes text using pattern matching. No LLM required. */

function extractSummary(minutes) {
  if (!minutes || typeof minutes !== 'string') return null;
  const decisions = [];
  const risks = [];
  const commitments = [];
  minutes.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (/^(decision|decided|agreed|approved):/i.test(line)) decisions.push(line.replace(/^\w+:\s*/, ''));
    if (/^(risk|concern|issue|blocker):/i.test(line)) risks.push(line.replace(/^\w+:\s*/, ''));
    if (/\b(by|due|before)\s+(\d{1,2}[\s\-\/]\w+|\w+day|next\s+\w+|\d{4}-\d{2}-\d{2})/i.test(line)) commitments.push(line);
  });
  return {
    decisions_count: decisions.length,
    risks_count: risks.length,
    commitments_count: commitments.length,
    decisions: decisions.slice(0, 10),
    risks: risks.slice(0, 10),
    commitments: commitments.slice(0, 10),
    length_chars: minutes.length,
  };
}

// List meetings for a project
router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT m.*, u.full_name AS created_by_name,
              (SELECT COUNT(*)::int FROM meeting_actions WHERE meeting_id = m.id) AS action_count,
              (SELECT COUNT(*)::int FROM meeting_actions WHERE meeting_id = m.id AND status = 'open') AS open_actions
       FROM meetings m
       LEFT JOIN users u ON m.created_by = u.id
       WHERE m.project_id = $1
       ORDER BY m.scheduled_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fetch one with actions
router.get('/one/:id', async (req, res) => {
  try {
    const m = await queryOne('SELECT * FROM meetings WHERE id = $1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'meeting not found' });
    const actions = await query(
      `SELECT a.*, u.full_name AS owner_full_name
       FROM meeting_actions a
       LEFT JOIN users u ON a.owner_id = u.id
       WHERE a.meeting_id = $1
       ORDER BY a.due_date NULLS LAST, a.created_at`,
      [req.params.id]
    );
    res.json({ ...m, actions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create meeting
router.post('/', CAN_MANAGE, async (req, res) => {
  try {
    const { project_id, title, meeting_type, scheduled_at, duration_min, location, agenda, attendees } = req.body;
    if (!project_id || !title || !scheduled_at) return res.status(400).json({ error: 'project_id, title, scheduled_at required' });
    const row = await queryOne(
      `INSERT INTO meetings (project_id, title, meeting_type, scheduled_at, duration_min, location, agenda, attendees, created_by)
       VALUES ($1,$2,COALESCE($3,'other'),$4,COALESCE($5,60),$6,$7,COALESCE($8,'[]'::jsonb),$9) RETURNING *`,
      [project_id, title, meeting_type, scheduled_at, duration_min, location || null, agenda || null, JSON.stringify(attendees || []), req.user.id]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Close a meeting: write minutes, auto-summary, mark complete
router.post('/:id/close', CAN_MANAGE, async (req, res) => {
  try {
    const { minutes, actions } = req.body;
    const summary = extractSummary(minutes || '');
    const row = await queryOne(
      `UPDATE meetings SET minutes = $1, summary = $2, status = 'complete', updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [minutes || null, summary ? JSON.stringify(summary) : null, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'meeting not found' });

    // Insert action items if provided
    if (Array.isArray(actions) && actions.length) {
      for (const a of actions) {
        if (!a.action) continue;
        await queryOne(
          `INSERT INTO meeting_actions (meeting_id, action, owner_id, owner_name, due_date)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [req.params.id, a.action, a.owner_id || null, a.owner_name || null, a.due_date || null]
        );
      }
    }

    // Auto-timesheet: log the meeting duration against every present attendee
    // with a resolvable user_id. Non-blocking — timesheet errors don't fail the close.
    const autoTrack = await logMeetingAttendance(row).catch((e) => ({ error: e.message }));
    res.json({ ...row, autoTrack });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add / update an action item
router.post('/:id/actions', CAN_MANAGE, async (req, res) => {
  try {
    const { action, owner_id, owner_name, due_date } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });
    const row = await queryOne(
      `INSERT INTO meeting_actions (meeting_id, action, owner_id, owner_name, due_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, action, owner_id || null, owner_name || null, due_date || null]
    );
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/actions/:actionId', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const row = await queryOne(
      `UPDATE meeting_actions
       SET status = $1, completed_at = CASE WHEN $1 = 'done' THEN NOW() ELSE completed_at END
       WHERE id = $2 RETURNING *`,
      [status, req.params.actionId]
    );
    if (!row) return res.status(404).json({ error: 'action not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Open-actions dashboard (across all meetings for a project or a user)
router.get('/actions/open', async (req, res) => {
  try {
    const { project_id, owner_id } = req.query;
    const where = ["a.status IN ('open','in_progress')"];
    const vals = [];
    let i = 1;
    if (project_id) { where.push(`m.project_id = $${i++}`); vals.push(project_id); }
    if (owner_id) { where.push(`a.owner_id = $${i++}`); vals.push(owner_id); }
    const rows = await query(
      `SELECT a.*, m.title AS meeting_title, m.scheduled_at AS meeting_date, m.project_id
       FROM meeting_actions a
       JOIN meetings m ON a.meeting_id = m.id
       WHERE ${where.join(' AND ')}
       ORDER BY a.due_date NULLS LAST, a.created_at`,
      vals
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', CAN_MANAGE, async (req, res) => {
  try {
    const row = await queryOne('DELETE FROM meetings WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'meeting not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
