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
const mnqSwing    = require('./strategies/mnq-swing');
const mnq50Point  = require('./strategies/mnq-50-point');
const mgcScalp    = require('./strategies/mgc-scalp');
const mgcIntraday = require('./strategies/mgc-intraday');

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
      const sig = mnqIntraday.evaluate(bars5m, bars15m, bars1h, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  // ── MNQ 50-POINT ─────────────────────────────────────────────────────────────
  if (instrument === 'MNQ' || instrument == null) {
    if (bars5m.length >= 25 && bars15m.length >= 8) {
      const sig = mnq50Point.evaluate(bars5m, bars15m, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  // ── MNQ SWING ────────────────────────────────────────────────────────────────
  if (instrument === 'MNQ' || instrument == null) {
    if (bars1h.length >= 20 && barsDly.length >= 3) {
      const sig = mnqSwing.evaluate(bars1h, bars4h, barsDly, cfg, barIdx);
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

  // ── MGC INTRADAY ──────────────────────────────────────────────────────────────
  // Broader gold intraday trend-following (wider sessions, more signals than MGC_SCALP).
  if (instrument === 'MGC' || instrument == null) {
    if (bars5mMgc.length >= 50 && bars1hMgc.length >= 20) {
      const sig = mgcIntraday.evaluate(bars5mMgc, bars1hMgc, bars30mMgc, bars45mMgc, cfg, barIdx);
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
  mnqSwing.reset();
  mnq50Point.reset();
  mgcScalp.reset();
  mgcIntraday.reset();
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
  MNQ_SWING: {
    name:        'MNQ Swing',
    instrument:  'MNQ',
    timeframe:   '1h',
    trade_style: 'swing',
    threshold:   THRESHOLDS.MNQ_SWING,
    description: '1h/daily EMA trend with 1h structure pullback entry',
  },
  MNQ_50PT: {
    name:        'MNQ 50-Point',
    instrument:  'MNQ',
    timeframe:   '5m',
    trade_style: 'intraday',
    threshold:   THRESHOLDS.MNQ_50PT,
    description: '5m consolidation breakout targeting 50 MNQ points',
  },
  MGC_SCALP: {
    name:        'MGC Scalp',
    instrument:  'MGC',
    timeframe:   '5m',
    trade_style: 'scalp',
    threshold:   THRESHOLDS.MGC_SCALP,
    description: '5m VWAP/EMA scalp with 15m/30m/45m/1h multi-timeframe confluence',
  },
  MGC_INTRADAY: {
    name:        'MGC Intraday',
    instrument:  'MGC',
    timeframe:   '5m',
    trade_style: 'intraday',
    threshold:   THRESHOLDS.MGC_INTRADAY,
    description: '5m EMA trend-following intraday with 30m/45m/1h HTF confirmation',
  },
};

module.exports = {
  evaluateAll,
  buildBarSetsFrom5m,
  buildBarSetsFrom1m,
  buildBarSetsFrom15m,
  resetAllStrategies,
  STRATEGY_META,
  THRESHOLDS,
};
