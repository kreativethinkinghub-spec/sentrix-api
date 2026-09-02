# SENTRIX API — Railway deploy

The repo is Railway-ready: `railway.json` (Nixpacks build, `npm run start:prod`,
healthcheck `/api/health`), `process.env.PORT` binding, idempotent migrate/seed.

## 1. Create the project (from GitHub)
1. Go to https://railway.app → sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick `kreativethinkinghub-spec/sentrix-api` (branch `main`).
   Railway detects Node/Nixpacks and starts a build.

## 2. Add PostgreSQL
1. In the project canvas: **+ New → Database → Add PostgreSQL**.
2. On the **API service → Variables**, add a reference:
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`

## 3. Set environment variables (API service → Variables)
- `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`  (reference, step 2)
- `JWT_SECRET`   = a long random string (e.g. `openssl rand -hex 32`)
- `NODE_ENV`     = `production`
- Optional, when ready (leave unset = inert): `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`,
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `SSO_CALLBACK_URL`.
- Do **not** paste live secret keys anywhere but here. Rotate any key ever shared in chat.

## 4. First deploy
- On deploy, `start:prod` runs `db/migrate.js` → `db/seed.js` → `node server.js`
  (all idempotent). Healthcheck hits `/api/health`.
- **Seed the 100k Fingerprint corpus once** (one-off, keeps boot fast):
  Railway service → **⋯ → Shell** (or CLI `railway run`):
  `npm run db:fingerprints`

## 5. Public URL / custom domain
- API service → **Settings → Networking → Generate Domain** (gives `*.up.railway.app`), or
- **Custom Domain** → `api.sentrix-pmo.com`, then add the shown CNAME in Cloudflare DNS
  (DNS-only / grey cloud).

## 6. Point the frontend at the new API
Tell Claude the final API URL; it updates two spots in `sentrix-site` and redeploys:
- `js/sentrix.js` API base (currently `https://sentrix-api.onrender.com`)
- `_headers` CSP `connect-src` (same host)

## CLI alternative (optional)
```
npm i -g @railway/cli
railway login
railway link           # select the project
railway up             # deploy current dir
railway run npm run db:fingerprints
```
