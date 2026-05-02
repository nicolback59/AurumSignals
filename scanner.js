'use strict';

const Database            = require('better-sqlite3');
const path                = require('path');
const fs                  = require('fs');
const WebSocket           = require('ws');
const { computeSignal }   = require('./signal-engine');
const { getAdaptiveMinScore, getMarketRegime } = require('./learning');
const { runBacktest }     = require('./backtest-engine');
const { getParams, saveBacktestRun, proposeRevision, evaluateShadow } = require('./strategy-params');

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH        = process.env.DB_PATH          || path.join(__dirname, 'signals.db');
const NTFY_URL       = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC     = process.env.NTFY_TOPIC       || '';
const NTFY_TOKEN     = process.env.NTFY_TOKEN       || '';
const ALPACA_KEY     = process.env.ALPACA_KEY        || '';
const ALPACA_SECRET  = process.env.ALPACA_SECRET     || '';
const SYMBOL         = process.env.SCANNER_SYMBOL    || '@NQ.C.0';
const COOLDOWN       = parseInt(process.env.SCANNER_COOLDOWN || '3');
const RTH_ONLY       = process.env.SCANNER_RTH_ONLY === 'true';
const BASE_SCORE     = parseInt(process.env.SCANNER_MIN_SCORE || '16');
// Intrabar check debounce (ms) — run signal check at most this often on ticks
const TICK_DEBOUNCE  = parseInt(process.env.TICK_DEBOUNCE_MS || '5000');
// Backtest symbols per instrument
const BT_SYMBOLS = {
  MNQ: process.env.SCANNER_BT_MNQ || '@MNQ.C.0',
  MGC: process.env.SCANNER_BT_MGC || '@MGC.C.0',
};
const BT_INTERVAL_H  = parseFloat(process.env.BACKTEST_INTERVAL_H  || '4');
const BT_BARS        = parseInt(process.env.BACKTEST_BARS           || '3000');

// ── Database ──────────────────────────────────────────────────────────────────
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, entry, sl, tp1, tp2, tp3,
     score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session, raw_payload)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session, @raw_payload)
`);

const upsertPrice = db.prepare(`
  INSERT INTO market_snapshots (symbol, price, open_price, change_pct, high_24h, low_24h, snapped_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(symbol) DO UPDATE SET
    price      = excluded.price,
    open_price = excluded.open_price,
    change_pct = excluded.change_pct,
    high_24h   = excluded.high_24h,
    low_24h    = excluded.low_24h,
    snapped_at = excluded.snapped_at
`);

// ── ntfy ──────────────────────────────────────────────────────────────────────
function sendNtfySystem(title, body, priority = 'default') {
  if (!NTFY_TOPIC) return;
  const headers = {
    'Content-Type': 'text/plain',
    'Title':    title,
    'Priority': priority,
    'Tags':     'warning',
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy]', err.message));
}

function sendNtfy(s) {
  if (!NTFY_TOPIC) return;
  const arrow    = s.direction === 'LONG' ? '▲' : '▼';
  const priority = s.grade === 'A+' ? 'urgent' : 'high';
  const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';
  const body = [
    s.setup             ? `Setup:   ${s.setup}`          : null,
    s.entry   != null   ? `Entry:   ${s.entry}`          : null,
    s.sl      != null   ? `SL:      ${s.sl}`             : null,
    s.tp1     != null   ? `TP1:     ${s.tp1}`            : null,
    s.tp2     != null   ? `TP2:     ${s.tp2}`            : null,
    s.tp3     != null   ? `TP3:     ${s.tp3}`            : null,
    s.score   != null   ? `Score:   ${s.score}`          : null,
    s.win_prob_tp1 != null ? `Win%:  ${s.win_prob_tp1}%` : null,
    s.session           ? `Session: ${s.session}`        : null,
  ].filter(Boolean).join('\n');
  const headers = {
    'Content-Type': 'text/plain',
    'Title': `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker}`,
    'Priority': priority,
    'Tags':     tags,
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy]', err.message));
}

// ── Market data (Alpaca REST — for warmup + backtest) ─────────────────────────
async function fetchBarsRest(symbol, timeframe, limit) {
  const url = `https://data.alpaca.markets/v1beta1/futures/bars`
    + `?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
    },
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.bars?.[symbol] ?? []).map(b => ({
    timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

async function fetchAllBars(symbol, timeframe, maxBars) {
  let all = [], pageToken = null;
  while (all.length < maxBars) {
    const limit = Math.min(1000, maxBars - all.length);
    let url = `https://data.alpaca.markets/v1beta1/futures/bars`
      + `?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } });
    if (!res.ok) break;
    const json = await res.json();
    const bars = (json.bars?.[symbol] ?? []).map(b => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    all.push(...bars);
    pageToken = json.next_page_token ?? null;
    if (!pageToken || bars.length === 0) break;
  }
  return all.slice(-maxBars);
}

function savePrice(symbol, bars) {
  if (!bars || bars.length < 2) return;
  const last  = bars[bars.length - 1];
  const first = bars[0];
  const chg   = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
  const high  = Math.max(...bars.map(b => b.high));
  const low   = Math.min(...bars.map(b => b.low));
  upsertPrice.run(symbol, last.close, first.open, +chg.toFixed(3), high, low);
}

// ── Bar buffer ────────────────────────────────────────────────────────────────
// Keeps a rolling window of 1m and 15m bars fed by WebSocket events.
const BUFFER_1M  = 200;  // enough for signal engine warmup
const BUFFER_15M = 80;

const bars1m  = [];   // newest at end
const bars15m = [];

function pushBar(arr, bar, maxLen) {
  // Replace last bar if same timestamp (update), otherwise append
  if (arr.length > 0 && arr[arr.length - 1].timestamp === bar.timestamp) {
    arr[arr.length - 1] = bar;
  } else {
    arr.push(bar);
    if (arr.length > maxLen) arr.shift();
  }
}

// Aggregate 1m bars into synthetic 15m bars after each closed 1m bar
function rebuild15m() {
  bars15m.length = 0;
  for (let i = 0; i < bars1m.length; i++) {
    const b = bars1m[i];
    const ts = new Date(b.timestamp);
    // Align to 15m boundary
    const mins = ts.getUTCMinutes();
    const floored = new Date(ts);
    floored.setUTCMinutes(Math.floor(mins / 15) * 15, 0, 0);
    const key = floored.toISOString();
    const last = bars15m[bars15m.length - 1];
    if (last && last.timestamp === key) {
      last.high   = Math.max(last.high, b.high);
      last.low    = Math.min(last.low,  b.low);
      last.close  = b.close;
      last.volume += b.volume;
    } else {
      bars15m.push({ timestamp: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
      if (bars15m.length > BUFFER_15M) bars15m.shift();
    }
  }
}

// ── Risk controls ─────────────────────────────────────────────────────────────
const DAILY_SIGNAL_LIMIT = 10;
const LOSS_PAUSE_MS      = 30 * 60_000;  // 30 minutes

let lastSignalTime      = 0;
let lastTickCheck       = 0;
let pauseUntil          = 0;    // suppress signals until this timestamp
let lastPausedOutcomeId = 0;    // prevents re-triggering pause on same loss pair
let dailyHaltDate       = '';   // 'YYYY-MM-DD' when daily limit was hit

const qConsecutiveLosses = db.prepare(`
  SELECT o.signal_id, o.result
  FROM   outcomes o
  JOIN   signals  s ON s.id = o.signal_id
  ORDER  BY s.received_at DESC
  LIMIT  2
`);

const qTodaySignals = db.prepare(`
  SELECT COUNT(*) AS n FROM signals
  WHERE  received_at >= date('now')
`);

function checkConsecutiveLosses() {
  const rows = qConsecutiveLosses.all();
  if (rows.length < 2) return 0;
  return (rows[0].result === 'LOSS' && rows[1].result === 'LOSS')
    ? rows[0].signal_id
    : 0;
}

function trySignal(source) {
  if (bars1m.length < 60 || bars15m.length < 10) return;

  const now = Date.now();

  // ── Daily trade limit ──────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  if (qTodaySignals.get().n >= DAILY_SIGNAL_LIMIT) {
    if (dailyHaltDate !== today) {
      dailyHaltDate = today;
      console.log(`[${ts()}] Daily limit (${DAILY_SIGNAL_LIMIT} signals) reached — halted for today`);
      sendNtfySystem(
        '🛑 Daily Limit Reached',
        `${DAILY_SIGNAL_LIMIT} signals fired today.\nNo more signals until tomorrow (UTC midnight).`,
        'high'
      );
    }
    return;
  }
  if (dailyHaltDate === today) dailyHaltDate = ''; // new day, reset

  // ── Consecutive-loss break ─────────────────────────────────────────────────
  if (now < pauseUntil) {
    if (source === 'bar') {
      const remaining = Math.ceil((pauseUntil - now) / 60_000);
      console.log(`[${ts()}] Paused after 2 losses — ${remaining}min remaining`);
    }
    return;
  }
  if (pauseUntil > 0) pauseUntil = 0; // break just ended

  const lossId = checkConsecutiveLosses();
  if (lossId && lossId !== lastPausedOutcomeId) {
    lastPausedOutcomeId = lossId;
    pauseUntil = now + LOSS_PAUSE_MS;
    console.log(`[${ts()}] 2 consecutive losses — pausing signals for 30 minutes`);
    sendNtfySystem(
      '⏸ 30-Min Signal Pause',
      '2 consecutive losses detected.\nPausing for 30 minutes to self-assess.\nSignals resume automatically.',
      'high'
    );
    return;
  }

  // ── Bar cooldown ───────────────────────────────────────────────────────────
  if (now - lastSignalTime < COOLDOWN * 60_000) return;

  const signal = computeSignal(bars1m, bars15m, { rthOnly: RTH_ONLY, minScore: 12 });
  if (!signal) return;

  const minScore = getAdaptiveMinScore(db, signal.setup, BASE_SCORE);
  if (signal.score < minScore) {
    console.log(`[${ts()}][${source}] Suppressed ${signal.setup} (score=${signal.score} < adaptive=${minScore})`);
    return;
  }

  lastSignalTime = now;

  const info = insertSignal.run({
    ticker: signal.ticker, timeframe: signal.timeframe, direction: signal.direction,
    grade: signal.grade, setup: signal.setup, entry: signal.entry, sl: signal.sl,
    tp1: signal.tp1, tp2: signal.tp2, tp3: signal.tp3, score: signal.score,
    win_prob_tp1: signal.win_prob_tp1, win_prob_tp2: signal.win_prob_tp2,
    win_prob_tp3: signal.win_prob_tp3, htf_bias: signal.htf_bias,
    session: signal.session, raw_payload: JSON.stringify(signal),
  });

  const dayCount = qTodaySignals.get().n;
  console.log(
    `[${ts()}][${source}] SIGNAL #${info.lastInsertRowid} | ${signal.direction} ${signal.grade} | ` +
    `${signal.setup} | score=${signal.score}/${minScore} | entry=${signal.entry} | ` +
    `today=${dayCount}/${DAILY_SIGNAL_LIMIT} | regime=${getMarketRegime(db)}`
  );
  sendNtfy(signal);

  // Notify when approaching daily limit
  if (dayCount >= DAILY_SIGNAL_LIMIT - 1) {
    sendNtfySystem(
      '⚠️ Last Signal Today',
      `Signal #${dayCount} of ${DAILY_SIGNAL_LIMIT} fired. Daily limit reached — halting until tomorrow.`,
      'default'
    );
  }
}

// ── Alpaca WebSocket streaming ────────────────────────────────────────────────
const WS_URL = 'wss://stream.data.alpaca.markets/v1beta1/futures';
let ws = null;
let reconnectDelay = 2000;
let connected = false;

async function warmupBars() {
  try {
    console.log(`[${ts()}] Fetching warmup bars from REST…`);
    const warmup1m  = await fetchBarsRest(SYMBOL, '1Min',  BUFFER_1M);
    const warmup15m = await fetchBarsRest(SYMBOL, '15Min', BUFFER_15M);
    for (const b of warmup1m)  pushBar(bars1m,  b, BUFFER_1M);
    for (const b of warmup15m) pushBar(bars15m, b, BUFFER_15M);
    if (warmup1m.length) savePrice(SYMBOL, warmup1m);
    console.log(`[${ts()}] Warmup: ${bars1m.length} 1m bars, ${bars15m.length} 15m bars loaded`);
  } catch (err) {
    console.error(`[${ts()}] Warmup error:`, err.message);
  }
}

function connectWS() {
  if (!ALPACA_KEY) {
    console.warn(`[${ts()}] ALPACA_KEY not set — WebSocket disabled`);
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log(`[${ts()}] WS connected`);
    reconnectDelay = 2000;
    ws.send(JSON.stringify({ action: 'auth', key: ALPACA_KEY, secret: ALPACA_SECRET }));
  });

  ws.on('message', raw => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msgs)) msgs = [msgs];

    for (const msg of msgs) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log(`[${ts()}] WS authenticated — subscribing to ${SYMBOL}`);
        ws.send(JSON.stringify({
          action: 'subscribe',
          bars:        [SYMBOL],
          updatedBars: [SYMBOL],
        }));
        connected = true;
      }

      if (msg.T === 'error') {
        console.error(`[${ts()}] WS error msg [${msg.code}]: ${msg.msg}`);
      }

      // Closed 1m bar — run signal check immediately
      if (msg.T === 'b' && msg.S === SYMBOL) {
        const bar = { timestamp: msg.t, open: msg.o, high: msg.h, low: msg.l, close: msg.c, volume: msg.v };
        pushBar(bars1m, bar, BUFFER_1M);
        rebuild15m();
        // Update price snapshot
        if (bars1m.length >= 2) savePrice(SYMBOL, bars1m);
        trySignal('bar');
      }

      // Intrabar tick update — debounced signal check
      if (msg.T === 'u' && msg.S === SYMBOL) {
        const bar = { timestamp: msg.t, open: msg.o, high: msg.h, low: msg.l, close: msg.c, volume: msg.v };
        pushBar(bars1m, bar, BUFFER_1M);
        rebuild15m();
        // Update price snapshot on every tick so market prices API stays fresh
        if (bars1m.length >= 2) savePrice(SYMBOL, bars1m);
        const now = Date.now();
        if (now - lastTickCheck >= TICK_DEBOUNCE) {
          lastTickCheck = now;
          trySignal('tick');
        }
      }
    }
  });

  ws.on('close', (code, reason) => {
    connected = false;
    console.warn(`[${ts()}] WS closed (${code}): ${reason} — reconnecting in ${reconnectDelay / 1000}s`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      connectWS();
    }, reconnectDelay);
  });

  ws.on('error', err => {
    console.error(`[${ts()}] WS error:`, err.message);
    // close event will fire next and trigger reconnect
  });
}

// ── Backtest cycle ────────────────────────────────────────────────────────────
async function runBacktestCycle(instrument, triggeredBy = 'scheduled') {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] BACKTEST START: ${instrument} (${symbol}, ${BT_BARS} bars)`);

    const pendingShadow = db.prepare(
      `SELECT id FROM strategy_revisions WHERE instrument=? AND status='shadow' LIMIT 1`
    ).get(instrument);

    if (pendingShadow) {
      const barsForShadow = await fetchAllBars(symbol, '1Min', BT_BARS);
      if (barsForShadow.length >= 100) {
        savePrice(symbol, barsForShadow);
        const result = evaluateShadow(db, instrument, barsForShadow);
        if (result?.promoted) {
          console.log(`[${ts()}] REVISION PROMOTED: ${instrument} ${(result.before*100).toFixed(1)}% → ${(result.after*100).toFixed(1)}%`);
        } else if (result) {
          console.log(`[${ts()}] Shadow discarded for ${instrument}`);
        }
      }
      return;
    }

    const bars1mBT = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1mBT.length < 100) {
      console.log(`[${ts()}] BACKTEST SKIP: insufficient bars (${bars1mBT.length})`);
      return;
    }

    savePrice(symbol, bars1mBT);

    const params  = getParams(db, instrument);
    const { metrics } = runBacktest(bars1mBT, params, { cooldown: 1 });
    metrics.barsScanned = bars1mBT.length;

    const runId = saveBacktestRun(db, instrument, params, metrics, triggeredBy);
    console.log(
      `[${ts()}] BACKTEST DONE: ${instrument} | trades=${metrics.tradeCount} | ` +
      `win=${(metrics.winRate*100).toFixed(1)}% | sharpe=${metrics.sharpe} | ` +
      `pf=${metrics.profitFactor} | bars=${bars1mBT.length} | run#${runId}`
    );

    const best = proposeRevision(db, instrument, bars1mBT, runId);
    if (best) {
      console.log(
        `[${ts()}] SHADOW CANDIDATE: ${instrument} win_rate ` +
        `${(metrics.winRate*100).toFixed(1)}% → ${(best.metrics.winRate*100).toFixed(1)}%`
      );
    }

  } catch (err) {
    console.error(`[${ts()}] Backtest error (${instrument}):`, err.message);
  }
}

function ts() { return new Date().toISOString(); }

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('NQ Signal Pro V3 — Scanner + Backtest Engine');
console.log(`Live symbol: ${SYMBOL} | Mode: WebSocket streaming | RTH-only: ${RTH_ONLY}`);
console.log(`Tick debounce: ${TICK_DEBOUNCE}ms | Signal cooldown: ${COOLDOWN} bars`);
console.log(`Backtests: every ${BT_INTERVAL_H}h | Bars: ${BT_BARS} | Instruments: MNQ, MGC`);
if (!ALPACA_KEY)  console.warn('WARNING: ALPACA_KEY not set — all market data disabled');
if (!NTFY_TOPIC)  console.warn('WARNING: NTFY_TOPIC not set — push notifications disabled');

// Load historical bars first, then open WebSocket
if (ALPACA_KEY) {
  warmupBars().then(() => {
    connectWS();
    // Initial signal check once warmup completes
    trySignal('startup');
  });

  // Warmup backtest on startup (staggered to avoid hammering Alpaca)
  setTimeout(() => runBacktestCycle('MNQ', 'startup'), 10_000);
  setTimeout(() => runBacktestCycle('MGC', 'startup'), 40_000);
}

// Backtest cycle (MNQ and MGC staggered by half the interval)
const BT_MS = BT_INTERVAL_H * 3_600_000;
setInterval(() => runBacktestCycle('MNQ'), BT_MS);
setInterval(() => runBacktestCycle('MGC'), BT_MS + BT_MS / 2);
