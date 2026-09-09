# SENTRIX API — Fly.io Deploy Runbook

**Region:** Johannesburg (`jnb`) — genuine SA data residency, matches product-brief.
**Cost estimate:** ~$5–15/mo (small shared VM + managed Postgres).

## Why Fly.io over the alternatives

| Concern                    | Fly.io (JNB)              | Railway (eu-west) | Render        |
|----------------------------|---------------------------|-------------------|---------------|
| SA data residency          | ✅ Real Johannesburg DC   | ❌ Nearest EU     | ❌ US/EU      |
| POPIA-friendly by default  | ✅                        | ⚠️ Case-by-case   | ⚠️            |
| Docker-based (repeatable)  | ✅                        | ⚠️ Nixpacks       | ✅            |
| Postgres in same region    | ✅ (managed)              | ⚠️                | ⚠️            |
| Billing currency           | USD                       | USD               | USD           |

## One-time setup (do this ONCE)

### 1. Install flyctl

**Windows PowerShell** (admin):

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

**macOS/Linux:**

```bash
curl -L https://fly.io/install.sh | sh
```

Restart your terminal after install.

### 2. Sign up / sign in

```bash
flyctl auth signup    # first time only
flyctl auth login     # subsequent
```

You'll need a credit card on file (Fly free tier is gone as of 2024 — you get ~$5/mo of free credits but a card is required).

### 3. Launch the app (from the sentrix-api directory)

```bash
cd sentrix-api
flyctl launch --no-deploy --copy-config --region jnb --name sentrix-api
```

- `--no-deploy` — we set secrets before the first deploy so migrations have DATABASE_URL.
- `--copy-config` — uses the committed `fly.toml`, doesn't overwrite it.
- If `sentrix-api` is taken, pick another name (e.g. `sentrix-api-za`) and update `app = ` in `fly.toml`.

### 4. Create the managed Postgres cluster in JNB

```bash
flyctl postgres create --name sentrix-db --region jnb --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
```

Save the connection string that prints — this is your `DATABASE_URL`.

Then attach it to the app:

```bash
flyctl postgres attach sentrix-db --app sentrix-api
```

This creates a dedicated DB user for the app and injects `DATABASE_URL` automatically into secrets.

### 5. Set the remaining secrets

```bash
flyctl secrets set \
  JWT_SECRET="$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"base64url\"))')" \
  CORS_ORIGIN="https://sentrix-pmo.com" \
  --app sentrix-api
```

**When you have SMTP credentials** (Gmail / SES / Mailgun / SendGrid):

```bash
flyctl secrets set \
  SMTP_HOST="smtp.example.com" \
  SMTP_PORT="587" \
  SMTP_USER="apikey" \
  SMTP_PASS="..." \
  SMTP_SECURE="false" \
  SIGNUP_NOTIFY_TO="enterprise@kth-tech.com" \
  MAIL_FROM="SENTRIX <noreply@sentrix-pmo.com>" \
  --app sentrix-api
```

(Missing SMTP is fine — the mailer no-ops silently; DB rows still record every signup.)

### 6. First deploy

```bash
flyctl deploy --app sentrix-api
```

Watch the build and the health check pass. Grab the public URL:

```bash
flyctl status --app sentrix-api
```

You'll get something like `https://sentrix-api.fly.dev`.

### 7. Verify

```bash
curl https://sentrix-api.fly.dev/api/health
# {"status":"ok","db":"up","version":"1.0.0","uptime":42}

curl -X POST -H "content-type: application/json" \
  -d '{"plan":"pro","billing":"monthly","email":"you@example.com","company":"Test","firstName":"You","lastName":"Test","terms":true}' \
  https://sentrix-api.fly.dev/api/subscribe/trial
# {"ok":true,"id":"...","message":"Trial request received..."}
```

### 8. Point the frontend at it

Edit `sentrix-site/js/api-config.js`:

```js
window.SENTRIX_API_BASE = 'https://sentrix-api.fly.dev';
```

Then redeploy the frontend:

```bash
cd ../sentrix-site
npx wrangler@latest pages deploy . --project-name sentrix-pmo --commit-dirty=true --branch main
```

Done. Live capture at sentrix-pmo.com/subscribe.html and /invoice-request.html.

## Ongoing

### Redeploy after code changes

```bash
cd sentrix-api
flyctl deploy --app sentrix-api
```

### Rotate a secret

```bash
flyctl secrets set JWT_SECRET="new-value" --app sentrix-api
```

Fly restarts the app when secrets change.

### Tail logs

```bash
flyctl logs --app sentrix-api
```

### Scale up if traffic grows

```bash
flyctl scale memory 1024 --app sentrix-api    # 512 MB → 1 GB
flyctl scale count 2 --app sentrix-api        # add a second machine (HA)
```

### Custom domain (api.sentrix-pmo.com)

```bash
flyctl certs add api.sentrix-pmo.com --app sentrix-api
# then in Cloudflare DNS: CNAME api.sentrix-pmo.com -> sentrix-api.fly.dev  (proxy: off)
```

Then update `js/api-config.js` to `https://api.sentrix-pmo.com` and redeploy the frontend.

### Cost control

```bash
flyctl status --app sentrix-api                 # see machines running
flyctl scale count 1 --app sentrix-api          # scale back to 1 machine
flyctl postgres list                            # DB usage
```

Rough monthly: 1× shared-cpu-1x (512 MB) ≈ $2, Managed Postgres shared-cpu-1x (10 GB) ≈ $8–12, plus egress ≈ pennies for a low-traffic marketing site. **Total ≈ $10–15/mo.**

## Rollback

Fly keeps every image. To roll back:

```bash
flyctl releases --app sentrix-api
flyctl deploy --image registry.fly.io/sentrix-api:deployment-01-... --app sentrix-api
```

## Killswitch

If something goes wrong and you need to stop everything:

```bash
flyctl scale count 0 --app sentrix-api      # kills the app
flyctl postgres list                        # keep DB running, or:
flyctl apps destroy sentrix-db              # PERMANENT — do not run casually
```
