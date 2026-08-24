import { Router } from 'express';
import { query, queryOne } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';
import { broadcast, hasKeys } from '../db/alerts.js';

const router = Router();
const CAN_WRITE = requireRole('admin', 'director', 'pm', 'risk');

router.get('/:projectId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT r.*, u.full_name AS owner_name
       FROM risks r LEFT JOIN users u ON r.owner_id = u.id
       WHERE r.project_id = $1 ORDER BY r.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', CAN_WRITE, async (req, res) => {
  try {
    const { project_id, type, title, description, probability, impact, rag_status, mitigation, owner_id, target_date } = req.body;
    if (!project_id || !title) return res.status(400).json({ error: 'project_id and title are required' });

    const row = await queryOne(
      `INSERT INTO risks (project_id, type, title, description, probability, impact, rag_status, mitigation, owner_id, target_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [project_id, type || 'risk', title, description, probability || 3, impact || 3, rag_status || 'amber', mitigation, owner_id, target_date, req.user.id]
    );

    if (rag_status === 'red') {
      const members = await query(
        'SELECT user_id FROM project_members WHERE project_id = $1',
        [project_id]
      );
      for (const m of members) {
        await queryOne(
          `INSERT INTO notifications (user_id, project_id, type, title, body, action_url)
           VALUES ($1,$2,'risk',$3,$4,$5)`,
          [m.user_id, project_id, `Red risk raised: ${title}`, description || title, `/dashboard?project=${project_id}&view=risks`]
        );
      }
      // Best-effort WhatsApp/SMS to opted-in members (inert without Twilio creds).
      if (hasKeys()) {
        try {
          const phones = await query(
            `SELECT DISTINCT u.phone FROM users u
             JOIN project_members pm ON pm.user_id = u.id
             WHERE pm.project_id = $1 AND u.is_active = TRUE AND u.alerts_optin = TRUE AND u.phone IS NOT NULL`,
            [project_id]
          );
          await broadcast(phones.map(p => p.phone), `SENTRIX 🔴 Red risk raised: ${title}`, 'whatsapp');
        } catch { /* never block risk creation on an alert failure */ }
      }
    }

    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', CAN_WRITE, async (req, res) => {
  try {
    const allowed = ['title','description','type','probability','impact','rag_status','mitigation','owner_id','status','target_date','resolved_date'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = $${i++}`);
        vals.push(req.body[key]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id);
    const row = await queryOne(`UPDATE risks SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Risk not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
