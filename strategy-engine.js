'use strict';

/**
 * STRATEGY ENGINE — unified signal evaluator
 *
 * This is the single source of truth for all trading logic.
 * The same functions are used by:
 *   • scanner.js      (live scanning)
 *   • backtest-engine.js (historical backtesting)
 *   • server.js       (webhook signal ingestion)
 *
 * No separate logic exists for live vs backtest.
 *
 * Multi-timeframe bar arrays must be passed in pre-aggregated.
 * All strategy modules only look at confirmed (closed) bars.
 */

const mnqIntraday = require('./strategies/mnq-intraday');
const mnqSwing    = require('./strategies/mnq-swing');
const mnq50Point  = require('./strategies/mnq-50-point');
const mgcScalp    = require('./strategies/mgc-scalp');

const {
  aggregate1mTo5m,
  aggregate5mTo15m,
  aggregate5mTo1h,
  aggregate1hTo4h,
  aggregate1hToDaily,
  aggregate15mTo1h,
  aggregateBars,
} = require('./strategies/shared-indicators');

const { THRESHOLDS } = require('./strategies/confidence-scorer');

// Re-export for convenience
module.exports.THRESHOLDS = THRESHOLDS;

/**
 * Evaluate all strategies against multi-timeframe bar sets.
 *
 * Pass in pre-aggregated bars for efficiency (scanner pre-builds them).
 * Each strategy only fires if it passes its own confidence threshold.
 *
 * @param {object} barSets
 * @param {object[]} barSets.bars5m    - 5m MNQ bars (intraday + 50-pt)
 * @param {object[]} barSets.bars15m   - 15m MNQ bars (HTF for intraday + 50-pt)
 * @param {object[]} barSets.bars1h    - 1h MNQ bars  (swing primary + HTF2 for intraday)
 * @param {object[]} barSets.bars4h    - 4h MNQ bars  (HTF for swing)
 * @param {object[]} barSets.barsDly   - Daily MNQ bars (HTF2 for swing)
 * @param {object[]} barSets.bars5mMgc - 5m MGC bars (scalp primary)
 * @param {object[]} barSets.bars15mMgc - 15m MGC bars (HTF for scalp)
 * @param {object[]} barSets.bars1hMgc - 1h MGC bars (HTF2 for scalp)
 *
 * @param {object} cfg
 * @param {string}  cfg.instrument    - 'MNQ' | 'MGC' | null (run all)
 * @param {number}  [cfg.barIdx]      - absolute bar index for backtest cooldowns
 * @param {number}  [cfg.cooldownBars] - override cooldown per strategy
 *
 * @returns {object[]} array of signal objects (may be empty)
 */
function evaluateAll(barSets, cfg = {}) {
  const signals = [];
  const {
    bars5m = [], bars15m = [], bars1h = [], bars4h = [], barsDly = [],
    bars5mMgc = [], bars15mMgc = [], bars1hMgc = [],
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
    if (bars5m.length >= 40 && bars15m.length >= 20) {
      const sig = mnq50Point.evaluate(bars5m, bars15m, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  // ── MNQ SWING ────────────────────────────────────────────────────────────────
  if (instrument === 'MNQ' || instrument == null) {
    if (bars1h.length >= 60 && barsDly.length >= 30) {
      const sig = mnqSwing.evaluate(bars1h, bars4h, barsDly, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  // ── MGC SCALP ────────────────────────────────────────────────────────────────
  if (instrument === 'MGC' || instrument == null) {
    if (bars5mMgc.length >= 40 && bars15mMgc.length >= 20) {
      const sig = mgcScalp.evaluate(bars5mMgc, bars15mMgc, bars1hMgc, cfg, barIdx);
      if (sig) signals.push(sig);
    }
  }

  return signals;
}

/**
 * Build a full bar-set from 5m source bars.
 * Used by the scanner (single aggregation pipeline per instrument).
 *
 * @param {object[]} bars5m   - source 5m bars
 * @returns {object} { bars5m, bars15m, bars1h, bars4h, barsDly }
 */
function buildBarSetsFrom5m(bars5m) {
  const bars15m = aggregate5mTo15m(bars5m);
  const bars1h  = aggregate5mTo1h(bars5m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);
  return { bars5m, bars15m, bars1h, bars4h, barsDly };
}

/**
 * Build bar-sets from 1m source bars (used in backtesting).
 *
 * @param {object[]} bars1m
 * @returns {object}
 */
function buildBarSetsFrom1m(bars1m) {
  const bars5m  = aggregate1mTo5m(bars1m);
  const bars15m = aggregate5mTo15m(bars5m);
  const bars1h  = aggregate5mTo1h(bars5m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);
  return { bars5m, bars15m, bars1h, bars4h, barsDly };
}

/**
 * Build bar-sets from 15m source bars (used in scanner if 15m is fetched).
 *
 * @param {object[]} bars15m
 * @returns {object}
 */
function buildBarSetsFrom15m(bars15m) {
  // Approximate 5m from 15m by treating each 15m as 3×5m
  // Not ideal for intraday, but works for swing/HTF
  const bars5m  = bars15m; // use 15m as-is for primary
  const bars1h  = aggregate15mTo1h(bars15m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);
  return { bars5m, bars15m, bars1h, bars4h, barsDly };
}

/**
 * Reset all strategy cooldown states between backtest runs.
 */
function resetAllStrategies() {
  mnqIntraday.reset();
  mnqSwing.reset();
  mnq50Point.reset();
  mgcScalp.reset();
}

/**
 * Strategy metadata — used by backtest and UI.
 */
const STRATEGY_META = {
  MNQ_INTRADAY: {
    name:        'MNQ Intraday',
    instrument:  'MNQ',
    timeframe:   '5m',
    trade_style: 'intraday',
    threshold:   THRESHOLDS.MNQ_INTRADAY,
    description: '5-minute VWAP + EMA-stack pullback continuation',
  },
  MNQ_SWING: {
    name:        'MNQ Swing',
    instrument:  'MNQ',
    timeframe:   '1h',
    trade_style: 'swing',
    threshold:   THRESHOLDS.MNQ_SWING,
    description: '1h/daily EMA50/200 trend with 1h structure pullback',
  },
  MNQ_50PT: {
    name:        'MNQ 50-Point',
    instrument:  'MNQ',
    timeframe:   '5m',
    trade_style: 'intraday',
    threshold:   THRESHOLDS.MNQ_50PT,
    description: '5-minute consolidation breakout targeting 50 MNQ points',
  },
  MGC_SCALP: {
    name:        'MGC Scalp',
    instrument:  'MGC',
    timeframe:   '5m',
    trade_style: 'scalp',
    threshold:   THRESHOLDS.MGC_SCALP,
    description: '5-minute VWAP/EMA rejection scalp during London/NY sessions',
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
