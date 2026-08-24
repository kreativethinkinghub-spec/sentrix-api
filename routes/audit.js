import { Router } from 'express';
import { query } from '../db/client.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// Read-only audit trail for the org. Auditors, directors, admins and org admins.
// Optional filters: ?project_id=  ?entity_type=  ?limit=
router.get('/', requireRole('auditor', 'director', 'admin', 'ceo', 'minister'), async (req, res) => {
  try {
    const params = [req.user.org_id];
    let where = 'a.org_id = $1';
    if (req.query.project_id) { params.push(req.query.project_id); where += ` AND a.project_id = $${params.length}`; }
    if (req.query.entity_type) { params.push(req.query.entity_type); where += ` AND a.entity_type = $${params.length}`; }
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    params.push(limit);

    const rows = await query(
      `SELECT a.*, u.full_name AS user_name, u.email AS user_email, p.name AS project_name
       FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN projects p ON a.project_id = p.id
       WHERE ${where}
       ORDER BY a.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
