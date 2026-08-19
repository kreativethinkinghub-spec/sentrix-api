import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../db/client.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, org_name, org_industry } = req.body;

    if (!email || !password || !full_name || !org_name) {
      return res.status(400).json({ error: 'email, password, full_name, and org_name are required' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const slug = org_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const { data: org, error: orgErr } = await supabase
      .from('organisations')
      .insert({ name: org_name, slug, industry: org_industry })
      .select()
      .single();

    if (orgErr) throw orgErr;

    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error: userErr } = await supabase
      .from('users')
      .insert({
        org_id: org.id,
        email: email.toLowerCase(),
        password_hash,
        full_name,
        role: 'admin',
        is_org_admin: true
      })
      .select('id, email, full_name, role, is_org_admin, org_id')
      .single();

    if (userErr) throw userErr;

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, org_id: org.id, is_org_admin: true },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await supabase.from('audit_log').insert({
      org_id: org.id,
      user_id: user.id,
      action: 'user.registered',
      entity_type: 'user',
      entity_id: user.id,
      details: { email: user.email }
    });

    res.status(201).json({ token, user, org });
  } catch (err) {
    console.error('[AUTH] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password_hash, full_name, role, is_org_admin, org_id, is_active')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account deactivated' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, org_id: user.org_id, is_org_admin: user.is_org_admin },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);

    await supabase.from('audit_log').insert({
      org_id: user.org_id,
      user_id: user.id,
      action: 'user.login',
      entity_type: 'user',
      entity_id: user.id
    });

    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const { data: user } = await supabase
      .from('users')
      .select('id, email, full_name, role, is_org_admin, org_id, created_at, last_login_at')
      .eq('id', payload.id)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: org } = await supabase
      .from('organisations')
      .select('id, name, slug, tier, max_users, max_projects')
      .eq('id', user.org_id)
      .single();

    res.json({ user, org });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
