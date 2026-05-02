'use strict';

const Database           = require('better-sqlite3');
const path               = require('path');
const fs                 = require('fs');
const { computeSignal }  = require('./signal-engine');
const { getAdaptiveMinScore, getMarketRegime } = require('./learning');

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH       = process.env.DB_PATH         || path.join(__dirname, 'signals.db');
const NTFY_URL      = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC    = process.env.NTFY_TOPIC      || '';
const NTFY_TOKEN    = process.env.NTFY_TOKEN      || '';
const ALPACA_KEY    = process.env.ALPACA_KEY       || '';
const ALPACA_SECRET = process.env.ALPACA_SECRET    || '';
// Alpaca continuous NQ futures contract — verify symbol at docs.alpaca.markets
const SYMBOL        = process.env.SCANNER_SYMBOL   || '@NQ.C.0';
const SCAN_INTERVAL = (parseInt(process.env.SCAN_INTERVAL || '60')) * 1000;
const COOLDOWN      = parseInt(process.env.SCANNER_COOLDOWN  || '3');
const RTH_ONLY      = process.env.SCANNER_RTH_ONLY === 'true';  // default: 24/7
const BASE_SCORE    = parseInt(process.env.SCANNER_MIN_SCORE || '16');

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
    'Title':    `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker}`,
    'Priority': priority,
    'Tags':     tags,
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy]', err.message));
}

// ── Market data (Alpaca) ──────────────────────────────────────────────────────
async function fetchBars(timeframe, limit) {
  const url = `https://data.alpaca.markets/v1beta1/futures/bars`
    + `?symbols=${encodeURIComponent(SYMBOL)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.bars?.[SYMBOL] ?? []).map(b => ({
    timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

// ── Cooldown tracking ─────────────────────────────────────────────────────────
let lastSignalTime = 0;   // epoch ms of last fired signal
let scanCount      = 0;

// ── Scan loop ─────────────────────────────────────────────────────────────────
async function scan() {
  scanCount++;
  try {
    const [bars1m, bars15m] = await Promise.all([
      fetchBars('1Min',  120),
      fetchBars('15Min',  60),
    ]);

    if (bars1m.length < 60 || bars15m.length < 30) {
      console.log(`[${ts()}] Waiting for bars (${bars1m.length} 1m, ${bars15m.length} 15m)`);
      return;
    }

    // Cooldown: skip if fewer than COOLDOWN bar-lengths since last signal
    const barMs = 60_000;
    if (Date.now() - lastSignalTime < COOLDOWN * barMs) return;

    // Compute with a permissive floor; adaptive threshold applied below
    const signal = computeSignal(bars1m, bars15m, { rthOnly: RTH_ONLY, minScore: 12 });
    if (!signal) return;

    // Apply adaptive + regime-aware minimum score
    const minScore = getAdaptiveMinScore(db, signal.setup, BASE_SCORE);
    if (signal.score < minScore) {
      console.log(`[${ts()}] Suppressed ${signal.setup} (score=${signal.score} < adaptive min=${minScore})`);
      return;
    }

    lastSignalTime = Date.now();

    const info = insertSignal.run({
      ticker:       signal.ticker,
      timeframe:    signal.timeframe,
      direction:    signal.direction,
      grade:        signal.grade,
      setup:        signal.setup,
      entry:        signal.entry,
      sl:           signal.sl,
      tp1:          signal.tp1,
      tp2:          signal.tp2,
      tp3:          signal.tp3,
      score:        signal.score,
      win_prob_tp1: signal.win_prob_tp1,
      win_prob_tp2: signal.win_prob_tp2,
      win_prob_tp3: signal.win_prob_tp3,
      htf_bias:     signal.htf_bias,
      session:      signal.session,
      raw_payload:  JSON.stringify(signal),
    });

    const regime = getMarketRegime(db);
    console.log(
      `[${ts()}] SIGNAL #${info.lastInsertRowid} | ${signal.direction} ${signal.grade} | ` +
      `${signal.setup} | score=${signal.score}/${minScore} | entry=${signal.entry} | ` +
      `session=${signal.session} | regime=${regime}`
    );

    sendNtfy(signal);

  } catch (err) {
    console.error(`[${ts()}] Scan error:`, err.message);
  }
}

function ts() {
  return new Date().toISOString();
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('NQ Signal Pro V3 — Scanner');
console.log(`Symbol:   ${SYMBOL}`);
console.log(`Interval: ${SCAN_INTERVAL / 1000}s | Cooldown: ${COOLDOWN} bars | RTH-only: ${RTH_ONLY}`);
console.log(`Min score: ${BASE_SCORE} (adaptive learning active)`);
if (!ALPACA_KEY)  console.warn('WARNING: ALPACA_KEY not set — market data disabled');
if (!NTFY_TOPIC)  console.warn('WARNING: NTFY_TOPIC not set — push notifications disabled');

scan();
setInterval(scan, SCAN_INTERVAL);
