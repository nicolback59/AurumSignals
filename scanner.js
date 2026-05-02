'use strict';

const Database            = require('better-sqlite3');
const path                = require('path');
const fs                  = require('fs');
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
// Live scanner symbol (NQ E-mini for signals)
const SYMBOL         = process.env.SCANNER_SYMBOL    || '@NQ.C.0';
const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL    || '60')  * 1000;
const COOLDOWN       = parseInt(process.env.SCANNER_COOLDOWN || '3');
const RTH_ONLY       = process.env.SCANNER_RTH_ONLY === 'true';
const BASE_SCORE     = parseInt(process.env.SCANNER_MIN_SCORE || '16');
// Backtest symbols per instrument
const BT_SYMBOLS = {
  MNQ: process.env.SCANNER_BT_MNQ || '@MNQ.C.0',
  MGC: process.env.SCANNER_BT_MGC || '@MGC.C.0',
};
// Backtest schedule (hours between cycles)
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

// ── Market data (Alpaca) ──────────────────────────────────────────────────────
async function fetchBarsForSymbol(symbol, timeframe, limit) {
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

// Paginated fetch for more historical data (accelerates learning)
async function fetchAllBars(symbol, timeframe, maxBars) {
  let all = [], pageToken = null;
  while (all.length < maxBars) {
    const limit  = Math.min(1000, maxBars - all.length);
    let url = `https://data.alpaca.markets/v1beta1/futures/bars`
      + `?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const res  = await fetch(url, { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } });
    if (!res.ok) break;
    const json = await res.json();
    const bars = (json.bars?.[symbol] ?? []).map(b => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    all.push(...bars);
    pageToken = json.next_page_token ?? null;
    if (!pageToken || bars.length === 0) break;
  }
  return all.slice(-maxBars);
}

// Save latest price snapshot for a symbol
function savePrice(symbol, bars) {
  if (!bars || bars.length < 2) return;
  const last  = bars[bars.length - 1];
  const first = bars[0];
  const chg   = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
  const high  = Math.max(...bars.map(b => b.high));
  const low   = Math.min(...bars.map(b => b.low));
  upsertPrice.run(symbol, last.close, first.open, +chg.toFixed(3), high, low);
}

// ── Cooldown tracking ─────────────────────────────────────────────────────────
let lastSignalTime = 0;
let scanCount      = 0;

// ── Live signal scan ──────────────────────────────────────────────────────────
async function scan() {
  scanCount++;
  try {
    const [bars1m, bars15m] = await Promise.all([
      fetchBarsForSymbol(SYMBOL, '1Min',  120),
      fetchBarsForSymbol(SYMBOL, '15Min',  60),
    ]);

    if (bars1m.length >= 2) savePrice(SYMBOL, bars1m);

    if (bars1m.length < 60 || bars15m.length < 30) {
      console.log(`[${ts()}] Waiting for bars (${bars1m.length} 1m, ${bars15m.length} 15m)`);
      return;
    }

    const barMs = 60_000;
    if (Date.now() - lastSignalTime < COOLDOWN * barMs) return;

    const signal = computeSignal(bars1m, bars15m, { rthOnly: RTH_ONLY, minScore: 12 });
    if (!signal) return;

    const minScore = getAdaptiveMinScore(db, signal.setup, BASE_SCORE);
    if (signal.score < minScore) {
      console.log(`[${ts()}] Suppressed ${signal.setup} (score=${signal.score} < adaptive=${minScore})`);
      return;
    }

    lastSignalTime = Date.now();

    const info = insertSignal.run({
      ticker: signal.ticker, timeframe: signal.timeframe, direction: signal.direction,
      grade: signal.grade, setup: signal.setup, entry: signal.entry, sl: signal.sl,
      tp1: signal.tp1, tp2: signal.tp2, tp3: signal.tp3, score: signal.score,
      win_prob_tp1: signal.win_prob_tp1, win_prob_tp2: signal.win_prob_tp2,
      win_prob_tp3: signal.win_prob_tp3, htf_bias: signal.htf_bias,
      session: signal.session, raw_payload: JSON.stringify(signal),
    });

    console.log(
      `[${ts()}] SIGNAL #${info.lastInsertRowid} | ${signal.direction} ${signal.grade} | ` +
      `${signal.setup} | score=${signal.score}/${minScore} | entry=${signal.entry} | regime=${getMarketRegime(db)}`
    );
    sendNtfy(signal);

  } catch (err) {
    console.error(`[${ts()}] Scan error:`, err.message);
  }
}

// ── Backtest cycle ────────────────────────────────────────────────────────────
async function runBacktestCycle(instrument, triggeredBy = 'scheduled') {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] BACKTEST START: ${instrument} (${symbol}, ${BT_BARS} bars)`);

    // First: evaluate any pending shadow revision (uses current bars to re-validate)
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
      return; // One action per cycle: shadow eval or propose, not both
    }

    // Fetch historical bars
    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 100) {
      console.log(`[${ts()}] BACKTEST SKIP: insufficient bars (${bars1m.length})`);
      return;
    }

    savePrice(symbol, bars1m);

    // Backtest with current params
    const params  = getParams(db, instrument);
    const { metrics } = runBacktest(bars1m, params, { cooldown: 1 });
    metrics.barsScanned = bars1m.length;

    const runId = saveBacktestRun(db, instrument, params, metrics, triggeredBy);
    console.log(
      `[${ts()}] BACKTEST DONE: ${instrument} | trades=${metrics.tradeCount} | ` +
      `win=${(metrics.winRate*100).toFixed(1)}% | sharpe=${metrics.sharpe} | ` +
      `pf=${metrics.profitFactor} | bars=${bars1m.length} | run#${runId}`
    );

    // Propose better params via neighborhood search
    const best = proposeRevision(db, instrument, bars1m, runId);
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
console.log(`Live symbol: ${SYMBOL} | Scan: every ${SCAN_INTERVAL/1000}s | RTH-only: ${RTH_ONLY}`);
console.log(`Backtests: every ${BT_INTERVAL_H}h | Bars: ${BT_BARS} | Instruments: MNQ, MGC`);
if (!ALPACA_KEY)  console.warn('WARNING: ALPACA_KEY not set — all market data disabled');
if (!NTFY_TOPIC)  console.warn('WARNING: NTFY_TOPIC not set — push notifications disabled');

// Warmup backtest on startup (staggered to avoid hammering Alpaca)
if (ALPACA_KEY) {
  setTimeout(() => runBacktestCycle('MNQ', 'startup'), 5_000);
  setTimeout(() => runBacktestCycle('MGC', 'startup'), 35_000);
}

// Live scan
scan();
setInterval(scan, SCAN_INTERVAL);

// Backtest cycle (MNQ and MGC staggered by half the interval)
const BT_MS = BT_INTERVAL_H * 3_600_000;
setInterval(() => runBacktestCycle('MNQ'), BT_MS);
setInterval(() => runBacktestCycle('MGC'), BT_MS + BT_MS / 2);
