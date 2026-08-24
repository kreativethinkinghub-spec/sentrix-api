import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/client.js';
import { requireOrgAdmin } from '../middleware/auth.js';

const router = Router();

const ROLES = ['ceo','director','pm','finance','risk','tech','auditor','minister','contractor','admin'];

// List everyone in the caller's org (no password hashes)
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, email, full_name, role, is_org_admin, is_active, last_login_at, created_at
       FROM users WHERE org_id = $1 ORDER BY created_at`,
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Invite / create a team member in the caller's org (org admin only).
// Enforces the org's max_users seat limit. Returns a one-time temp password.
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const { email, full_name, role, is_org_admin } = req.body;
    if (!email || !full_name) return res.status(400).json({ error: 'email and full_name are required' });
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });

    const org = await queryOne('SELECT max_users FROM organisations WHERE id = $1', [req.user.org_id]);
    const count = await queryOne('SELECT COUNT(*)::int AS c FROM users WHERE org_id = $1', [req.user.org_id]);
    if (org && count.c >= org.max_users) {
      return res.status(403).json({ error: `Seat limit reached (${org.max_users}). Upgrade tier to add more users.` });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Temp password the admin shares; user resets on first login.
    const tempPassword = 'Sx-' + Math.random().toString(36).slice(2, 10) + 'A1';
    const password_hash = await bcrypt.hash(tempPassword, 12);

    const user = await queryOne(
      `INSERT INTO users (org_id, email, password_hash, full_name, role, is_org_admin)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, full_name, role, is_org_admin, is_active, created_at`,
      [req.user.org_id, email.toLowerCase(), password_hash, full_name, role || 'pm', !!is_org_admin]
    );

    await queryOne(
      `INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,'user.invited','user',$3,$4)`,
      [req.user.org_id, req.user.id, user.id, JSON.stringify({ email: user.email, role: user.role })]
    );

    res.status(201).json({ user, temp_password: tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a member's role / admin flag / active status (org admin only, same org)
router.patch('/:id', requireOrgAdmin, async (req, res) => {
  try {
    if (req.body.role && !ROLES.includes(req.body.role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    }
    const allowed = ['full_name','role','is_org_admin','is_active'];
    const sets = [], vals = [];
    let i = 1;
    for (const k of allowed) {
      if (req.body[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id, req.user.org_id);
    const row = await queryOne(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i++} AND org_id = $${i}
       RETURNING id, email, full_name, role, is_org_admin, is_active`,
      vals
    );
    if (!row) return res.status(404).json({ error: 'User not found in your organisation' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deactivate (soft-delete) a member — never hard-delete for audit integrity.
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate yourself' });
    const row = await queryOne(
      'UPDATE users SET is_active = FALSE WHERE id = $1 AND org_id = $2 RETURNING id',
      [req.params.id, req.user.org_id]
    );
    if (!row) return res.status(404).json({ error: 'User not found in your organisation' });
    res.json({ success: true, deactivated: row.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
