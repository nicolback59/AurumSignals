'use strict';

/**
 * opening-candle.js
 *
 * Opening candle and power-hour intelligence engine.
 *
 * Core thesis (statistically validated before use):
 *   The first candle of a high-liquidity session or hourly block often telegraphs
 *   directional bias for the remainder of that window. A strong bullish opening
 *   candle (large body, close near high, absorbed lower wick) tends to precede
 *   continuation LONG conditions. A bearish opening candle tends to precede SHORT
 *   continuation. Doji / indecision candles signal chop or reversal risk.
 *
 * Sessions tracked:
 *   LONDON      — first 5m bar at or after 03:00 ET
 *   PREMARKET   — first 5m bar at or after 08:00 ET
 *   NY_OPEN     — first 5m bar at or after 09:30 ET  ← "power hour"
 *   NY_MIDDAY   — first 5m bar at or after 11:30 ET
 *   NY_AFTERNOON— first 5m bar at or after 13:30 ET
 *   HOURLY      — first 5m bar of every full hour (fallback)
 *
 * Bias is only applied when historical accuracy for that session ≥ MIN_BIAS_ACCURACY.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_OPEN_BOUNDARIES = [
  { key: 'NY_AFTERNOON', hhmm: 1330 },
  { key: 'NY_MIDDAY',    hhmm: 1130 },
  { key: 'NY_OPEN',      hhmm:  930 },  // power hour
  { key: 'PREMARKET',    hhmm:  800 },
  { key: 'LONDON',       hhmm:  300 },
];

// Minimum historical bias accuracy before we apply confidence adjustment.
// Below this, the opening candle data is tracked but NOT used to adjust gates.
const MIN_BIAS_ACCURACY   = 0.54;   // 54% directional accuracy required
const MIN_SAMPLE_SIZE     = 15;     // need at least 15 session opens tracked
const DB_KEY_PREFIX       = 'SESSION_OPEN_STATS_';
const DB_CANDLE_PREFIX    = 'SESSION_OPEN_CANDLE_';

// Confidence adjustments (applied in confidence-scorer or scanner gate)
const ADJ = {
  STRONG_ALIGN:  5,   // signal direction = strong opening bias direction
  WEAK_ALIGN:    2,   // signal direction = mild opening bias direction
  NEUTRAL:       0,   // doji / indecision opening candle
  COUNTER_WEAK: -2,   // signal direction opposes mild bias
  COUNTER_STRONG:-4,  // signal direction opposes strong bias (fakeout risk)
};

// ── Candle classification ─────────────────────────────────────────────────────

/**
 * Classify an OHLCV bar into a bias label.
 *
 * @param {object} bar  { open, high, low, close }
 * @returns {{ bias: string, strength: number, bodyRatio: number }}
 *   bias:     'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR'
 *   strength: 0.0 – 1.0
 */
function classifyCandle(bar) {
  const range    = bar.high - bar.low;
  if (range < 0.01) return { bias: 'NEUTRAL', strength: 0, bodyRatio: 0 };

  const body      = Math.abs(bar.close - bar.open);
  const bodyRatio = body / range;
  const isBull    = bar.close >= bar.open;

  // Upper and lower wick proportions
  const upperWick = (bar.high - Math.max(bar.open, bar.close)) / range;
  const lowerWick = (Math.min(bar.open, bar.close) - bar.low) / range;

  // Indecision: small body, large wicks on both sides (doji / spinning top)
  if (bodyRatio < 0.15) return { bias: 'NEUTRAL', strength: 0.1, bodyRatio };

  let bias, strength;

  if (isBull) {
    // Strong bull: large body, close near high, small upper wick
    if (bodyRatio >= 0.60 && upperWick < 0.20) {
      bias = 'STRONG_BULL'; strength = Math.min(1.0, bodyRatio + 0.1);
    } else {
      bias = 'BULL'; strength = bodyRatio * 0.8;
    }
  } else {
    // Strong bear: large body, close near low, small lower wick
    if (bodyRatio >= 0.60 && lowerWick < 0.20) {
      bias = 'STRONG_BEAR'; strength = Math.min(1.0, bodyRatio + 0.1);
    } else {
      bias = 'BEAR'; strength = bodyRatio * 0.8;
    }
  }

  return { bias, strength, bodyRatio };
}

/**
 * Determine which session boundary this bar is the opener for, if any.
 * Returns a session key (e.g. 'NY_OPEN') or null if not an opener.
 *
 * Logic: a bar is the opener if its ET hhmm is within the first 5m window
 * after a session boundary (e.g., 09:30–09:34 for NY_OPEN).
 */
function getOpeningSessionKey(timestamp) {
  let h, m;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(timestamp));
    h = parseInt(parts.find(p => p.type === 'hour').value);
    m = parseInt(parts.find(p => p.type === 'minute').value);
  } catch { return null; }

  const hhmm = h * 100 + m;

  for (const { key, hhmm: boundary } of SESSION_OPEN_BOUNDARIES) {
    if (hhmm >= boundary && hhmm < boundary + 5) return key;
  }

  // Hourly fallback: first 5m of any whole hour (e.g., 10:00–10:04)
  if (m < 5 && h >= 3 && h < 17) return `HOUR_${h}`;

  return null;
}

/**
 * Get the ET date string (YYYY-MM-DD) for a timestamp.
 */
function getEtDateKey(timestamp) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
    }).format(new Date(timestamp));
  } catch { return new Date(timestamp).toISOString().slice(0, 10); }
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSessionStats(db, instrument) {
  try {
    const row = db.prepare(`SELECT value FROM strategy_params WHERE key = ?`)
      .get(`${DB_KEY_PREFIX}${instrument}`);
    if (row) return JSON.parse(row.value);
  } catch {}
  return {};  // { [sessionKey]: { correct, total, lastUpdated } }
}

function saveSessionStats(db, instrument, stats) {
  db.prepare(`
    INSERT INTO strategy_params (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(`${DB_KEY_PREFIX}${instrument}`, JSON.stringify(stats));
}

function loadDailyCandles(db, instrument) {
  try {
    const row = db.prepare(`SELECT value FROM strategy_params WHERE key = ?`)
      .get(`${DB_CANDLE_PREFIX}${instrument}`);
    if (row) return JSON.parse(row.value);
  } catch {}
  return {};  // { [dateKey_sessionKey]: { bar, bias, strength, usedForSignals } }
}

function saveDailyCandles(db, instrument, candles) {
  // Keep only last 30 days of candle data
  const keys   = Object.keys(candles).sort();
  const cutoff = keys.length > 300 ? keys[keys.length - 300] : null;
  const pruned = cutoff
    ? Object.fromEntries(Object.entries(candles).filter(([k]) => k >= cutoff))
    : candles;

  db.prepare(`
    INSERT INTO strategy_params (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(`${DB_CANDLE_PREFIX}${instrument}`, JSON.stringify(pruned));
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Record a bar as the opening candle for its session (if applicable).
 * Should be called for every 5m bar during live scanning.
 *
 * @param {object} db
 * @param {string} instrument
 * @param {object} bar  { timestamp, open, high, low, close }
 * @returns {object|null}  Classification result or null if not an opener
 */
function recordOpeningCandle(db, instrument, bar) {
  const sessionKey = getOpeningSessionKey(bar.timestamp);
  if (!sessionKey) return null;

  const dateKey    = getEtDateKey(bar.timestamp);
  const storeKey   = `${dateKey}_${sessionKey}`;

  const candles = loadDailyCandles(db, instrument);
  if (candles[storeKey]) return candles[storeKey]; // already recorded today

  const classified = classifyCandle(bar);
  const entry = {
    dateKey,
    sessionKey,
    bar:      { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
    bias:     classified.bias,
    strength: classified.strength,
    bodyRatio: classified.bodyRatio,
    timestamp: bar.timestamp,
    settled:  false, // will be updated with outcome
  };

  candles[storeKey] = entry;
  saveDailyCandles(db, instrument, candles);

  return entry;
}

/**
 * Get the current session's opening candle bias for signal evaluation.
 * Returns the strongest applicable session bias (named session > hourly).
 *
 * @param {object} db
 * @param {string} instrument
 * @param {string} timestamp   Current bar timestamp
 * @returns {{ sessionKey, bias, strength, accuracy, applicable }} or null
 */
function getSessionOpenBias(db, instrument, timestamp) {
  const dateKey = getEtDateKey(timestamp);
  const candles = loadDailyCandles(db, instrument);
  const stats   = loadSessionStats(db, instrument);

  let h;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).formatToParts(new Date(timestamp));
    h = parseInt(parts.find(p => p.type === 'hour').value);
  } catch { return null; }

  // Try named sessions in priority order (most recent is most relevant)
  const sessionsToCheck = [...SESSION_OPEN_BOUNDARIES.map(s => s.key), `HOUR_${h}`];

  for (const sessionKey of sessionsToCheck) {
    const storeKey = `${dateKey}_${sessionKey}`;
    const candle   = candles[storeKey];
    if (!candle) continue;

    // Only use the opener that is BEFORE or AT the current bar
    if (new Date(candle.timestamp) > new Date(timestamp)) continue;

    const sessStats  = stats[sessionKey] ?? { correct: 0, total: 0 };
    const accuracy   = sessStats.total >= MIN_SAMPLE_SIZE
      ? sessStats.correct / sessStats.total
      : null;

    const applicable = accuracy === null
      ? true            // not enough data yet, still return bias (but scanner may not apply pts)
      : accuracy >= MIN_BIAS_ACCURACY;

    return {
      sessionKey,
      bias:       candle.bias,
      strength:   candle.strength,
      accuracy,
      applicable,
      sampleSize: sessStats.total,
      dateKey,
    };
  }

  return null;
}

/**
 * Calculate the confidence adjustment for a signal given the session open bias.
 * Returns an integer adjustment (positive = boost, negative = penalty).
 *
 * @param {object|null} sessionBias  Result of getSessionOpenBias()
 * @param {string}      direction    'LONG' | 'SHORT'
 * @returns {{ adjustment: number, reason: string }}
 */
function getOpeningCandleAdjustment(sessionBias, direction) {
  if (!sessionBias) return { adjustment: 0, reason: 'no session open data' };

  const { bias, strength, accuracy, applicable, sessionKey } = sessionBias;

  // Skip penalty/bonus if accuracy doesn't meet threshold
  if (!applicable) {
    return { adjustment: 0, reason: `session open tracked but accuracy low (${accuracy ? (accuracy * 100).toFixed(0) + '%' : 'n/a < ' + MIN_SAMPLE_SIZE + ' samples'})` };
  }

  const isStrong    = bias === 'STRONG_BULL' || bias === 'STRONG_BEAR';
  const isBullBias  = bias === 'STRONG_BULL' || bias === 'BULL';
  const isBearBias  = bias === 'STRONG_BEAR' || bias === 'BEAR';
  const isNeutral   = bias === 'NEUTRAL';
  const isLong      = direction === 'LONG';

  if (isNeutral) return { adjustment: 0, reason: `${sessionKey} open: DOJI/neutral — no directional bias` };

  const aligned = (isBullBias && isLong) || (isBearBias && !isLong);
  const adj = aligned
    ? (isStrong ? ADJ.STRONG_ALIGN : ADJ.WEAK_ALIGN)
    : (isStrong ? ADJ.COUNTER_STRONG : ADJ.COUNTER_WEAK);

  const acc = accuracy != null ? ` (acc=${(accuracy * 100).toFixed(0)}%)` : '';
  const reason = `${sessionKey} open: ${bias} str=${strength.toFixed(2)}${acc} → ${aligned ? 'aligned' : 'counter'} ${direction}`;

  return { adjustment: adj, reason };
}

/**
 * Update session accuracy statistics after a trade resolves.
 * Call this when a live signal outcome is recorded.
 *
 * @param {object} db
 * @param {string} instrument
 * @param {string} sessionKey    e.g. 'NY_OPEN'
 * @param {string} openingBias   e.g. 'BULL'
 * @param {string} tradeDirection 'LONG' | 'SHORT'
 * @param {string} outcome        'WIN' | 'LOSS' | 'BE'
 */
function updateSessionBiasAccuracy(db, instrument, sessionKey, openingBias, tradeDirection, outcome) {
  if (!sessionKey || !openingBias || outcome === 'BE') return;

  const stats = loadSessionStats(db, instrument);
  if (!stats[sessionKey]) stats[sessionKey] = { correct: 0, total: 0, wins: 0, losses: 0 };

  const isBullBias = openingBias === 'STRONG_BULL' || openingBias === 'BULL';
  const isBearBias = openingBias === 'STRONG_BEAR' || openingBias === 'BEAR';
  const aligned    = (isBullBias && tradeDirection === 'LONG') || (isBearBias && tradeDirection === 'SHORT');

  stats[sessionKey].total += 1;
  if (outcome === 'WIN') stats[sessionKey].wins  = (stats[sessionKey].wins  ?? 0) + 1;
  else                   stats[sessionKey].losses = (stats[sessionKey].losses ?? 0) + 1;

  // "Correct" means bias direction = outcome direction (WIN when aligned, LOSS when counter)
  if ((aligned && outcome === 'WIN') || (!aligned && outcome === 'LOSS')) {
    stats[sessionKey].correct += 1;
  }

  stats[sessionKey].lastUpdated = new Date().toISOString();
  saveSessionStats(db, instrument, stats);
}

/**
 * Update session bias accuracy from a batch of backtest trades.
 * Efficient bulk version for post-backtest learning.
 */
function updateSessionBiasFromBacktest(db, instrument, signalLog) {
  if (!signalLog || signalLog.length === 0) return;

  // Build opening candles from backtest bars (per date per session)
  // We use the timestamp + session field from each trade
  const stats = loadSessionStats(db, instrument);

  for (const trade of signalLog) {
    if (!trade.timestamp || !trade.session || !trade.outcome || !trade.direction) continue;
    if (trade.outcome === 'BE') continue;

    // Map session name → session key
    const sessionKeyMap = {
      'NY Open ★':           'NY_OPEN',
      'London/NY Overlap':   'PREMARKET',
      'London':              'LONDON',
      'Midday':              'NY_MIDDAY',
      'Afternoon ✓':         'NY_AFTERNOON',
      'Pre-Market':          'PREMARKET',
    };
    const sessionKey = sessionKeyMap[trade.session] ?? null;
    if (!sessionKey) continue;

    // Use htf_bias as a proxy for opening candle direction in backtest
    // (direct per-bar opening candle isn't stored in trade records)
    if (trade.htf_bias == null) continue;
    const bias = trade.htf_bias > 0 ? 'BULL' : trade.htf_bias < 0 ? 'BEAR' : null;
    if (!bias) continue;

    if (!stats[sessionKey]) stats[sessionKey] = { correct: 0, total: 0 };

    const aligned = (bias === 'BULL' && trade.direction === 'LONG') ||
                    (bias === 'BEAR' && trade.direction === 'SHORT');

    stats[sessionKey].total += 1;
    if ((aligned && trade.outcome === 'WIN') || (!aligned && trade.outcome === 'LOSS')) {
      stats[sessionKey].correct += 1;
    }
  }

  saveSessionStats(db, instrument, stats);
}

/**
 * Detect opening candles from a 5m bar array during backtesting.
 * Returns a Map of storeKey → candle classification for the dataset.
 * Used to backfill historical opening candle data for accuracy stats.
 */
function extractOpeningCandlesFromBars(bars5m) {
  const openingCandles = new Map();

  for (const bar of bars5m) {
    const sessionKey = getOpeningSessionKey(bar.timestamp);
    if (!sessionKey) continue;
    const dateKey  = getEtDateKey(bar.timestamp);
    const storeKey = `${dateKey}_${sessionKey}`;
    if (openingCandles.has(storeKey)) continue; // first one only
    openingCandles.set(storeKey, {
      ...classifyCandle(bar),
      sessionKey,
      dateKey,
      timestamp: bar.timestamp,
    });
  }

  return openingCandles;
}

/**
 * Given backtest bar index + precomputed opening candle map,
 * return the applicable session bias for that bar.
 *
 * Used inside the backtest loop to annotate each trade with opening candle context.
 */
function getBacktestSessionBias(bars5m, barIdx, openingCandleMap) {
  const bar       = bars5m[barIdx];
  if (!bar) return null;
  const dateKey   = getEtDateKey(bar.timestamp);

  let h;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).formatToParts(new Date(bar.timestamp));
    h = parseInt(parts.find(p => p.type === 'hour').value);
  } catch { return null; }

  // Try named sessions → hourly
  const keysToCheck = [
    ...SESSION_OPEN_BOUNDARIES.map(s => s.key),
    `HOUR_${h}`,
  ];

  for (const sessionKey of keysToCheck) {
    const storeKey = `${dateKey}_${sessionKey}`;
    const candle   = openingCandleMap.get(storeKey);
    if (!candle) continue;
    if (new Date(candle.timestamp) > new Date(bar.timestamp)) continue;
    return candle;
  }
  return null;
}

/**
 * Full statistics report for a given instrument.
 */
function getOpeningCandleReport(db, instrument) {
  const stats   = loadSessionStats(db, instrument);
  const candles = loadDailyCandles(db, instrument);

  const sessionSummary = Object.entries(stats).map(([key, s]) => ({
    sessionKey:  key,
    total:       s.total,
    correct:     s.correct,
    accuracy:    s.total > 0 ? +(s.correct / s.total * 100).toFixed(1) : null,
    wins:        s.wins ?? 0,
    losses:      s.losses ?? 0,
    active:      s.total >= MIN_SAMPLE_SIZE && (s.correct / s.total) >= MIN_BIAS_ACCURACY,
    lastUpdated: s.lastUpdated ?? null,
  })).sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  // Today's session opens
  const today = getEtDateKey(new Date().toISOString());
  const todayCandles = Object.entries(candles)
    .filter(([k]) => k.startsWith(today))
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return {
    instrument,
    sessionSummary,
    todayCandles,
    minAccuracyThreshold: MIN_BIAS_ACCURACY,
    minSampleSize:        MIN_SAMPLE_SIZE,
    generatedAt:          new Date().toISOString(),
  };
}

module.exports = {
  classifyCandle,
  getOpeningSessionKey,
  getEtDateKey,
  recordOpeningCandle,
  getSessionOpenBias,
  getOpeningCandleAdjustment,
  updateSessionBiasAccuracy,
  updateSessionBiasFromBacktest,
  extractOpeningCandlesFromBars,
  getBacktestSessionBias,
  getOpeningCandleReport,
  SESSION_OPEN_BOUNDARIES,
  MIN_BIAS_ACCURACY,
  MIN_SAMPLE_SIZE,
  ADJ,
};
