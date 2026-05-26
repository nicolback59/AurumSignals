'use strict';

/**
 * REGIME AGENT WORKER
 *
 * Persistent PM2 process — classifies market regime every 15 minutes.
 * Reads 5m bar cache written by scanner-worker, writes to regime_states table.
 * The signal gatekeeper and adaptive cooldown read from regime_states to get
 * proper TREND_BULL/TREND_BEAR context instead of the crude outcome-WR approach.
 *
 * Regime vocabulary:
 *   TREND_BULL   — EMAs aligned up, strong directional efficiency, HH structure
 *   TREND_BEAR   — EMAs aligned down, strong directional efficiency, LL structure
 *   EXPANSION    — ATR expanding fast, direction not yet determined
 *   NORMAL       — baseline conditions, no strong signal either way
 *   COMPRESSION  — ATR contracting, low volatility, likely coiling for breakout
 *   SOFT_CHOP    — low directional efficiency, moderate oscillation
 *   RANGE_CHOP   — tight range + very low efficiency — hard stop for both strategies
 *   UNKNOWN      — insufficient bar data (off-hours or scanner not yet running)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME    = 'regime-agent';
const INSTRUMENTS    = ['MNQ', 'MGC'];
const INTERVAL_MS    = 15 * 60 * 1000; // 15 minutes
const MIN_BARS       = 30;
const STALE_BARS_MS  = 45 * 60 * 1000; // bars older than 45 min = market closed
const HISTORY_DAYS   = 7;              // keep 7 days of regime_states

const db = openDb();
heartbeat(db, WORKER_NAME, 'STARTING', { pid: process.pid });

// ── Prepared statements ───────────────────────────────────────────────────────
const _getBars = db.prepare(
  'SELECT bars_5m, updated_at FROM bar_cache WHERE instrument = ?'
);
const _insertRegime = db.prepare(`
  INSERT INTO regime_states
    (instrument, regime, strength, atr_percentile, ema_slope, classified_at, raw_indicators)
  VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
`);
const _pruneOld = db.prepare(
  `DELETE FROM regime_states WHERE classified_at < datetime('now', '-${HISTORY_DAYS} days')`
);

// ── EMA calculation ────────────────────────────────────────────────────────────
function calcEma(values, period) {
  if (values.length < period) return [];
  const k   = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ── Core regime classifier ────────────────────────────────────────────────────
function classifyRegime(bars) {
  if (!bars || bars.length < MIN_BARS) return null;

  const n      = bars.length - 1;
  const closes = bars.map(b => b.close);
  const period = 14;

  // True range + ATR
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low :
    Math.max(b.high - b.low,
             Math.abs(b.high - bars[i - 1].close),
             Math.abs(b.low  - bars[i - 1].close))
  );
  const recentTr  = tr.slice(-period);
  const prevTr    = tr.slice(-(period * 2), -period);
  const recentATR = recentTr.reduce((a, b) => a + b, 0) / period;
  const prevATR   = prevTr.length >= period
    ? prevTr.reduce((a, b) => a + b, 0) / period
    : recentATR;
  const atrRatio  = prevATR > 0 ? recentATR / prevATR : 1;

  // ATR percentile: where current ATR sits in the distribution of last 100 bars
  const allTr     = tr.slice(-100);
  const sorted    = [...allTr].sort((a, b) => a - b);
  const rankIdx   = sorted.findIndex(v => v >= recentATR);
  const atrPct    = sorted.length > 0 ? (rankIdx < 0 ? 1 : rankIdx / sorted.length) : 0.5;

  // Directional efficiency: net move / gross path over last period bars
  const window    = bars.slice(-period);
  const netMove   = Math.abs(window[window.length - 1].close - window[0].close);
  const grossMove = window.reduce(
    (s, b, i) => i === 0 ? s : s + Math.abs(b.close - window[i - 1].close), 0
  );
  const dirEff    = grossMove > 0 ? netMove / grossMove : 0;

  // Higher-high / lower-low structure
  let hhCount = 0, llCount = 0;
  for (let k = 1; k < window.length; k++) {
    if (window[k].high > window[k - 1].high) hhCount++;
    if (window[k].low  < window[k - 1].low)  llCount++;
  }
  const bullStructure = hhCount > period * 0.6;
  const bearStructure = llCount > period * 0.6;

  // EMA stack for directional bias
  const ema9Arr  = calcEma(closes, 9);
  const ema21Arr = calcEma(closes, 21);
  const ema9  = ema9Arr[n];
  const ema21 = ema21Arr[n];

  // EMA21 5-bar slope (normalized by ATR)
  const slopeWindow = 5;
  const emaSlope    = ema21 != null && ema21Arr[n - slopeWindow] != null && recentATR > 0
    ? (ema21 - ema21Arr[n - slopeWindow]) / (slopeWindow * recentATR)
    : 0;

  // ── Classification ───────────────────────────────────────────────────────────
  let regime   = 'NORMAL';
  let strength = 0.5;

  if (atrRatio > 1.6) {
    // Volatility explosion — news/event/spike
    regime   = 'EXPANSION';
    strength = Math.min(1, (atrRatio - 1) / 1.2);
  } else if (atrRatio < 0.65 && dirEff < 0.25) {
    // Tight range, no direction — HARD STOP for both strategies
    regime   = 'RANGE_CHOP';
    strength = 0.85;
  } else if (atrRatio < 0.80 && dirEff < 0.35) {
    // Contracting volatility — coiling
    regime   = 'COMPRESSION';
    strength = 0.65;
  } else if (dirEff > 0.42) {
    // Strong directional move — determine bull vs bear
    if (ema9 != null && ema21 != null && ema9 > ema21 && bullStructure) {
      regime   = 'TREND_BULL';
      strength = Math.min(1, dirEff * 1.8);
    } else if (ema9 != null && ema21 != null && ema9 < ema21 && bearStructure) {
      regime   = 'TREND_BEAR';
      strength = Math.min(1, dirEff * 1.8);
    } else {
      // Strong move but EMAs not yet confirmed — expansion
      regime   = 'EXPANSION';
      strength = 0.65;
    }
  } else if (dirEff < 0.28) {
    // Low efficiency — choppy but not tight range
    regime   = 'SOFT_CHOP';
    strength = 0.7;
  } else {
    regime   = 'NORMAL';
    strength = 0.5;
  }

  return {
    regime,
    strength:      +strength.toFixed(3),
    atrPercentile: +atrPct.toFixed(3),
    emaSlope:      +emaSlope.toFixed(4),
    raw: {
      atrRatio:      +atrRatio.toFixed(3),
      dirEfficiency: +dirEff.toFixed(3),
      hhCount,
      llCount,
      ema9:  ema9  != null ? +ema9.toFixed(2)  : null,
      ema21: ema21 != null ? +ema21.toFixed(2) : null,
      atr:   +recentATR.toFixed(2),
    },
  };
}

// ── Cycle ─────────────────────────────────────────────────────────────────────
function runCycle() {
  const start = Date.now();
  const results = {};

  for (const instrument of INSTRUMENTS) {
    try {
      const row = _getBars.get(instrument);
      if (!row?.bars_5m) {
        console.log(`[${WORKER_NAME}] ${instrument}: no bar cache — market likely closed`);
        continue;
      }

      const barAgeMs = Date.now() - new Date(row.updated_at).getTime();
      if (barAgeMs > STALE_BARS_MS) {
        console.log(`[${WORKER_NAME}] ${instrument}: bars stale (${Math.round(barAgeMs / 60000)}m old) — skipping`);
        continue;
      }

      const bars   = JSON.parse(row.bars_5m);
      const result = classifyRegime(bars);
      if (!result) {
        console.log(`[${WORKER_NAME}] ${instrument}: insufficient bars (${bars.length}) — need ${MIN_BARS}`);
        continue;
      }

      _insertRegime.run(
        instrument,
        result.regime,
        result.strength,
        result.atrPercentile,
        result.emaSlope,
        JSON.stringify(result.raw)
      );

      results[instrument] = result.regime;
      console.log(
        `[${WORKER_NAME}] ${instrument}: ${result.regime} ` +
        `(strength=${result.strength} ATRr=${result.raw.atrRatio} dirEff=${result.raw.dirEfficiency})`
      );
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${instrument} classify error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  // Prune old history
  try { _pruneOld.run(); } catch (_) {}

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'IDLE', {
    pid:             process.pid,
    lastRun:         new Date().toISOString(),
    regimes:         results,
    cycleDurationMs: Date.now() - start,
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[${WORKER_NAME}] Started — classifying every ${INTERVAL_MS / 60000} min`);
runCycle();
setInterval(runCycle, INTERVAL_MS);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    heartbeat(db, WORKER_NAME, 'STOPPED', {});
    process.exit(0);
  });
}
