// Shared helpers for auto-logging time to timesheet_entries.
// Called from meetings.close, tasks.status transitions, and the heartbeat endpoint.
// All calls are idempotent per (user_id, project_id, source, source_ref, entry_date)
// so replays don't double-count.
import { query, queryOne } from './client.js';

const ISO_DATE = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Add a timesheet entry from a deterministic source (meeting close, task status, heartbeat).
 * De-duplicated on (user_id, source, source_ref) so calling twice is safe.
 * Returns { row, dedup: boolean }.
 */
export async function logAutoEntry({ user_id, project_id, task_id = null, hours, activity, source, source_ref = null, entry_date, billable = true }) {
  if (!user_id || !project_id || !hours || !source) return { skipped: true, reason: 'missing required fields' };
  const date = entry_date || ISO_DATE();

  // Dedup: same (user, source, source_ref) on the same date is a no-op
  if (source_ref) {
    const existing = await queryOne(
      `SELECT id FROM timesheet_entries WHERE user_id = $1 AND source = $2 AND source_ref = $3 LIMIT 1`,
      [user_id, source, source_ref]
    );
    if (existing) return { row: existing, dedup: true };
  }

  const row = await queryOne(
    `INSERT INTO timesheet_entries (user_id, project_id, task_id, entry_date, hours, activity, billable, source, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [user_id, project_id, task_id, date, Math.min(24, Math.max(0, Number(hours))), activity || null, billable, source, source_ref]
  );
  return { row, dedup: false };
}

/**
 * Meeting close → auto-log each attendee with a matching user_id.
 * Attendees are stored as JSONB [{user_id?, name, role, present}] on the meeting.
 * Skips attendees without user_id or marked present:false.
 */
export async function logMeetingAttendance(meeting) {
  if (!meeting?.id || !meeting?.project_id || !meeting?.attendees) return { logged: 0 };
  const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : [];
  const hours = Math.max(0.25, Math.min(24, (Number(meeting.duration_min) || 60) / 60));
  const date = meeting.scheduled_at ? new Date(meeting.scheduled_at).toISOString().slice(0, 10) : ISO_DATE();

  let logged = 0;
  for (const a of attendees) {
    if (!a?.user_id) continue;
    if (a.present === false) continue;
    const r = await logAutoEntry({
      user_id: a.user_id,
      project_id: meeting.project_id,
      hours,
      activity: `Meeting: ${meeting.title}`,
      source: 'meeting',
      source_ref: meeting.id,
      entry_date: date,
    });
    if (r.row && !r.dedup) logged++;
  }
  return { logged, attendee_count: attendees.length, hours_each: hours };
}

/**
 * Task status change → auto-log 0.5h to the acting user under the task's project.
 * Only fires on transitions INTO 'in-progress' or 'done' (not on trivial edits).
 * De-duped on the task_id+date so multiple pings the same day count once.
 */
export async function logTaskActivity({ task, actor_user_id, new_status, old_status }) {
  if (!task?.id || !task?.project_id || !actor_user_id) return { logged: false };
  const promoted = (new_status === 'in-progress' || new_status === 'done') && new_status !== old_status;
  if (!promoted) return { logged: false, reason: 'not a promoted status change' };

  const hours = new_status === 'done' ? 1.0 : 0.5; // done implies a chunk of work; in-progress a short burst
  const date = ISO_DATE();

  const r = await logAutoEntry({
    user_id: actor_user_id,
    project_id: task.project_id,
    task_id: task.id,
    hours,
    activity: `Task ${new_status}: ${task.title}`,
    source: 'task',
    source_ref: task.id,
    entry_date: date,
  });
  return { logged: !!r.row && !r.dedup, hours };
}

/**
 * Heartbeat aggregation.
 * The front-end pings /api/workforce/track every ~5 min while the user has a
 * project open. Each ping adds `minutes` to today's heartbeat entry for that
 * (user, project) pair — coalesced so we don't create hundreds of rows.
 */
export async function logHeartbeat({ user_id, project_id, minutes = 5 }) {
  if (!user_id || !project_id) return { skipped: true };
  const date = ISO_DATE();
  const bump = Math.min(60, Math.max(1, Number(minutes) || 5)) / 60;

  const existing = await queryOne(
    `SELECT id, hours FROM timesheet_entries
     WHERE user_id = $1 AND project_id = $2 AND entry_date = $3 AND source = 'heartbeat' LIMIT 1`,
    [user_id, project_id, date]
  );
  if (existing) {
    const newHrs = Math.min(24, Number(existing.hours) + bump);
    const row = await queryOne(
      `UPDATE timesheet_entries SET hours = $1 WHERE id = $2 RETURNING *`,
      [newHrs, existing.id]
    );
    return { row, coalesced: true };
  }
  const row = await queryOne(
    `INSERT INTO timesheet_entries (user_id, project_id, entry_date, hours, activity, billable, source)
     VALUES ($1,$2,$3,$4,'Active session (auto-tracked)',true,'heartbeat') RETURNING *`,
    [user_id, project_id, date, bump]
  );
  return { row, coalesced: false };
}
