import { Router } from 'express';
import { queryOne } from '../db/client.js';
import { genSecret, verifyTOTP, otpauthURI } from '../db/totp.js';

const router = Router();

router.get('/', async (req, res) => {
  const u = await queryOne('SELECT mfa_enabled FROM users WHERE id = $1', [req.user.id]);
  res.json({ enabled: !!u?.mfa_enabled });
});

// Step 1 — generate a secret + otpauth URL to show as a QR code.
router.post('/enroll', async (req, res) => {
  try {
    const secret = genSecret();
    await queryOne('UPDATE users SET mfa_secret = $2 WHERE id = $1', [req.user.id, secret]);
    const u = await queryOne('SELECT email FROM users WHERE id = $1', [req.user.id]);
    res.json({ secret, otpauth_url: otpauthURI(secret, u.email) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 2 — confirm a code from the authenticator app to turn MFA on.
router.post('/activate', async (req, res) => {
  try {
    const u = await queryOne('SELECT mfa_secret FROM users WHERE id = $1', [req.user.id]);
    if (!u?.mfa_secret) return res.status(400).json({ error: 'Enroll first' });
    if (!verifyTOTP(u.mfa_secret, req.body.code)) return res.status(400).json({ error: 'Invalid code' });
    await queryOne('UPDATE users SET mfa_enabled = TRUE WHERE id = $1', [req.user.id]);
    res.json({ enabled: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/disable', async (req, res) => {
  try {
    const u = await queryOne('SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1', [req.user.id]);
    if (u?.mfa_enabled && !verifyTOTP(u.mfa_secret, req.body.code)) return res.status(400).json({ error: 'Invalid code' });
    await queryOne('UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL WHERE id = $1', [req.user.id]);
    res.json({ enabled: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
