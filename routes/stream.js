import { Router } from 'express';
import { query } from '../db/client.js';

const router = Router();

/* ── Real-time streaming via Server-Sent Events ────────────────────
   Runs on any hosting tier (unlike WebSockets on Render Free).
   Polls the DB every 4s and emits events for new notifications,
   status changes, and RAG updates for the connected user's org. */

const POLL_MS = 4000;

router.get('/:projectId', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('ready', { project_id: req.params.projectId, poll_ms: POLL_MS, ts: Date.now() });

  let lastNotifId = null;
  let lastMilestoneUpdate = null;
  let lastRiskUpdate = null;

  const tick = async () => {
    try {
      // New notifications
      const notifs = await query(
        `SELECT id, title, body, severity, created_at FROM notifications
         WHERE org_id = $1 ${lastNotifId ? 'AND id > $2' : ''}
         ORDER BY id DESC LIMIT 20`,
        lastNotifId ? [req.user.org_id, lastNotifId] : [req.user.org_id]
      );
      if (notifs.length) {
        lastNotifId = notifs[0].id;
        send('notifications', notifs.reverse());
      }

      // Milestone status changes since last poll
      const ms = await query(
        `SELECT id, name, status, due_date, updated_at FROM milestones
         WHERE project_id = $1 ${lastMilestoneUpdate ? 'AND updated_at > $2' : ''}
         ORDER BY updated_at DESC LIMIT 10`,
        lastMilestoneUpdate ? [req.params.projectId, lastMilestoneUpdate] : [req.params.projectId]
      );
      if (ms.length) {
        lastMilestoneUpdate = ms[0].updated_at;
        send('milestones', ms);
      }

      // Risk register deltas
      const risks = await query(
        `SELECT id, title, likelihood, impact, status, updated_at FROM risks
         WHERE project_id = $1 ${lastRiskUpdate ? 'AND updated_at > $2' : ''}
         ORDER BY updated_at DESC LIMIT 10`,
        lastRiskUpdate ? [req.params.projectId, lastRiskUpdate] : [req.params.projectId]
      );
      if (risks.length) {
        lastRiskUpdate = risks[0].updated_at;
        send('risks', risks);
      }

      // Heartbeat every tick — keeps EventSource alive through proxies
      send('heartbeat', { ts: Date.now() });
    } catch (err) {
      send('error', { message: err.message });
    }
  };

  const timer = setInterval(tick, POLL_MS);
  tick();

  req.on('close', () => {
    clearInterval(timer);
    res.end();
  });
});

export default router;
