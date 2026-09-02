import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';
import { sendSMS, sendWhatsApp, hasKeys } from '../db/alerts.js';

const router = Router();
const CAN_MANAGE = requireRole('admin', 'director', 'pm');

/* ── Change-management communication-plan generator ──────────────────
   Renders a full, structured comms plan from a change request: audience
   mapping, tailored key message, channel and cadence, owner and sign-off. */
function renderPlan(change) {
  const cost = Number(change.cost_impact) || 0;
  const days = Number(change.schedule_impact_days) || 0;
  const pr = (change.priority || 'medium').toLowerCase();
  const high = pr === 'critical' || pr === 'high' || cost >= 1000000 || days >= 20;

  // channel + cadence escalate with impact
  const urgentChannels = ['portal', 'email', 'sms', 'whatsapp'];
  const normalChannels = ['portal', 'email'];
  const chans = high ? urgentChannels : normalChannels;
  const cadence = high ? 'Immediate, then daily until implemented' : 'On approval, then at implementation';

  const impact = `cost ${cost ? 'R' + cost.toLocaleString('en-ZA') : 'nil'}, schedule ${days ? days + ' day(s)' : 'no'} impact`;

  const audiences = [
    { segment: 'Executive Sponsor / CEO', role: 'ceo', interest: 'Authority & strategic impact',
      message: `Change "${change.title}" (${change.type}) requires sponsor awareness: ${impact}. Priority ${pr}. Decision and rationale recorded for board reporting.`,
      channel: high ? 'email + portal' : 'portal', cadence },
    { segment: 'Programme Director', role: 'director', interest: 'Approval & delegation',
      message: `Change "${change.title}" is at status "${change.status}". ${impact}. Review against delegation-of-authority thresholds and approve/route as required.`,
      channel: 'email + portal', cadence },
    { segment: 'Project Manager', role: 'pm', interest: 'Execution & baseline',
      message: `Log change "${change.title}" against the baseline, update schedule/cost, and brief the delivery team. ${impact}.`,
      channel: 'portal + email', cadence },
    { segment: 'Finance', role: 'finance', interest: 'Budget & funding',
      message: cost ? `Budget impact of R${cost.toLocaleString('en-ZA')} from change "${change.title}" — confirm funding source and update forecast.` : `Change "${change.title}" carries no direct cost impact; note for the record.`,
      channel: 'email + portal', cadence: 'On approval' },
    { segment: 'Risk & Assurance', role: 'risk', interest: 'Risk exposure',
      message: `Assess residual risk from change "${change.title}" and update the risk register; confirm no new red risks introduced.`,
      channel: 'portal', cadence: 'On approval' },
    { segment: 'Delivery / Technical team', role: 'tech', interest: 'Work impact',
      message: `Implementation note: change "${change.title}" affects scope of work. Await PM briefing before actioning.`,
      channel: 'portal', cadence: 'At implementation' },
    { segment: 'Contractors & Suppliers', role: 'contractor', interest: 'Scope & instructions',
      message: `A variation ("${change.title}") is being processed. Do not proceed on affected work until a formal instruction is issued.`,
      channel: high ? 'email + sms' : 'email', cadence: 'On approval' },
    { segment: 'Affected stakeholders', role: 'stakeholder', interest: 'What changes for them',
      message: `Please note an approved change to the programme: "${change.title}". ${impact}. Full details and timeline are on the SENTRIX comms portal.`,
      channel: high ? 'portal + email + whatsapp' : 'portal + email', cadence }
  ];

  const key_messages = [
    `What is changing: ${change.title} (${change.type}).`,
    `Why: ${change.justification || change.description || 'Recorded in the change request.'}`,
    `Impact: ${impact}. Priority: ${pr}.`,
    `Status & next step: ${change.status} — see the change-control decision and timeline.`,
    `Where to find detail: SENTRIX Communications Portal (auditable record, read-receipted).`
  ];

  return {
    title: `Change Communication Plan — ${change.title}`,
    summary: `Auto-rendered from change ${change.reference || change.id}. ${impact}. Priority ${pr}. Distribution: ${chans.join(', ')}. Cadence: ${cadence}.`,
    audiences, key_messages, channels: chans
  };
}

/* GET /api/comms/:projectId — list plans for a project */
router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT p.*, c.reference AS change_ref, c.title AS change_title, u.full_name AS owner_name,
              (SELECT COUNT(*) FROM comms_notices n WHERE n.plan_id = p.id) AS notice_count,
              (SELECT COUNT(*) FROM comms_notices n WHERE n.plan_id = p.id AND n.status = 'read') AS read_count
       FROM comms_plans p
       LEFT JOIN change_requests c ON p.change_id = c.id
       LEFT JOIN users u ON p.owner_id = u.id
       WHERE p.project_id = $1 ORDER BY p.created_at DESC`,
      [req.params.projectId]
    );
    res.json({ plans: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/comms/change/:changeId/plan — render a comms plan from a change request */
router.post('/change/:changeId/plan', CAN_MANAGE, async (req, res) => {
  try {
    const change = await queryOne('SELECT * FROM change_requests WHERE id = $1', [req.params.changeId]);
    if (!change) return res.status(404).json({ error: 'Change request not found' });
    const p = renderPlan(change);
    const row = await queryOne(
      `INSERT INTO comms_plans (project_id, change_id, title, summary, audiences, key_messages, channels, owner_id, approver_role, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING *`,
      [change.project_id, change.id, p.title, p.summary, JSON.stringify(p.audiences),
       JSON.stringify(p.key_messages), p.channels, req.user.id, 'director', req.user.id]
    );
    res.status(201).json({ plan: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/comms/plan/:planId — plan + notices */
router.get('/plan/:planId', async (req, res) => {
  try {
    const plan = await queryOne('SELECT * FROM comms_plans WHERE id = $1', [req.params.planId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const notices = await query('SELECT * FROM comms_notices WHERE plan_id = $1 ORDER BY created_at', [req.params.planId]);
    res.json({ plan, notices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/comms/plan/:planId/publish — create + dispatch notices */
router.post('/plan/:planId/publish', CAN_MANAGE, async (req, res) => {
  try {
    const plan = await queryOne('SELECT * FROM comms_plans WHERE id = $1', [req.params.planId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const audiences = Array.isArray(plan.audiences) ? plan.audiences : JSON.parse(plan.audiences || '[]');
    const created = [];
    for (const a of audiences) {
      const channels = String(a.channel || 'portal').split('+').map(s => s.trim().toLowerCase());
      for (const ch of channels) {
        // portal notices always publish; sms/whatsapp only actually send if Twilio keys are set
        let status = 'queued', sent_at = null;
        if (ch === 'portal') { status = 'sent'; sent_at = new Date().toISOString(); }
        else if ((ch === 'sms' || ch === 'whatsapp') && hasKeys() && req.body.dispatch) {
          try { ch === 'sms' ? await sendSMS(req.body.to, a.message) : await sendWhatsApp(req.body.to, a.message); status = 'sent'; sent_at = new Date().toISOString(); }
          catch { status = 'failed'; }
        }
        const n = await queryOne(
          `INSERT INTO comms_notices (plan_id, audience, channel, recipient, message, status, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [plan.id, a.segment, ch, a.role || null, a.message, status, sent_at]
        );
        created.push(n);
      }
    }
    await query(`UPDATE comms_plans SET status = 'published' WHERE id = $1`, [plan.id]);
    res.json({ published: true, notices: created, twilio: hasKeys() ? 'live' : 'inert (no keys)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/comms/notice/:noticeId/read — read receipt */
router.post('/notice/:noticeId/read', async (req, res) => {
  try {
    const n = await queryOne(
      `UPDATE comms_notices SET status = 'read', read_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.noticeId]
    );
    if (!n) return res.status(404).json({ error: 'Notice not found' });
    res.json({ notice: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
