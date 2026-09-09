# SENTRIX API — R0/mo Deploy Runbook

**Stack:** Render (web + Postgres, free) → after 90 days swap DB to Neon (free forever) → UptimeRobot keep-warm (free).

## Trade-offs you're accepting

1. **No SA data residency.** Free hosting on the market doesn't include a JNB region. Your site is on Cloudflare (global anycast, includes JNB edge), your API will be in **Frankfurt (EU)**. The DB is where the sensitive data lives — Frankfurt is POPIA-workable (Section 72(1)(b) — recipient country has adequate law) but not "SA-hosted". Update your product-brief line to say **"POPIA-first, EU-hosted; SA-hosted available on Command tier and above"** so you're not overclaiming.
2. **Cold starts.** Render Free sleeps after 15 min of no traffic. First request wakes it (~50 seconds). This kills the "hit Start Trial and see the form submit instantly" experience. Fix: UptimeRobot pings `/api/health` every 5 min, keeps the machine warm. See step 4 below.
3. **DB expiry.** Render's free Postgres expires after 90 days. Two options at that point: pay $7/mo to keep it on Render, OR migrate to **Neon** free tier (0.5 GB, forever). See "After 90 days" section.

## Step 1 — Deploy the API

1. Push is already done — commit is on the `main` branch of `kreativethinkinghub-spec/sentrix-api`.
2. Go to https://dashboard.render.com → **New +** → **Blueprint**.
3. Connect the repo `kreativethinkinghub-spec/sentrix-api`.
4. Render reads `render.yaml`, shows you the plan preview (1 free web + 1 free Postgres), click **Apply**.
5. Wait ~5 minutes for the first build. Watch the build log — the pre-deploy runs `db/migrate.js && db/seed.js`.

You'll get two URLs like:
- API:  `https://sentrix-api.onrender.com`
- DB:   internal Postgres connection (already wired via `fromDatabase:`)

## Step 2 — Verify the API is up

```bash
curl https://sentrix-api.onrender.com/api/health
# {"status":"ok","db":"up","version":"1.0.0","uptime":42}

curl -X POST -H "content-type: application/json" \
  -d '{"plan":"pro","billing":"monthly","email":"you@example.com","company":"Test","firstName":"You","lastName":"Test","terms":true}' \
  https://sentrix-api.onrender.com/api/subscribe/trial
# {"ok":true,"id":"...","message":"Trial request received..."}
```

If the second call returns `500 connect ECONNREFUSED`, the pre-deploy migrations didn't run — trigger a manual deploy in the Render dashboard.

## Step 3 — Point the frontend at the API

Edit `sentrix-site/js/api-config.js`:

```js
window.SENTRIX_API_BASE = 'https://sentrix-api.onrender.com';
```

Then redeploy the site:

```bash
cd sentrix-site
npx wrangler@latest pages deploy . --project-name sentrix-pmo --commit-dirty=true --branch main
```

## Step 4 — Set up UptimeRobot keep-warm (critical for cold starts)

1. Sign up at https://uptimerobot.com (free, 50 monitors).
2. **Add New Monitor**:
   - Type: HTTP(s)
   - URL: `https://sentrix-api.onrender.com/api/health`
   - Interval: **5 minutes** (free tier minimum)
   - Alert contacts: your email
3. Save. The 5-min ping keeps Render's machine warm — your subscribe form submits in ~200ms instead of ~50s.

The cost is that Render logs 12 pings/hour × 24h = 288 pings/day. On the 750h/mo free budget, you have plenty of runway.

## Step 5 — SMTP for signup email alerts (optional)

Without SMTP, requests still land in the DB — the mailer just no-ops. To get the email notifications:

**Free SMTP options:**
- **Brevo (Sendinblue)** — 300 emails/day free. Sign up → SMTP & API → get credentials.
- **Resend** — 100 emails/day free, 3000/mo. Modern, easy.
- **Gmail SMTP** — free but needs an App Password + your Gmail account. Fine for low volume, not recommended for production.

In the Render dashboard → sentrix-api service → **Environment** → set:

```
SMTP_HOST     = smtp-relay.brevo.com          (or your provider)
SMTP_PORT     = 587
SMTP_USER     = your-smtp-username
SMTP_PASS     = your-smtp-password
SIGNUP_NOTIFY_TO = enterprise@kth-tech.com
MAIL_FROM     = SENTRIX <noreply@sentrix-pmo.com>
```

Save → Render auto-redeploys. Next signup fires an email.

## After 90 days — swap the DB to Neon (forever free)

Render's free Postgres expires ~90 days from creation. To keep everything free:

1. Sign up at https://neon.tech (free).
2. Create a project (region: `aws-eu-central-1` = Frankfurt, closest to your Render app).
3. Copy the connection string from the Neon dashboard (looks like `postgres://user:pass@xxxx.eu-central-1.aws.neon.tech/neondb`).
4. In Render → sentrix-api → **Environment**: change `DATABASE_URL` to the Neon string. Delete the `fromDatabase:` binding.
5. Save. On next deploy the migration runs against Neon, seeding the schema. Neon free tier: 0.5 GB storage, auto-suspends on total inactivity (~5 min after last query) but resumes instantly on first query. Combined with UptimeRobot, it stays warm.
6. In Render → **Databases** → delete the old `sentrix-db` to reclaim the free slot.

Now your stack is 100% free forever.

## Watching the plumbing

- Render logs: dashboard → sentrix-api → Logs (live tail).
- Signup requests captured: dashboard → sentrix-db → **Info** → connect via psql:
  ```sql
  SELECT created_at, kind, plan, email, company FROM signup_requests ORDER BY created_at DESC LIMIT 20;
  ```
- UptimeRobot status: dashboard shows uptime %, if it dips below 99% Render is sleeping and you need to lower the ping interval / check the health endpoint.

## When you outgrow free

Trigger to upgrade:
- **> 25 form submissions/day** or > 5 second p95 response times → Render Starter ($7/mo web + $7/mo DB = $14/mo, no sleep, SA support)
- **You win a deal that requires actual SA hosting** → move to Fly.io JNB ([FLY-DEPLOY.md](FLY-DEPLOY.md)) or a JHB VPS

Until then: R0/mo, works, honest.
