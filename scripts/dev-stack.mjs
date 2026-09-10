/**
 * Keeps embedded-postgres + the API server running so the browser can
 * exercise the subscribe/invoice forms against a real backend.
 * Ctrl-C or SIGTERM shuts everything down cleanly.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pgLib from 'pg';

const API_ROOT = 'C:/Users/USER/OneDrive/02_KTH_TECH/01. 2026_KTH/KT One-Drive/Karli_Personal/sentrix-api';
const API_PORT = Number(process.env.API_PORT) || 4830;
const PG_PORT = Number(process.env.PG_PORT) || 5459;
const DATA = mkdtempSync(join(tmpdir(), 'sentrix-devstack-'));

let pg, server;
const shutdown = async () => {
  try { server?.kill('SIGKILL'); } catch {}
  try { await pg?.stop(); } catch {}
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

pg = new EmbeddedPostgres({
  databaseDir: DATA, user: 'sentrix', password: 'sentrix',
  port: PG_PORT, persistent: false, createPostgresUser: false,
});
await pg.initialise();
await pg.start();

const admin = new pgLib.Client({ user: 'sentrix', password: 'sentrix', host: '127.0.0.1', port: PG_PORT, database: 'postgres' });
await admin.connect();
await admin.query(`CREATE DATABASE sentrix WITH ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
await admin.end();
const DATABASE_URL = `postgres://sentrix:sentrix@127.0.0.1:${PG_PORT}/sentrix`;
console.log('DB ready:', DATABASE_URL);

// Migrate + seed
for (const script of ['db/migrate.js', 'db/seed.js']) {
  const p = spawn(process.execPath, [script], {
    cwd: API_ROOT, env: { ...process.env, DATABASE_URL }, stdio: 'inherit',
  });
  const code = await new Promise((r) => p.on('exit', r));
  if (code !== 0) { console.error('script exited', code, script); await shutdown(); }
}

// Boot API — inherit stdio so we see request logs
server = spawn(process.execPath, ['server.js'], {
  cwd: API_ROOT,
  env: {
    ...process.env,
    DATABASE_URL,
    JWT_SECRET: 'devstack-secret',
    PORT: String(API_PORT),
    CORS_ORIGIN: 'http://localhost:8686',
    NODE_ENV: 'development',
  },
  stdio: 'inherit',
});
console.log(`\nAPI running on port ${API_PORT}. Ctrl-C to stop.\n`);
