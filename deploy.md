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

| Variable         | Value                        | Notes                              |
|------------------|------------------------------|------------------------------------|
| `PORT`           | *(leave blank)*              | Railway injects this automatically |
| `DB_PATH`        | `/data/signals.db`           | Points into the persistent volume  |
| `WEBHOOK_SECRET` | `your-random-32-char-string` | Must match TradingView header      |

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
