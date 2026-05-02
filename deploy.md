# NQ Signal Pro V3 — Deploy Guide

## Stack

| Layer     | Tech                                              |
|-----------|---------------------------------------------------|
| Server    | Node.js 18+ · Express 4                          |
| Database  | SQLite via `better-sqlite3` (single file on disk) |
| Dashboard | Static HTML served at `/`                         |
| Webhook   | `POST /webhook` — receives TradingView alerts     |

---

## Option A — Railway  *(recommended)*

Railway gives you a persistent volume (required for SQLite to survive
redeploys) and a public HTTPS URL in about two minutes.

### 1. Push to GitHub

```bash
git add .
git commit -m "NQ Signal Pro V3 — initial build"
git push -u origin claude/trading-signal-dashboard-TNxVH
```

### 2. Create the Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** → select `NQ-Signal-Pro-V3`
3. Railway auto-detects Node.js from `package.json`

### 3. Set environment variables

Railway dashboard → your service → **Variables**:

| Variable         | Value                        | Notes                                        |
|------------------|------------------------------|----------------------------------------------|
| `PORT`           | *(leave blank)*              | Railway injects this automatically           |
| `DB_PATH`        | `/data/signals.db`           | Points into the persistent volume            |
| `WEBHOOK_SECRET` | `your-random-32-char-string` | Must match TradingView header                |
| `NTFY_TOPIC`     | `your-ntfy-topic-name`       | Required to enable ntfy push notifications   |
| `NTFY_TOKEN`     | `tk_xxxx...`                 | Only needed for private/access-token topics  |
| `NTFY_URL`       | `https://ntfy.sh`            | Override if self-hosting ntfy                |

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 4. Add a persistent volume

Railway → your service → **Volumes** → **Add Volume**
- Mount path: `/data`

Without a volume, `signals.db` resets on every deploy. The server still
runs — signals just won't persist across redeploys.

### 5. Deploy

Railway redeploys automatically on every push to the tracked branch.
Your public URL is shown under **Settings → Domains**.

```
Webhook URL:  https://<your-project>.up.railway.app/webhook
Dashboard:    https://<your-project>.up.railway.app/
```

---

## Option B — Render

Render's free tier **spins down** after 15 minutes of inactivity, causing
TradingView webhooks to time out during cold starts. Use the **Starter**
plan ($7/mo) for always-on.

### New Web Service

1. [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Root Directory:** *(blank — `server.js` is at repo root)*
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Starter
4. Environment variables: same as Railway table above

### Persistent Disk

Render → service → **Disks → Add Disk**
- Mount path: `/data`
- Then set env var `DB_PATH=/data/signals.db`

---

## Option C — VPS  *(DigitalOcean, Linode, Hetzner)*

```bash
# Clone and install
git clone https://github.com/nicolback59/NQ-Signal-Pro-V3.git
cd NQ-Signal-Pro-V3
npm install

# Environment
export PORT=3000
export DB_PATH=/home/user/nq-signals.db
export WEBHOOK_SECRET=your-secret-here
export NTFY_TOPIC=your-ntfy-topic-name   # enables push notifications
# export NTFY_TOKEN=tk_xxxx...           # only for private topics
# export NTFY_URL=https://ntfy.sh        # override if self-hosting

# Run with PM2
npm install -g pm2
pm2 start server.js --name nq-signal-pro
pm2 save && pm2 startup
```

**Nginx reverse proxy + HTTPS** (optional but recommended):

```nginx
# /etc/nginx/sites-available/nq-signal-pro
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```

```bash
sudo certbot --nginx -d yourdomain.com
```

---

## Continuous 24/7 Scanner

The scanner runs independently of TradingView. It polls Alpaca for fresh 1m and
15m bars every 60 seconds, runs the same 4-factor signal engine as the Pine
Script, and fires ntfy push notifications automatically — around the clock.

It also learns from your trade outcomes: after you log wins/losses via the
dashboard, the scanner adjusts its minimum score threshold per setup type and
suppresses signals when the current market regime is choppy.

### How it works

```
scanner.js  →  fetches 1m + 15m bars from Alpaca
            →  runs signal-engine.js (4-factor model)
            →  checks learning.js (adaptive score threshold)
            →  saves to SQLite  +  fires ntfy
```

### Market data: Alpaca

1. Create a free account at [alpaca.markets](https://alpaca.markets)
2. Go to **Paper Trading** → **API Keys** → generate a key pair
3. Verify that your account has **Futures Data** enabled (may require enabling
   in account settings)

Set environment variables:

| Variable              | Value                 | Notes                                        |
|-----------------------|-----------------------|----------------------------------------------|
| `ALPACA_KEY`          | `PKxxx...`            | Your Alpaca API key ID                       |
| `ALPACA_SECRET`       | `xxx...`              | Your Alpaca API secret                       |
| `SCANNER_SYMBOL`      | `@NQ.C.0`             | Continuous NQ front-month (verify at Alpaca) |
| `SCAN_INTERVAL`       | `60`                  | Seconds between scans (default 60)           |
| `SCANNER_COOLDOWN`    | `3`                   | Min bars between signals (default 3)         |
| `SCANNER_MIN_SCORE`   | `16`                  | Base grade-A threshold (adaptive adjusts it) |
| `SCANNER_RTH_ONLY`    | `false`               | `true` = RTH only, `false` = 24/7 (default) |

> **Symbol note:** Alpaca uses `@NQ.C.0` for the continuous NQ E-mini contract
> and `@MNQ.C.0` for the Micro NQ. Confirm the exact symbol in
> [Alpaca's asset search](https://alpaca.markets/docs/api-references/market-data-api/stock-pricing-data/historical/).

### Running the scanner

**Local / VPS:**
```bash
npm run scan        # production
npm run scan:dev    # auto-restart on file changes (Node 18+)
```

With PM2 (recommended for VPS so it restarts on crash):
```bash
pm2 start scanner.js --name nq-scanner
pm2 save
```

**Railway:** add a second service in the same project pointing at `scanner.js`
as the start command, with the same environment variables.

**Render:** add a Background Worker service alongside the web service.

### Adaptive learning

Once you have logged at least 10 outcomes via the dashboard, the scanner starts
adjusting its own thresholds automatically:

| Setup win rate (last 30 days) | Score adjustment  |
|-------------------------------|-------------------|
| ≥ 70 %                        | −2 (fire more)    |
| 40 – 69 %                     | 0 (no change)     |
| ≤ 40 %                        | +4 (be selective) |

When the last 15 trades show a ≤ 38 % win rate (choppy regime), an additional
+2 is added to all thresholds.

View the current learning state:
```bash
curl https://<your-domain>/api/learning
```

---

## ntfy Push Notifications

Every incoming signal fires a push notification to your phone or desktop via [ntfy](https://ntfy.sh).

### Setup (2 minutes)

1. Install the **ntfy** app on iOS or Android (free, open source)
2. Choose a topic name — something unique like `nq-signals-abc123`
3. Subscribe to that topic in the app
4. Set the `NTFY_TOPIC` environment variable on your server to the same name

### Notification format

Each alert shows:

```
▲ LONG A+  •  NQ1!
Setup:   OTE+STDV
Entry:   21050.25
SL:      21025.25
TP1:     21075.25
TP2:     21100.25
TP3:     21125.25
Score:   28
Win%:    74%
Session: NY Open ★
```

- A+ signals arrive as **urgent** (max priority — bypasses Do Not Disturb)
- A signals arrive as **high** priority
- Green circle + chart emoji for LONG, red for SHORT

### Private topics (optional)

Public topics on ntfy.sh are readable by anyone who knows the name.
For privacy, either:
- Use a long random topic name (hard to guess), or
- Create a free ntfy.sh account, set the topic to **access-token protected**,
  and set `NTFY_TOKEN=tk_xxxx...` in your env vars

### Self-hosted ntfy

Set `NTFY_URL=https://ntfy.yourdomain.com` to use your own ntfy server.

### Test the notification

```bash
curl -X POST https://<your-domain>/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your-secret" \
  -d '{"signal":"LONG","grade":"A+","setup":"OTE+STDV","ticker":"NQ1!",
       "entry":21050.25,"sl":21025.25,"tp1":21075.25,"tp2":21100.25,"tp3":21125.25,
       "score":28,"win_prob_tp1":74,"session":"NY Open ★"}'
```

Your phone should buzz within a second.

---

## Verify It's Working

```bash
# Dashboard loads
curl -I https://<your-domain>/
# → HTTP/2 200

# Test webhook
curl -X POST https://<your-domain>/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your-secret" \
  -d '{
    "signal":"LONG","grade":"A+","setup":"OTE+STDV",
    "ticker":"NQ1!","timeframe":"3","entry":21050.25,
    "sl":21025.25,"tp1":21075.25,"tp2":21100.25,"tp3":21125.25,
    "score":28,"win_prob_tp1":74,"win_prob_tp2":53,"win_prob_tp3":37,
    "htf_bias":"BULL ▲","session":"NY Open ★"
  }'
# → {"ok":true,"id":1}

# Stats API
curl https://<your-domain>/api/stats
```

Open the dashboard — the test signal card should appear.

---

## TradingView Alert Configuration

See `tradingview-alerts.txt` for exact JSON templates to paste into each
alert's **Message** box, including the advanced `alert()` approach that
embeds live SL/TP levels directly from the Pine Script.

---

## Local Development

```bash
npm install
npm start          # node server.js  →  http://localhost:3000
npm run dev        # node --watch server.js  (auto-restart, Node 18+)
```
