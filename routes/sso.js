import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../db/client.js';
import { authenticate, requireOrgAdmin } from '../middleware/auth.js';

const router = Router();
const CALLBACK = () => process.env.SSO_CALLBACK_URL || 'https://sentrix-api.onrender.com/api/sso/callback';
const APP = () => process.env.APP_URL || 'https://sentrix-pmo.com';

async function discover(issuer) {
  const r = await fetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
  if (!r.ok) throw new Error('OIDC discovery failed');
  return r.json();
}

// ── Admin: view / set the org's OIDC config (secret never returned) ──
router.get('/config', authenticate, async (req, res) => {
  const c = await queryOne('SELECT provider, issuer, client_id, default_role, enabled FROM sso_configs WHERE org_id = $1', [req.user.org_id]);
  res.json(c || { enabled: false });
});
router.post('/config', authenticate, requireOrgAdmin, async (req, res) => {
  try {
    const { issuer, client_id, client_secret, default_role, enabled } = req.body;
    if (!issuer || !client_id || !client_secret) return res.status(400).json({ error: 'issuer, client_id and client_secret are required' });
    const row = await queryOne(
      `INSERT INTO sso_configs (org_id, issuer, client_id, client_secret, default_role, enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id) DO UPDATE SET issuer=$2, client_id=$3, client_secret=$4, default_role=$5, enabled=$6
       RETURNING provider, issuer, client_id, default_role, enabled`,
      [req.user.org_id, issuer, client_id, client_secret, default_role || 'pm', enabled !== false]
    );
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Public: start SSO for an org (by slug) ──
router.get('/:slug/start', async (req, res) => {
  try {
    const org = await queryOne('SELECT id FROM organisations WHERE slug = $1', [req.params.slug]);
    if (!org) return res.status(404).send('Unknown organisation');
    const cfg = await queryOne('SELECT * FROM sso_configs WHERE org_id = $1 AND enabled = TRUE', [org.id]);
    if (!cfg) return res.status(400).send('SSO not enabled for this organisation');
    const meta = await discover(cfg.issuer);
    const state = jwt.sign({ org_id: org.id, n: Math.random().toString(36).slice(2) }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('client_id', cfg.client_id);
    url.searchParams.set('redirect_uri', CALLBACK());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) { res.status(500).send('SSO error: ' + err.message); }
});

// ── Public: OIDC callback → provision/find user → issue Sentrix JWT ──
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code/state');
    let payload;
    try { payload = jwt.verify(state, process.env.JWT_SECRET); } catch { return res.status(400).send('Invalid state'); }
    const cfg = await queryOne('SELECT * FROM sso_configs WHERE org_id = $1 AND enabled = TRUE', [payload.org_id]);
    if (!cfg) return res.status(400).send('SSO not enabled');
    const meta = await discover(cfg.issuer);

    // Exchange the code for tokens.
    const tokRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK(), client_id: cfg.client_id, client_secret: cfg.client_secret }),
    });
    const tok = await tokRes.json();
    if (!tokRes.ok || !tok.access_token) return res.status(400).send('Token exchange failed');

    // Fetch the verified identity from userinfo.
    const uiRes = await fetch(meta.userinfo_endpoint, { headers: { authorization: 'Bearer ' + tok.access_token } });
    const ui = await uiRes.json();
    const email = (ui.email || '').toLowerCase();
    if (!email) return res.status(400).send('No email from identity provider');

    // Find or auto-provision the user within this org.
    let user = await queryOne('SELECT id, email, full_name, role, is_org_admin, org_id FROM users WHERE email = $1', [email]);
    if (!user) {
      user = await queryOne(
        `INSERT INTO users (org_id, email, password_hash, full_name, role, is_org_admin)
         VALUES ($1,$2,'SSO',$3,$4,FALSE)
         RETURNING id, email, full_name, role, is_org_admin, org_id`,
        [payload.org_id, email, ui.name || email, cfg.default_role || 'pm']
      );
    } else if (user.org_id !== payload.org_id) {
      return res.status(403).send('Account belongs to a different organisation');
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, org_id: user.org_id, is_org_admin: user.is_org_admin },
      process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    await queryOne("INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id) VALUES ($1,$2,'user.sso_login','user',$2)", [user.org_id, user.id]);
    // Hand the token to the SPA (which stores it and drops the fragment).
    res.redirect(APP() + '/dashboard.html#sso_token=' + encodeURIComponent(token));
  } catch (err) { res.status(500).send('SSO callback error: ' + err.message); }
});

export default router;
