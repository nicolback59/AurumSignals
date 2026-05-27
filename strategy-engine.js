'use strict';

/**
 * STRATEGY ENGINE — unified signal evaluator
 *
 * This is the single source of truth for all trading logic.
 * The same functions are used by:
 *   • scanner.js           (live scanning)
 *   • backtest-engine.js   (historical backtesting)
 *   • server.js            (webhook signal ingestion)
 *
 * MGC scalp strategies now receive 30m and 45m confirmation bars in addition
 * to the existing 15m and 1h HTF layers.
 */

const mnqIntraday = require('./strategies/mnq-intraday');
const mgcScalp    = require('./strategies/mgc-scalp');
const nqNyOpen    = require('./strategies/nq-ny-open');

const {
  aggregate1mTo5m,
  aggregate5mTo15m,
  aggregate5mTo30m,
  aggregate5mTo45m,
  aggregate5mTo1h,
  aggregate1hTo4h,
  aggregate1hToDaily,
  aggregate15mTo1h,
  aggregateBars,
} = require('./strategies/shared-indicators');

const { THRESHOLDS } = require('./strategies/confidence-scorer');

module.exports.THRESHOLDS = THRESHOLDS;

/**
 * Evaluate all strategies against multi-timeframe bar sets.
 *
 * MGC bar sets now include 30m and 45m for confluence confirmation:
 *   bars30mMgc — 30-minute bars (6 × 5m) — intermediate trend check
 *   bars45mMgc — 45-minute bars (9 × 5m) — bridge between 30m and 1h
 *
 * @param {object} barSets
 * @param {object} cfg
 * @returns {object[]} array of signal objects
 */
function evaluateAll(barSets, cfg = {}) {
  const signals = [];
  const {
    bars5m = [], bars15m = [], bars1h = [], bars4h = [], barsDly = [],
    bars5mMgc = [], bars15mMgc = [], bars30mMgc = [], bars45mMgc = [], bars1hMgc = [],
    bars3mMgc = [],
  } = barSets;

  const instrument = cfg.instrument ?? null;
  const barIdx     = cfg.barIdx ?? null;

  // ── MNQ INTRADAY ─────────────────────────────────────────────────────────────
  if (instrument === 'MNQ' || instrument == null) {
    if (bars5m.length >= 60 && bars15m.length >= 30) {
      const sig = mnqIntraday.evaluate(bars5m, bars15m, bars1h, bars4h, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  // ── NQ NY OPEN ───────────────────────────────────────────────────────────────
  // One-trade-per-day opening auction model. barsDly passed via cfg so the strategy
  // can compute gap structure and prior-day context without changing the call signature.
  if (instrument === 'MNQ' || instrument == null) {
    if (bars5m.length >= 20) {
      const sig = nqNyOpen.evaluate(bars5m, bars15m, bars1h, bars4h, { ...cfg, barsDly }, barIdx);
      if (sig) signals.push(sig);
    }
  }

  // ── MGC SCALP ────────────────────────────────────────────────────────────────
  // bars3mMgc is the execution TF (preferred); falls back to bars5m inside the strategy.
  if (instrument === 'MGC' || instrument == null) {
    if (bars5mMgc.length >= 40 && bars15mMgc.length >= 20) {
      const sig = mgcScalp.evaluate(bars3mMgc ?? [], bars5mMgc, bars15mMgc, bars1hMgc, bars30mMgc, bars45mMgc, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  return signals;
}

function buildBarSetsFrom5m(bars5m) {
  const bars15m = aggregate5mTo15m(bars5m);
  const bars1h  = aggregate5mTo1h(bars5m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);
  return { bars5m, bars15m, bars1h, bars4h, barsDly };
}

function buildBarSetsFrom1m(bars1m) {
  const bars5m  = aggregate1mTo5m(bars1m);
  const bars15m = aggregate5mTo15m(bars5m);
  const bars1h  = aggregate5mTo1h(bars5m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);
  return { bars5m, bars15m, bars1h, bars4h, barsDly };
}

function buildBarSetsFrom15m(bars15m) {
  const bars5m  = bars15m;
  const bars1h  = aggregate15mTo1h(bars15m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);
  return { bars5m, bars15m, bars1h, bars4h, barsDly };
}

function resetAllStrategies() {
  mnqIntraday.reset();
  mgcScalp.reset();
  nqNyOpen.reset();
}

/**
 * Load macro blackout dates into NQ_NY_OPEN from the SQLite DB.
 * Call once at startup and once per day. Only HIGH-impact events block the trade.
 *
 * @param {import('better-sqlite3').Database} db
 */
function refreshNyOpenBlacklist(db) {
  try {
    const rows = db.prepare(
      `SELECT date_key FROM macro_calendar WHERE impact = 'HIGH' AND date_key >= date('now', '-1 day')`
    ).all();
    nqNyOpen.setBlackoutDates(rows.map(r => r.date_key));
  } catch {
    // macro_calendar table may not exist yet — safe to ignore
  }
}

const STRATEGY_META = {
  MNQ_INTRADAY: {
    name:        'MNQ Intraday',
    instrument:  'MNQ',
    timeframe:   '5m',
    trade_style: 'intraday',
    threshold:   THRESHOLDS.MNQ_INTRADAY,
    description: '5m VWAP + EMA-stack pullback with 15m/1h HTF confirmation',
  },
  MGC_SCALP: {
    name:        'MGC Scalp',
    instrument:  'MGC',
    timeframe:   '5m',
    trade_style: 'scalp',
    threshold:   THRESHOLDS.MGC_SCALP,
    description: '5m VWAP/EMA scalp with 15m/30m/45m/1h multi-timeframe confluence',
  },
  NQ_NY_OPEN: {
    name:        'NQ NY Open',
    instrument:  'MNQ',
    timeframe:   '5m',
    trade_style: 'ny_open',
    threshold:   40,
    description: 'One-trade-per-day NY open auction model — HTF bias + gap + overnight scoring',
  },
};

module.exports = {
  evaluateAll,
  buildBarSetsFrom5m,
  buildBarSetsFrom1m,
  buildBarSetsFrom15m,
  resetAllStrategies,
  refreshNyOpenBlacklist,
  STRATEGY_META,
  THRESHOLDS,
};
