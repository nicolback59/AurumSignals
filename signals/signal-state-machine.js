'use strict';

/**
 * SIGNAL STATE MACHINE
 *
 * Lifecycle:
 *   CANDIDATE    → signal emitted by strategy, pre-filter
 *   STAGED       → passed all gates (fingerprint, tier, cooldown), ready to store
 *   ACTIVE       → stored in DB, awaiting price resolution
 *   WIN          → TP1 hit (a win is defined as hitting TP1)
 *   LOSS         → stop-loss hit
 *   BE           → manually or algorithmically marked break-even
 *   EXPIRED      → max hold time elapsed with no TP1/SL hit
 *   INVALIDATED  → superseded by a conflicting signal or market regime flip
 *
 * The machine only lives in-process for CANDIDATE→STAGED transitions.
 * From ACTIVE onward, trade_status is persisted in the signals table so
 * it survives restarts.
 *
 * Max hold times (ACTIVE → EXPIRED):
 *   scalp    :  2 hours
 *   intraday :  4 hours
 *   swing    : 72 hours
 */

// Valid states
const STATES = Object.freeze({
  CANDIDATE:   'CANDIDATE',
  STAGED:      'STAGED',
  ACTIVE:      'ACTIVE',
  WIN:         'WIN',
  LOSS:        'LOSS',
  BE:          'BE',
  EXPIRED:     'EXPIRED',
  INVALIDATED: 'INVALIDATED',
});

// Terminal states — no further transitions allowed
const TERMINAL = new Set(['WIN', 'LOSS', 'BE', 'EXPIRED', 'INVALIDATED']);

// Allowed transitions
const TRANSITIONS = {
  CANDIDATE:   ['STAGED', 'INVALIDATED'],
  STAGED:      ['ACTIVE', 'INVALIDATED'],
  ACTIVE:      ['WIN', 'LOSS', 'BE', 'EXPIRED', 'INVALIDATED'],
  WIN:         [],
  LOSS:        [],
  BE:          [],
  EXPIRED:     [],
  INVALIDATED: [],
};

// Max hold durations in milliseconds per trade style
const MAX_HOLD_MS = {
  scalp:    2  * 60 * 60 * 1000,   //  2 hours
  intraday: 6  * 60 * 60 * 1000,   //  6 hours
  swing:    72 * 60 * 60 * 1000,   // 72 hours
};
const DEFAULT_HOLD_MS = MAX_HOLD_MS.intraday;

/**
 * Validate a state transition. Returns { ok, reason }.
 */
function canTransition(from, to) {
  const allowed = TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true, reason: null };
  return {
    ok:     false,
    reason: `Invalid transition: ${from} → ${to} (allowed: ${allowed.join(', ') || 'none'})`,
  };
}

/**
 * Given a signal and a bar, determine if the bar resolves the signal.
 *
 * A WIN is defined as TP1 being hit (the user's definition: "a win is
 * considered if it hits tp1"). SL hit → LOSS.
 *
 * @param {object} sig  - signal row: { direction, entry, sl, tp1 }
 * @param {object} bar  - OHLCV bar: { high, low, close, timestamp }
 * @returns {{ toState: string, exitPrice: number, pnlPts: number } | null}
 */
function resolveBar(sig, bar) {
  const { direction, entry, sl, tp1 } = sig;
  if (entry == null || sl == null || tp1 == null) return null;

  if (direction === 'LONG') {
    if (bar.high >= tp1) {
      return { toState: STATES.WIN,  exitPrice: tp1, pnlPts: +(tp1 - entry).toFixed(2) };
    }
    if (bar.low <= sl) {
      return { toState: STATES.LOSS, exitPrice: sl,  pnlPts: +(sl  - entry).toFixed(2) };
    }
  } else {
    if (bar.low <= tp1) {
      return { toState: STATES.WIN,  exitPrice: tp1, pnlPts: +(entry - tp1).toFixed(2) };
    }
    if (bar.high >= sl) {
      return { toState: STATES.LOSS, exitPrice: sl,  pnlPts: +(entry - sl ).toFixed(2) };
    }
  }
  return null;
}

/**
 * Check whether an ACTIVE signal has exceeded its max hold time and should
 * transition to EXPIRED.
 *
 * @param {object} sig    - { trade_style, received_at }
 * @param {Date}   [now]  - optional override for testing
 * @returns {boolean}
 */
function shouldExpire(sig, now = new Date()) {
  const style   = sig.trade_style ?? 'intraday';
  const maxMs   = MAX_HOLD_MS[style] ?? DEFAULT_HOLD_MS;
  const sigTs   = new Date(sig.received_at).getTime();
  return (now.getTime() - sigTs) > maxMs;
}

/**
 * Compute the expiry deadline for a signal (returns a Date).
 */
function expiryDate(sig) {
  const style = sig.trade_style ?? 'intraday';
  const maxMs = MAX_HOLD_MS[style] ?? DEFAULT_HOLD_MS;
  return new Date(new Date(sig.received_at).getTime() + maxMs);
}

/**
 * Map a terminal state to an outcome result string for the outcomes table.
 * WIN→'WIN', LOSS→'LOSS', BE→'BE', EXPIRED→'EXPIRED'.
 */
function stateToResult(state) {
  if (state === STATES.WIN)     return 'WIN';
  if (state === STATES.LOSS)    return 'LOSS';
  if (state === STATES.BE)      return 'BE';
  if (state === STATES.EXPIRED) return 'EXPIRED';
  return null;
}

module.exports = {
  STATES,
  TERMINAL,
  TRANSITIONS,
  MAX_HOLD_MS,
  canTransition,
  resolveBar,
  shouldExpire,
  expiryDate,
  stateToResult,
};
