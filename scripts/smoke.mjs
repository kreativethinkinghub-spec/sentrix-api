/**
 * SENTRIX end-to-end smoke test.
 *
 * 1. Boots embedded-postgres on a temp port outside OneDrive (SQLite-in-OneDrive lesson applies)
 * 2. Runs schema migration and baseline seed
 * 3. Spawns the API server pointed at the embedded DB
 * 4. Registers a user via /api/auth, then hits every new route with the JWT
 * 5. Also tests both PUBLIC subscribe routes (no auth)
 * 6. Prints a PASS/FAIL matrix at the end.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pgLib from 'pg';

const API_ROOT = 'C:/Users/USER/OneDrive/02_KTH_TECH/01. 2026_KTH/KT One-Drive/Karli_Personal/sentrix-api';
const API_PORT = 4820;
const PG_PORT = 5449;
const DATA = mkdtempSync(join(tmpdir(), 'sentrix-pg-'));
const PG_USER = 'sentrix';
const PG_PASS = 'sentrix';
const PG_DB = 'sentrix';

const results = [];
const record = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${note ? ' — ' + note : ''}`);
};

async function http(method, path, { token, body, expect } = {}) {
  const url = `http://localhost:${API_PORT}${path}`;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json, url };
}

let pg, server;

async function main() {
  console.log('🐘 Starting embedded Postgres at', DATA);
  pg = new EmbeddedPostgres({
    databaseDir: DATA,
    user: PG_USER,
    password: PG_PASS,
    port: PG_PORT,
    persistent: false,
    createPostgresUser: false,
  });
  await pg.initialise();
  await pg.start();
  // Create the sentrix DB with UTF-8 encoding — the Windows initdb default is
  // WIN1252 and breaks on the box-drawing chars in schema.sql section headers.
  // Every real deployment (Render, Fly, Neon) uses UTF-8 anyway.
  {
    const admin = new pgLib.Client({ user: PG_USER, password: PG_PASS, host: '127.0.0.1', port: PG_PORT, database: 'postgres' });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${PG_DB} WITH ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    await admin.end();
  }
  const DATABASE_URL = `postgres://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}`;
  console.log('   DB up →', DATABASE_URL);

  console.log('\n📦 Running migrations + seed');
  const migrate = spawn(process.execPath, ['db/migrate.js'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mOut = '';
  migrate.stdout.on('data', (b) => (mOut += b.toString()));
  migrate.stderr.on('data', (b) => (mOut += b.toString()));
  const migrateCode = await new Promise((resolve) => migrate.on('exit', resolve));
  record('schema migrate', migrateCode === 0, migrateCode === 0 ? '' : mOut.split('\n').filter(Boolean).slice(-4).join(' | '));
  if (migrateCode !== 0) {
    console.error('\n⚠  Migrate failed — full output:\n' + mOut);
    throw new Error('migrate exited non-zero — aborting rest of suite');
  }

  const seed = spawn(process.execPath, ['db/seed.js'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let seedOut = '';
  seed.stdout.on('data', (b) => (seedOut += b.toString()));
  seed.stderr.on('data', (b) => (seedOut += b.toString()));
  const seedCode = await new Promise((resolve) => seed.on('exit', resolve));
  record('baseline seed', seedCode === 0, seedCode === 0 ? '' : seedOut.split('\n').filter(Boolean).slice(-4).join(' | '));

  console.log('\n🚀 Booting API server on port', API_PORT);
  server = spawn(process.execPath, ['server.js'], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DATABASE_URL,
      JWT_SECRET: 'smoke-test-secret-do-not-use-in-prod',
      PORT: String(API_PORT),
      CORS_ORIGIN: 'http://localhost:8686',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (b) => (serverLog += b.toString()));
  server.stderr.on('data', (b) => (serverLog += b.toString()));

  // wait until health returns db:up
  const startedAt = Date.now();
  let dbUp = false;
  while (Date.now() - startedAt < 20000) {
    try {
      const h = await http('GET', '/api/health');
      if (h.json?.db === 'up') { dbUp = true; break; }
    } catch {}
    await sleep(400);
  }
  record('/api/health returns db:up', dbUp, dbUp ? '' : serverLog.split('\n').slice(-5).join(' | '));
  if (!dbUp) throw new Error('server never reached healthy state');

  // ── AUTH ─────────────────────────────────────────────────────────
  console.log('\n🔑 Auth flow');
  const email = `smoke_${Date.now()}@example.com`;

  const register = await http('POST', '/api/auth/register', {
    body: {
      email, password: 'Sm0ke!TestPass', full_name: 'Smoke Test',
      role: 'director', org_name: 'Smoke Test Org (Pty) Ltd',
    },
  });
  record('POST /api/auth/register (director)', register.status === 201 || register.status === 200,
    `${register.status} ${JSON.stringify(register.json).slice(0, 120)}`);

  const login = await http('POST', '/api/auth/login', {
    body: { email, password: 'Sm0ke!TestPass' },
  });
  record('POST /api/auth/login → JWT', login.status === 200 && !!login.json.token,
    login.status === 200 ? `token len ${login.json.token?.length}` : JSON.stringify(login.json).slice(0, 120));

  const token = login.json.token;

  // ── AUTH GATE CHECK: unauth call must be 401 ────────────────────
  const nogate = await http('GET', '/api/scenarios/00000000-0000-0000-0000-000000000000');
  record('auth-gate: unauth call → 401', nogate.status === 401, `got ${nogate.status}`);

  // ── PROJECTS: create a project to hang everything off ───────────
  console.log('\n🏗  Setting up baseline project');
  const proj = await http('POST', '/api/projects', {
    token,
    body: {
      name: 'Smoke Test Programme',
      client_name: 'Test Client',
      sector: 'infrastructure',
      province: 'GAUTENG',
      status: 'active',
      budget_total: 10000000,
      budget: 10000000,
      duration: 365,
      team_size: 25,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      methodology: 'hybrid',
      currency: 'ZAR',
    },
  });
  record('POST /api/projects', [200, 201].includes(proj.status),
    `${proj.status} ${proj.json?.id || JSON.stringify(proj.json).slice(0, 120)}`);
  const projectId = proj.json?.id;

  // ── DIGITAL TWIN ─────────────────────────────────────────────────
  console.log('\n🌀 Digital Twin');
  const scenario = await http('POST', '/api/scenarios', {
    token,
    body: {
      project_id: projectId,
      name: '15% budget cut, 10% team cut',
      scenario_budget: 8500000,
      scenario_duration_days: 365,
      scenario_team_size: 22,
      notes: 'Testing Brooks + quality-risk math',
    },
  });
  const outcome = scenario.json?.outcome;
  const outcomeOk = outcome && typeof outcome === 'object'
    && Number.isFinite(outcome.risk_score)
    && Array.isArray(outcome.rationale);
  record('POST /api/scenarios computes outcome', [200, 201].includes(scenario.status) && outcomeOk,
    outcomeOk ? `risk=${outcome.risk_score}, verdict=${outcome.verdict}, ${outcome.rationale.length} notes` : JSON.stringify(scenario.json).slice(0, 200));

  const listScenarios = await http('GET', `/api/scenarios/${projectId}`, { token });
  record('GET /api/scenarios/:project', listScenarios.status === 200 && Array.isArray(listScenarios.json),
    `${listScenarios.status}, ${listScenarios.json?.length ?? 0} scenario(s)`);

  // ── ESG ──────────────────────────────────────────────────────────
  console.log('\n🌍 ESG tracker');
  const esg = await http('POST', '/api/esg', {
    token,
    body: {
      project_id: projectId,
      period_start: '2026-08-01', period_end: '2026-08-31',
      category: 'environmental',
      metric: 'carbon_kg_co2e',
      value: 12450.5,
      unit: 'kgCO2e',
      source: 'Eskom invoice + fuel returns',
    },
  });
  const griMapped = esg.json?.gri_ref === 'GRI 305-1';
  record('POST /api/esg auto-maps GRI ref', [200, 201].includes(esg.status) && griMapped,
    griMapped ? `mapped to ${esg.json.gri_ref}` : JSON.stringify(esg.json).slice(0, 150));

  const esgSummary = await http('GET', `/api/esg/${projectId}/summary`, { token });
  record('GET /api/esg/:project/summary', esgSummary.status === 200 && Array.isArray(esgSummary.json?.metrics),
    `${esgSummary.status}, ${esgSummary.json?.metrics?.length ?? 0} metric(s)`);

  // ── WORKFORCE ────────────────────────────────────────────────────
  console.log('\n👷 Workforce intelligence');
  const ts = await http('POST', '/api/workforce/timesheet', {
    token,
    body: { project_id: projectId, entry_date: '2026-09-05', hours: 7.5, activity: 'Sprint planning', billable: true },
  });
  record('POST /api/workforce/timesheet', [200, 201].includes(ts.status),
    `${ts.status} ${ts.json?.id || JSON.stringify(ts.json).slice(0, 120)}`);

  const util = await http('GET', '/api/workforce/utilisation?from=2026-09-01&to=2026-09-30', { token });
  record('GET /api/workforce/utilisation', util.status === 200 && Array.isArray(util.json?.users),
    `${util.status}, ${util.json?.users?.length ?? 0} user(s)`);

  const cap = await http('POST', '/api/workforce/capabilities', {
    token,
    body: { user_id: login.json.user?.id, capability: 'PMBoK', proficiency: 4, certified: true, cert_expiry: '2027-06-30' },
  });
  record('POST /api/workforce/capabilities', [200, 201].includes(cap.status),
    `${cap.status} ${JSON.stringify(cap.json).slice(0, 120)}`);

  // ── MEETINGS ─────────────────────────────────────────────────────
  console.log('\n📅 Meeting intelligence');
  const meeting = await http('POST', '/api/meetings', {
    token,
    body: {
      project_id: projectId,
      title: 'Steering Committee — Sept 2026',
      meeting_type: 'steerco',
      scheduled_at: '2026-09-15T14:00:00Z',
      duration_min: 90,
      agenda: '1. Budget review\n2. Risk register\n3. Q4 planning',
      attendees: [{ name: 'Karli Thebe', role: 'Chair', present: true }],
    },
  });
  const meetingId = meeting.json?.id;
  record('POST /api/meetings', [200, 201].includes(meeting.status) && meetingId,
    `${meeting.status} ${meetingId || JSON.stringify(meeting.json).slice(0, 120)}`);

  const close = await http('POST', `/api/meetings/${meetingId}/close`, {
    token,
    body: {
      minutes: [
        'Decision: Approved 5% budget contingency reallocation.',
        'Risk: Cyber posture assessment overdue by 3 weeks.',
        'Action item on OT security recruitment by 30 Sep.',
        'Decision: Extend sprint to 3 weeks for Q4.',
      ].join('\n'),
      actions: [
        { action: 'Finalise OT security JD', owner_name: 'CTO', due_date: '2026-09-30' },
        { action: 'Refresh cyber posture score', owner_name: 'Security lead', due_date: '2026-09-25' },
      ],
    },
  });
  const sumOk = close.json?.summary && (() => {
    try { return JSON.parse(close.json.summary).decisions_count === 2; } catch { return false; }
  })();
  record('POST /api/meetings/:id/close extracts summary', close.status === 200 && sumOk,
    close.status === 200 ? `summary parsed: ${sumOk}` : JSON.stringify(close.json).slice(0, 150));

  // ── PROCUREMENT / SUPPLY CHAIN ────────────────────────────────────
  console.log('\n📦 Supply chain intelligence');
  const proc = await http('POST', '/api/procurement', {
    token,
    body: {
      project_id: projectId,
      description: 'SCADA system replacement — 12 sites',
      category: 'Software + Hardware',
      estimated_value: 3400000,
      stage: 'tender',
      planned_award_date: '2026-11-15',
      bbbee_spend_pct: 40,
      local_content_pct: 55,
    },
  });
  record('POST /api/procurement', [200, 201].includes(proc.status),
    `${proc.status} ${proc.json?.id || JSON.stringify(proc.json).slice(0, 120)}`);

  const procSum = await http('GET', `/api/procurement/${projectId}/summary`, { token });
  record('GET /api/procurement/:project/summary', procSum.status === 200 && Array.isArray(procSum.json?.by_stage),
    `${procSum.status}, ${procSum.json?.by_stage?.length ?? 0} stage bucket(s)`);

  // ── CONTRACT VARIANCE ────────────────────────────────────────────
  console.log('\n📝 Contract variance');
  const contract = await http('POST', '/api/variations/contracts', {
    token,
    body: {
      project_id: projectId,
      contract_ref: 'CT-001',
      title: 'Civil works — Phase 1',
      original_value: 2500000,
      original_end_date: '2026-11-30',
    },
  });
  const contractId = contract.json?.id;
  record('POST /api/variations/contracts', [200, 201].includes(contract.status) && contractId,
    `${contract.status} ${contractId || JSON.stringify(contract.json).slice(0, 120)}`);

  const variation = await http('POST', '/api/variations', {
    token,
    body: {
      contract_id: contractId,
      description: 'Additional retaining wall — geotech finding',
      cost_impact: 185000,
      time_impact_days: 14,
      reason: 'Unforeseen soil condition; independent geotech report ref GT-2026-42',
    },
  });
  const variationId = variation.json?.id;
  record('POST /api/variations (proposed)', [200, 201].includes(variation.status),
    `${variation.status} ref=${variation.json?.variation_ref}`);

  const approve = await http('POST', `/api/variations/${variationId}/approve`, { token });
  record('POST /api/variations/:id/approve rolls into contract', approve.status === 200 && approve.json?.status === 'approved',
    `${approve.status} status=${approve.json?.status}`);

  const varSum = await http('GET', `/api/variations/summary/${projectId}`, { token });
  const variancePos = Number(varSum.json?.variance_total) === 185000;
  record('GET /api/variations/summary shows 185k variance', varSum.status === 200 && variancePos,
    `total=${varSum.json?.variance_total}, pct=${varSum.json?.variance_pct}`);

  // ── SSE STREAM ───────────────────────────────────────────────────
  console.log('\n📡 Real-time SSE');
  const sseCtrl = new AbortController();
  const sseOk = await Promise.race([
    (async () => {
      try {
        const r = await fetch(`http://localhost:${API_PORT}/api/stream/${projectId}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: sseCtrl.signal,
        });
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (Date.now() - startedAt < 30000) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (buf.includes('event: ready')) return true;
        }
        return false;
      } catch { return false; }
    })(),
    sleep(6000).then(() => false),
  ]);
  sseCtrl.abort();
  record('GET /api/stream/:project emits SSE "ready"', sseOk);

  // ── PUBLIC SUBSCRIBE (no auth) ───────────────────────────────────
  console.log('\n💳 Public subscribe endpoints');
  const trial = await http('POST', '/api/subscribe/trial', {
    body: {
      plan: 'pro', billing: 'monthly',
      email: `trial_${Date.now()}@example.com`,
      firstName: 'Trial', lastName: 'User', company: 'Trial Co', role: 'PMO Director',
      use: 'evaluating for a R300m road project', terms: true,
    },
  });
  record('POST /api/subscribe/trial (public)', trial.status === 201 && trial.json?.ok, `${trial.status} id=${trial.json?.id}`);

  const invoice = await http('POST', '/api/subscribe/invoice', {
    body: {
      plan: 'command', billing: 'annual',
      email: `finance_${Date.now()}@example.com`,
      company: 'Enterprise Corp',
      orgType: 'Private company (Pty) Ltd',
      contactName: 'Jane Finance',
      contactTitle: 'CFO',
      billingAddr: '1 Main Rd, Sandton, 2196',
      cycle: 'annual', users: 45,
      terms: true,
    },
  });
  record('POST /api/subscribe/invoice (public)', invoice.status === 201 && invoice.json?.ok, `${invoice.status} id=${invoice.json?.id}`);

  // Validation branches
  const badPlan = await http('POST', '/api/subscribe/trial', { body: { plan: 'not-a-plan', email: 'x@y.com', company: 'C', terms: true } });
  record('POST /api/subscribe/trial validation (bad plan → 400)', badPlan.status === 400);

  const bounceCommand = await http('POST', '/api/subscribe/trial', { body: { plan: 'command', email: 'x@y.com', company: 'C', terms: true } });
  record('POST /api/subscribe/trial (command → 400 with hint)', bounceCommand.status === 400 && /invoice/i.test(bounceCommand.json?.error || ''));

  // ── PRE-EXISTING ROUTES STILL WORKING ────────────────────────────
  console.log('\n♻  Existing routes regression check');
  const listProjects = await http('GET', '/api/projects', { token });
  record('GET /api/projects', listProjects.status === 200 && Array.isArray(listProjects.json),
    `${listProjects.status}, ${listProjects.json?.length ?? 0} project(s)`);

  const audit = await http('GET', `/api/audit?project_id=${projectId}&limit=5`, { token });
  record('GET /api/audit?project_id', audit.status === 200 && Array.isArray(audit.json),
    `${audit.status}, ${Array.isArray(audit.json) ? audit.json.length : '?'} entries`);

  // ── EXTENDED COVERAGE — exercise routes that use ALTER-added columns
  console.log('\n🔬 Extended coverage — schema-heavy routes');

  // Baseline (uses tasks.duration_days via ALTER)
  const capBaseline = await http('POST', `/api/baseline/${projectId}`, { token, body: { name: 'Baseline v1', type: 'full' } });
  record('POST /api/baseline/:project captures snapshot', [200, 201].includes(capBaseline.status),
    `${capBaseline.status} ${capBaseline.json?.id || JSON.stringify(capBaseline.json).slice(0, 120)}`);

  const listBaselines = await http('GET', `/api/baseline/${projectId}`, { token });
  record('GET /api/baseline/:project', listBaselines.status === 200 && Array.isArray(listBaselines.json),
    `${listBaselines.status}, ${listBaselines.json?.length ?? 0} baseline(s)`);

  // Change request (uses change_requests.contractor_id + .required_approver via ALTER)
  // Cost 500k > pm threshold (100k default) but <= director threshold (1m default) → routes to director
  const change = await http('POST', '/api/change', {
    token,
    body: {
      project_id: projectId,
      title: 'Additional 3 treatment works — Phase 2 scope expansion',
      type: 'scope', cost_impact: 500000, schedule_impact_days: 21, priority: 'high',
      description: 'Provincial requests for 3 additional sites',
      justification: 'DWS requested via MinMEC resolution',
    },
  });
  const requiredApproverOk = change.json?.required_approver === 'director';
  record('POST /api/change routes to director (R100k < cost ≤ R1m)', [200, 201].includes(change.status) && requiredApproverOk,
    `${change.status} required=${change.json?.required_approver} ref=${change.json?.reference}`);

  const listChanges = await http('GET', `/api/change/${projectId}`, { token });
  record('GET /api/change/:project + scope-creep rollup', listChanges.status === 200 && Array.isArray(listChanges.json?.changes),
    `${listChanges.status}, ${listChanges.json?.changes?.length ?? 0} change(s), creep_pct=${listChanges.json?.summary?.scope_creep_pct}`);

  // MFA (uses users.mfa_enabled / mfa_secret via ALTER)
  const mfaStatus = await http('GET', '/api/mfa', { token });
  record('GET /api/mfa (status)', mfaStatus.status === 200 && 'enabled' in mfaStatus.json,
    `${mfaStatus.status} enabled=${mfaStatus.json?.enabled}`);

  const mfaEnroll = await http('POST', '/api/mfa/enroll', { token, body: {} });
  record('POST /api/mfa/enroll', mfaEnroll.status === 200 && mfaEnroll.json?.secret && mfaEnroll.json?.otpauth_url,
    `${mfaEnroll.status} secret len=${mfaEnroll.json?.secret?.length}`);

  // Alerts (uses users.phone + users.alerts_optin via ALTER)
  const alertMe = await http('POST', '/api/alerts/me', { token, body: { phone: '+27820001234', alerts_optin: true } });
  record('POST /api/alerts/me (phone+optin)', alertMe.status === 200 && alertMe.json?.phone === '+27820001234',
    `${alertMe.status} phone=${alertMe.json?.phone}, optin=${alertMe.json?.alerts_optin}`);

  const alertList = await http('GET', '/api/alerts', { token });
  record('GET /api/alerts (recipient count)', alertList.status === 200 && typeof alertList.json?.recipients === 'number',
    `${alertList.status} configured=${alertList.json?.configured}, recipients=${alertList.json?.recipients}`);

  // Contractors
  const contractor = await http('POST', '/api/contractors', {
    token,
    body: { name: 'Acme Civils (Pty) Ltd', sector: 'civil-works', registration_no: '2020/123456/07', cidb_grade: '7CE', bbbee_level: '2', contact_email: 'ops@acme.example' },
  });
  const contractorId = contractor.json?.id;
  record('POST /api/contractors', [200, 201].includes(contractor.status) && contractorId,
    `${contractor.status} ${contractorId || JSON.stringify(contractor.json).slice(0, 120)}`);

  const listContractors = await http('GET', '/api/contractors', { token });
  record('GET /api/contractors', listContractors.status === 200 && Array.isArray(listContractors.json),
    `${listContractors.status}, ${listContractors.json?.length ?? 0} contractor(s)`);

  // Contractor rating (contractor_ratings uses INT 0-100) — route is /:id/rate
  const rating = await http('POST', `/api/contractors/${contractorId}/rate`, {
    token,
    body: { project_id: projectId, delivery_score: 78, quality_score: 82, safety_score: 90, cost_score: 65, notes: 'On budget, delivery slip 8 days' },
  });
  record('POST /api/contractors/:id/rate', [200, 201].includes(rating.status),
    `${rating.status} ${rating.json?.id || JSON.stringify(rating.json).slice(0, 120)}`);

  // Budget item
  const budgetItem = await http('POST', '/api/budget', {
    token,
    body: { project_id: projectId, category: 'Personnel', description: 'Q4 salaries', planned_amount: 2400000, actual_amount: 2380000, currency: 'ZAR', period: '2026-Q4' },
  });
  record('POST /api/budget', [200, 201].includes(budgetItem.status),
    `${budgetItem.status} ${budgetItem.json?.id || JSON.stringify(budgetItem.json).slice(0, 120)}`);

  // GET returns { items, summary } — not a bare array
  const listBudget = await http('GET', `/api/budget/${projectId}`, { token });
  const budgetOk = listBudget.status === 200 && Array.isArray(listBudget.json?.items) && listBudget.json.items.length > 0;
  record('GET /api/budget/:project items+summary', budgetOk,
    `${listBudget.status}, ${listBudget.json?.items?.length ?? 0} line(s), planned=${listBudget.json?.summary?.planned}`);

  // Cost EVM report (route is /:projectId/evm)
  const cost = await http('GET', `/api/cost/${projectId}/evm`, { token });
  record('GET /api/cost/:project/evm', cost.status === 200 && cost.json,
    `${cost.status} ${cost.json?.CPI != null ? 'CPI=' + cost.json.CPI : Object.keys(cost.json || {}).slice(0, 6).join(',')}`);

  // Reports — board pack (deterministic narrative from live data)
  const board = await http('GET', `/api/reports/${projectId}/board-pack`, { token });
  record('GET /api/reports/:project/board-pack', board.status === 200 && board.json?.narrative,
    `${board.status} rag=${board.json?.rag_status} narr_len=${board.json?.narrative?.length}`);

  // Users list (org roster)
  const users = await http('GET', '/api/users', { token });
  record('GET /api/users', users.status === 200 && Array.isArray(users.json),
    `${users.status}, ${users.json?.length ?? 0} user(s)`);

  // Notifications — response is { notifications, unread } not a bare array
  const notif = await http('GET', '/api/notifications', { token });
  record('GET /api/notifications', notif.status === 200 && Array.isArray(notif.json?.notifications),
    `${notif.status}, ${notif.json?.notifications?.length ?? 0} notif(s), unread=${notif.json?.unread}`);

  // Portfolio (aggregates across all org projects)
  const portfolio = await http('GET', '/api/portfolio', { token });
  record('GET /api/portfolio', portfolio.status === 200,
    `${portfolio.status} ${Object.keys(portfolio.json || {}).slice(0, 5).join(',')}`);

  // ── SUMMARY ──────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n╭─────────────────────────────────╮`);
  console.log(`│ SMOKE TEST — ${String(passed).padStart(2)}/${String(results.length).padStart(2)} passing         │`);
  console.log(`╰─────────────────────────────────╯`);
  if (failed) {
    console.log('\n❌ Failures:');
    for (const r of results.filter((x) => !x.ok)) console.log(`   - ${r.name} — ${r.note}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('FATAL:', e); process.exitCode = 1; })
  .finally(async () => {
    try { server?.kill('SIGKILL'); } catch {}
    try { await pg?.stop(); } catch {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  });
