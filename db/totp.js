// TOTP (RFC 6238) implemented with Node crypto — no external dependency.
// Works with Google Authenticator / Authy / 1Password.
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function genSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.substr(i, 5), 2)];
  return out;
}

function b32decode(s) {
  s = s.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const c of s) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = b32decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1e6).toString().padStart(6, '0');
}

export function verifyTOTP(secret, token, window = 1) {
  if (!secret || !token) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  const t = String(token).trim();
  for (let w = -window; w <= window; w++) if (hotp(secret, step + w) === t) return true;
  return false;
}

export function otpauthURI(secret, email) {
  return `otpauth://totp/SENTRIX:${encodeURIComponent(email)}?secret=${secret}&issuer=SENTRIX&digits=6&period=30`;
}
