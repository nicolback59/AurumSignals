# NQ Signal Pro — MNQ & MGC Futures Signal System

> **Paper trading only by default. No live orders are placed without explicit configuration.**

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  SQUARESPACE (public website)                                    │
│  ┌─────────────────────┐   ┌──────────────────────────────────┐  │
│  │  signal-dashboard   │   │  performance-widget              │  │
│  │  (HTML Code Block)  │   │  (HTML Code Block)               │  │
│  └────────┬────────────┘   └─────────────┬────────────────────┘  │
└───────────│─────────────────────────────│──────────────────────┘
            │  REST (HTTPS)               │  REST (HTTPS)
            ▼                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  RENDER.COM (backend service)                                    │
│                                                                  │
│  FastAPI application                                             │
│  ├── POST /webhook/tradingview    ← TradingView alert webhook    │
│  ├── GET  /signals                → Squarespace widget           │
│  ├── GET  /performance            → Squarespace widget           │
│  └── Background scheduler                                       │
│      ├── Every 5 min: resolve open paper trades (yfinance)       │
│      └── Daily 4AM: optimization insights                        │
│                                                                  │
│  PostgreSQL database (Render managed)                            │
│  ├── signals        — every signal received                      │
│  ├── paper_trades   — simulated trade tracking                   │
│  └── strategy_logs  — optimization insights (read-only)          │
└──────────────────────────────────────────────────────────────────┘
            ▲
            │  JSON webhook (HTTPS POST)
┌───────────┴─────────────┐
│  TRADINGVIEW            │
│  MGC Gold Scalper v3    │
│  NQ Pro Signal v4       │
│  (Pine Script alerts)   │
└─────────────────────────┘
```

**What runs where:**

| Component | Platform | Cost |
|-----------|----------|------|
| Public website | Squarespace | Your existing plan |
| Signal alerts | TradingView | Free/Pro |
| Backend API + DB | Render | Free tier → $7/mo starter |
| Market data | yfinance (Yahoo Finance) | Free |

---

## Strategies Implemented

### MGC Gold Scalper v3 (`pine_scripts/MGC_Gold_Scalper_v3.pine`)
- **Timeframe:** 5m or 15m on MGC1!
- **Risk:** SL=50 ticks, TP1–TP4 at 50/75/100/125 ticks ($50/$75/$100/$125 per contract)
- **5 Mandatory Gates:** HTF Momentum, VWAP Side, Regime, Candle Quality, RSI Zone
- **4 Setups:** EMA Pullback, VWAP Snap, Momentum Burst, Sweep Reverse
- **Signal grades:** A+ (score ≥85), A (≥72), B+ (≥60)

### NQ Pro Signal Engine v4 (`pine_scripts/NQ_Pro_Signal_Engine_v4.pine`)
- **Timeframe:** 5m on MNQ1!
- **Risk:** SL=25 pts, TP=75 pts full target
- **4-Factor Model:** HTF Bias, OTE Zone (61.8–78.6% Fibonacci), STDV Deviation, Confirmation
- **3 Setups:** OTE Pullback, STDV Reversal, OTE+STDV Combo

---

## Step-by-Step Build & Deploy Guide

### Phase 1 — Set Up TradingView Alerts (Start Here)

1. Add **MGC Gold Scalper v3** indicator to your MGC1! chart (5m or 15m).
2. Add **NQ Pro Signal Engine v4** to your MNQ1! chart (5m).
3. Click the alarm clock icon on the indicator → **Create Alert**.
4. Condition: select the indicator → choose `MGC BUY A`.
5. Notifications: tick **Webhook URL** → paste your Render URL (from Phase 2):
   ```
   https://YOUR-APP.onrender.com/webhook/tradingview
   ```
6. **Alert message** — paste this JSON in the message box:
   ```json
   {
     "secret": "YOUR_WEBHOOK_SECRET",
     "instrument": "MGC",
     "direction": "LONG",
     "entry": {{close}},
     "sl": 0,
     "tp1": 0,
     "grade": "A",
     "score": 80,
     "setup": "PB-EMA",
     "time": "{{timenow}}"
   }
   ```
   > For `MGC SELL A`, change `"direction": "SHORT"`.
   > For MNQ alerts, change `"instrument": "MNQ"`.
   > TradingView's `{{close}}` is replaced with the actual price at alert time.

7. Create four alerts total: MGC BUY, MGC SELL, MNQ BUY, MNQ SELL.

### Phase 2 — Deploy Backend to Render

1. **Fork this repository** to your GitHub account.
2. Go to [render.com](https://render.com) → sign up → **New → Blueprint Instance**.
3. Connect your GitHub repo. Render reads `backend/render.yaml` automatically.
4. Render creates the web service and PostgreSQL database.
5. In the Render dashboard → your service → **Environment** tab, set:
   ```
   WEBHOOK_SECRET  = (random string)
   DISCORD_WEBHOOK_URL = (optional)
   CORS_ORIGINS    = https://yoursite.squarespace.com
   ```
   Generate a secret: `python -c "import secrets; print(secrets.token_urlsafe(32))"`
6. Note your Render URL: `https://YOUR-APP.onrender.com`.

### Phase 3 — Embed Widgets in Squarespace

1. In Squarespace editor, add a **Code Block** to any page.
2. Open `squarespace/widgets/signal-dashboard.html`.
3. Replace `https://nq-signal-pro.onrender.com` with your Render URL.
4. Paste the entire HTML into the Code Block. Save.
5. Repeat with `squarespace/widgets/performance-widget.html` on your track record page.

### Phase 4 — Verify End-to-End

1. Check `https://YOUR-APP.onrender.com/health` → `{"status":"ok"}`.
2. Send a test signal manually:
   ```bash
   curl -X POST https://YOUR-APP.onrender.com/webhook/tradingview \
     -H "Content-Type: application/json" \
     -d '{
       "secret":"YOUR_SECRET",
       "instrument":"MGC",
       "direction":"LONG",
       "entry":2350.5,
       "sl":2345.5,
       "tp1":2355.5,
       "grade":"A",
       "score":78,
       "setup":"PB-EMA"
     }'
   ```
3. Check `GET /signals` — the test signal should appear.
4. Check `GET /performance` — stats update as paper trades resolve.
5. Confirm the Squarespace widget displays the signal.

---

## Local Development

```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env          # edit WEBHOOK_SECRET at minimum

uvicorn app.main:app --reload --port 8000
# API docs: http://localhost:8000/docs
```

---

## Project Structure

```
NQ-Signal-Pro-V3/
├── pine_scripts/
│   ├── MGC_Gold_Scalper_v3.pine       ← Add to TradingView MGC chart
│   └── NQ_Pro_Signal_Engine_v4.pine   ← Add to TradingView MNQ chart
│
├── backend/
│   ├── app/
│   │   ├── main.py                    ← FastAPI app + background scheduler
│   │   ├── config.py                  ← All settings (env vars)
│   │   ├── database.py                ← SQLAlchemy setup
│   │   ├── models.py                  ← Signal, PaperTrade, StrategyLog
│   │   ├── engines/
│   │   │   ├── indicators.py          ← EMA, ATR, RSI, VWAP (Pine-compatible)
│   │   │   ├── mgc_engine.py          ← MGC Scalper v3 — Python port
│   │   │   └── mnq_engine.py          ← NQ Pro v4 — Python port
│   │   ├── routers/
│   │   │   ├── webhook.py             ← POST /webhook/tradingview
│   │   │   ├── signals.py             ← GET /signals/*
│   │   │   └── performance.py         ← GET /performance/*
│   │   └── services/
│   │       ├── paper_trading.py       ← Open/resolve paper trades + stats
│   │       └── alerts.py              ← Discord, Slack, email dispatch
│   ├── requirements.txt
│   ├── render.yaml                    ← One-click Render deployment
│   ├── .env.example                   ← Template (copy to .env — never commit)
│   └── Dockerfile                     ← Optional Docker deployment
│
└── squarespace/
    └── widgets/
        ├── signal-dashboard.html      ← Live signal feed (embed as Code Block)
        └── performance-widget.html    ← Stats + equity curve (embed as Code Block)
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/webhook/tradingview` | Receive TradingView alert |
| `GET` | `/signals?instrument=MGC&limit=20` | Recent signals |
| `GET` | `/signals/latest` | Most recent signal |
| `GET` | `/signals/today` | Today's signals |
| `GET` | `/performance` | Win rate, TP hits, P&L |
| `GET` | `/performance/by-setup` | Stats per setup type |
| `GET` | `/performance/by-session` | Stats per trading session |
| `GET` | `/performance/trades` | Trade history |
| `GET` | `/performance/equity-curve` | Running P&L data points |
| `GET` | `/performance/insights` | Optimization loop findings |
| `GET` | `/health` | Health check |

Interactive docs at `/docs` (auto-generated Swagger UI).

---

## Optimization Loop (Human-Gated, Never Auto-Applied)

The daily background job (`4 AM UTC`) analyses closed paper trades and writes findings
to the `strategy_logs` table. It flags:
- Win rates below 45% (consider pausing or raising grade threshold)
- Profit factor below 1.0 (strong warning — review before continuing)
- Best and worst setup types (which to prioritise or disable)

Review insights at `GET /performance/insights`. **No changes are ever made automatically.**
All parameter adjustments require human action.

---

## Risk Warnings

### Futures Trading Risk
- MNQ and MGC are leveraged CME micro futures. **Losses can exceed your deposit.**
- 1 MNQ = ~$50,000 Nasdaq exposure. 1 MGC = 10 troy oz gold (~$23,000 exposure).
- Even with 1 contract, a single bad session can be -$150 to -$500.

### Paper Trading First — Always
- This system defaults to paper trading only. No broker API integration exists.
- **Paper trade for at least 3 months and 50+ signals before considering live trading.**
- Win rates on paper will differ from live trading due to slippage and execution.

### Backtesting Limitations
- TradingView backtests can overfit. The 75% win rate target shown in the MGC script
  is a backtest target, not a guarantee of live performance.
- Always evaluate signals on out-of-sample data (dates not used to develop the strategy).

### Compliance
- Publicly sharing trade signals for profit may require CFTC/NFA registration (USA).
- Consult a licensed compliance attorney before charging subscriptions.
- This code is for personal research and education only.

---

## Recommended Tools

| Purpose | Tool | Notes |
|---------|------|-------|
| Signal generation | TradingView | Pine Scripts already written |
| Backend hosting | Render | Free tier to start |
| Database | Render PostgreSQL | Free 90-day; upgrade for production |
| Market data | yfinance | Free Yahoo Finance data |
| Live futures data | Polygon.io | $29/mo — upgrade when ready |
| Website | Squarespace | Code Blocks for widget embed |
| Alerts | Discord Webhooks | Free, instant |
| Email alerts | SendGrid | 100 emails/day free |
| Live trading (future) | Tradovate / IBKR | Requires separate setup |

---

## Questions to Answer Before Live Trading

1. What is your starting account size? (Minimum $5,000 recommended for 1 MNQ contract)
2. Which broker will you use? (Tradovate, Interactive Brokers, NinjaTrader, Apex?)
3. What is your maximum daily loss limit? (Suggest: 2% of account)
4. How long will you paper trade before going live? (Suggest: 3+ months, 50+ signals)
5. Do you understand CME micro futures margin requirements?
6. Will you use your own capital or a prop/funded account?
