# SENTRIX — Deploy & Un-gate Runbook

Ship the completed backend to production and make the app publicly reachable.
Everything below is a Render dashboard / one-command action — no further code changes required.

## 0. Preconditions (already true)
- All 14 tables are in `db/schema.sql`; the 7 new route groups (milestones, budget,
  documents, notifications, audit, insights, connectors) are mounted in `server.js`.
- Local boot verified: `/api/health` → `{status:"ok"}`, new routes 401 without a token.
- Frontend `js/sentrix.js` exposes `SX.milestones/budget/documents/notifications/audit/insights/connectors`.

## 1. Set DATABASE_URL in Render  ⚠️ required
The code connects via `process.env.DATABASE_URL` (pg pool in `db/client.js`).
`render.yaml` now declares it (`sync:false`) — Render will prompt for the value.
- Render → sentrix-api → **Environment** → add `DATABASE_URL`.
- Value = Supabase → Project Settings → Database → **Connection string → URI**
  (use the **pooler / port 6543** string for serverless). Include `?sslmode=require`.
- The old `SUPABASE_URL/ANON/SERVICE` vars were unused by the code and have been removed
  from render.yaml — delete them from the Render env too if present.

## 2. Run migrations + seed the fingerprint corpus (first deploy only)
```
# locally, with DATABASE_URL pointed at Supabase:
cd sentrix-api
DATABASE_URL="<supabase-uri>" node db/migrate.js
DATABASE_URL="<supabase-uri>" node db/seed.js               # org/user/demo project
DATABASE_URL="<supabase-uri>" node db/seed-fingerprints.js  # 100,000 DNA benchmarks
```
- `seed-fingerprints.js` bulk-loads **100,000** Project Fingerprint™ records (batched,
  transactional, idempotent — skips if the table already holds ≥ target). Pass a different
  count as arg 1, e.g. `node db/seed-fingerprints.js 100000`.
- After it runs, `GET /api/fingerprint/stats` returns `total: 100000` and the dashboard DNA
  wizard shows the real corpus size (it reads the live count, never a hardcoded number).
- `schema.sql` uses `CREATE TABLE` — if tables already exist, run only the missing ones.

## 3. Deploy the new code
`autoDeploy: false`, so a push alone will NOT ship.
- **If Render is git-connected:** push to the deploy branch, then Render → sentrix-api →
  **Manual Deploy → Deploy latest commit**.
- **If not git-connected:** Render → **Manual Deploy → Clear build cache & deploy**.
- Watch the deploy log for `SENTRIX API running on port 4800`.

## 4. Remove the HTTP Basic Auth wall  ⚠️ this is what blocks the public app
Production currently returns `401 www-authenticate: Basic` on every path (incl.
`/api/health`), so the frontend's Bearer-JWT calls can't reach it.
- Render → sentrix-api → **Settings** → find the **Password Protection / HTTP Auth**
  toggle (or a `render.com`-level access rule) and **turn it off**.
- If it was set via an env/middleware, it's not in this repo's code — it's a Render setting.

## 5. Verify production
```
curl -s -i https://sentrix-api.onrender.com/api/health
# expect: HTTP/1.1 200  + {"status":"ok","version":"1.0.0",...}
# and NO "www-authenticate: Basic" header
```
Smoke test with a token:
```
# register (or login) to get a JWT:
curl -s -X POST https://sentrix-api.onrender.com/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@kth-tech.com","password":"...","full_name":"You","org_name":"KTH"}'
# then, with the returned token:
curl -s https://sentrix-api.onrender.com/api/projects -H "authorization: Bearer <TOKEN>"
curl -s -X POST https://sentrix-api.onrender.com/api/insights/<PROJECT_ID>/generate \
  -H "authorization: Bearer <TOKEN>"
```

## 6. Point the frontend at prod (already correct)
`js/sentrix.js` defaults `API_URL` to `https://sentrix-api.onrender.com/api`.
CORS in `render.yaml` already allows `https://sentrix-pmo.com`. No change needed unless the
frontend domain changes.

## 7. Health-check note
`render.yaml` `healthCheckPath: /api/health` will now pass once step 4 is done (it was
failing while Basic Auth returned 401 to Render's checker too).

---
### Still open after this runbook (next build phase, not blockers)
- Frontend: only the main dashboard + (now) AI-insights & notification badge are wired to
  live data. Tasks/budget/timeline/docs/audit/connectors views are still presentational —
  the `SX.*` fetchers exist, each view just needs render + form code.
- `connectors` stores config only; real OAuth token exchange + sync is unimplemented.
- `ai_insights` uses a deterministic rule-based generator; an LLM layer can POST richer
  insights to `/api/insights` without contract changes.
