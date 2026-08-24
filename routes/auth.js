import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, queryOne } from '../db/client.js';
import { verifyTOTP } from '../db/totp.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, org_name, org_industry } = req.body;
    if (!email || !password || !full_name || !org_name) {
      return res.status(400).json({ error: 'email, password, full_name, and org_name are required' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const slug = org_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const org = await queryOne(
      'INSERT INTO organisations (name, slug, industry) VALUES ($1, $2, $3) RETURNING *',
      [org_name, slug, org_industry]
    );

    const password_hash = await bcrypt.hash(password, 12);
    const user = await queryOne(
      `INSERT INTO users (org_id, email, password_hash, full_name, role, is_org_admin)
       VALUES ($1, $2, $3, $4, 'admin', TRUE)
       RETURNING id, email, full_name, role, is_org_admin, org_id`,
      [org.id, email.toLowerCase(), password_hash, full_name]
    );

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, org_id: org.id, is_org_admin: true },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await queryOne(
      `INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'user.registered', 'user', $2, $3)`,
      [org.id, user.id, JSON.stringify({ email: user.email })]
    );

    res.status(201).json({ token, user, org });
  } catch (err) {
    console.error('[AUTH] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = await queryOne(
      'SELECT id, email, password_hash, full_name, role, is_org_admin, org_id, is_active, mfa_enabled, mfa_secret FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account deactivated' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // MFA gate — only for users who have turned it on.
    if (user.mfa_enabled) {
      const { code } = req.body;
      if (!code) return res.status(401).json({ error: 'Authenticator code required', mfa_required: true });
      if (!verifyTOTP(user.mfa_secret, code)) return res.status(401).json({ error: 'Invalid authenticator code', mfa_required: true });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, org_id: user.org_id, is_org_admin: user.is_org_admin },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await queryOne('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    await queryOne(
      `INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'user.login', 'user', $2)`,
      [user.org_id, user.id]
    );

    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await queryOne(
      'SELECT id, email, full_name, role, is_org_admin, org_id, created_at, last_login_at FROM users WHERE id = $1',
      [payload.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const org = await queryOne(
      'SELECT id, name, slug, tier, max_users, max_projects FROM organisations WHERE id = $1',
      [user.org_id]
    );

    res.json({ user, org });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
