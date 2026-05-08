'use strict';

const WINDOW     = 300;  // last N resolved trades to analyse
const MIN_SAMPLE = 5;    // minimum trades before adjusting

// ── Per-strategy learned threshold bounds ─────────────────────────────────────
// Thresholds evolve after every backtest cycle.
// Low win rate → raise (be more selective). High win rate → lower (cast wider net).

const THRESHOLD_BOUNDS = {
  MNQ_INTRADAY: { min: 52, max: 76, default: 60 },
  MNQ_SWING:    { min: 55, max: 78, default: 63 },
  MNQ_50PT:     { min: 58, max: 80, default: 68 },
  MGC_SCALP:    { min: 50, max: 74, default: 62 },
  MGC_INTRADAY: { min: 50, max: 72, default: 60 },  // "MGC Scalp" display name
  MGC_30PT:     { min: 50, max: 72, default: 60 },
  MGC_45PT:     { min: 52, max: 74, default: 62 },
};

// ── Learned threshold persistence ─────────────────────────────────────────────

function getLearnedThresholds(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE instrument = 'THRESHOLDS'"
    ).get();
    if (row) {
      const stored = JSON.parse(row.params_json);
      // Merge stored with defaults so new strategies always have a value
      const defaults = {};
      for (const [k, b] of Object.entries(THRESHOLD_BOUNDS)) defaults[k] = b.default;
      return { ...defaults, ...stored };
    }
  } catch {}
  const defaults = {};
  for (const [k, b] of Object.entries(THRESHOLD_BOUNDS)) defaults[k] = b.default;
  return defaults;
}

function getLearnedThreshold(db, strategyName, fallback) {
  const all = getLearnedThresholds(db);
  return all[strategyName] ?? fallback;
}

/**
 * Adjust per-strategy confidence thresholds based on backtest win rates.
 *
 * Learning rules:
 *   WR < 35%  → +4 pts  (very poor — tighten hard)
 *   WR < 45%  → +3 pts  (poor — tighten)
 *   WR < 52%  → +1 pt   (below average — nudge up)
 *   WR 52–58% → no change
 *   WR 58–65% → -1 pt   (decent — slightly lower to get more signals)
 *   WR 65–72% → -2 pts  (good — lower threshold)
 *   WR > 72%  → -3 pts  (excellent — cast wider net)
 *
 * @param {object} db
 * @param {object} btMetricsByStrategy - { strategyName: { winRate, tradeCount } }
 * @returns {{ thresholds, changes }}
 */
function updateLearnedThresholds(db, btMetricsByStrategy) {
  const current = getLearnedThresholds(db);
  const changes = {};

  for (const [strat, metrics] of Object.entries(btMetricsByStrategy)) {
    const bounds = THRESHOLD_BOUNDS[strat];
    if (!bounds) continue;
    if ((metrics.tradeCount ?? 0) < MIN_SAMPLE) continue;

    const wr     = metrics.winRate ?? 0;
    const thresh = current[strat] ?? bounds.default;
    let delta    = 0;

    if      (wr < 0.35) delta = +4;
    else if (wr < 0.45) delta = +3;
    else if (wr < 0.52) delta = +1;
    else if (wr >= 0.72) delta = -3;
    else if (wr >= 0.65) delta = -2;
    else if (wr >= 0.58) delta = -1;

    if (delta !== 0) {
      const newVal = Math.max(bounds.min, Math.min(bounds.max, thresh + delta));
      changes[strat] = {
        from:   thresh,
        to:     newVal,
        wr:     +(wr * 100).toFixed(1),
        trades: metrics.tradeCount,
        delta,
      };
      current[strat] = newVal;
    }
  }

  if (Object.keys(changes).length > 0) {
    db.prepare(`
      INSERT INTO strategy_params (instrument, params_json, updated_at, version)
      VALUES ('THRESHOLDS', ?, datetime('now'), 1)
      ON CONFLICT(instrument) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = excluded.updated_at,
        version     = version + 1
    `).run(JSON.stringify(current));
  }

  return { thresholds: current, changes };
}

// ── Aggregate backtest win rates (last N runs) ────────────────────────────────
/**
 * Compute per-strategy win rates from backtest_trades for the last N runs
 * of the given instrument. Used to seed learning before live trade data builds up.
 */
function getBacktestWinRates(db, instrument, lastNRuns = 3) {
  try {
    const rows = db.prepare(`
      SELECT t.strategy_name,
             COUNT(*)                                            AS total,
             SUM(CASE WHEN t.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   backtest_trades t
      WHERE  t.instrument = ?
        AND  t.run_id IN (
          SELECT id FROM backtest_runs
          WHERE  instrument = ?
          ORDER  BY run_at DESC
          LIMIT  ?
        )
      GROUP  BY t.strategy_name
      HAVING total >= ?
    `).all(instrument, instrument, lastNRuns, MIN_SAMPLE);

    const result = {};
    for (const r of rows) {
      result[r.strategy_name] = {
        winRate:    r.total > 0 ? r.wins / r.total : 0,
        tradeCount: r.total,
      };
    }
    return result;
  } catch {
    return {};
  }
}

// ── Per-setup adaptive deltas (live signals) ──────────────────────────────────

function computeAdaptiveDeltas(db) {
  const rows = db.prepare(`
    SELECT s.setup, o.result
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now', '-30 days')
    ORDER  BY s.received_at DESC
    LIMIT  ?
  `).all(WINDOW);

  if (rows.length < MIN_SAMPLE) return {};

  const bySetup = {};
  for (const r of rows) {
    const k = r.setup || 'unknown';
    if (!bySetup[k]) bySetup[k] = { wins: 0, total: 0 };
    bySetup[k].total++;
    if (r.result === 'WIN') bySetup[k].wins++;
  }

  const deltas = {};
  for (const [setup, { wins, total }] of Object.entries(bySetup)) {
    if (total < MIN_SAMPLE) continue;
    const wr = wins / total;
    if      (wr >= 0.70) deltas[setup] = -2;
    else if (wr <= 0.40) deltas[setup] = +4;
  }
  return deltas;
}

// ── Per-style adaptive deltas (live signals) ──────────────────────────────────

function computeAdaptiveDeltasByStyle(db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT s.setup, s.trade_style, o.result
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now', '-30 days')
      ORDER  BY s.received_at DESC
      LIMIT  ?
    `).all(WINDOW);
  } catch {
    return {};
  }

  if (rows.length < MIN_SAMPLE) return {};

  const byStyleSetup = {};
  for (const r of rows) {
    const k = `${r.trade_style || 'unknown'}::${r.setup || 'unknown'}`;
    if (!byStyleSetup[k]) byStyleSetup[k] = { wins: 0, total: 0 };
    byStyleSetup[k].total++;
    if (r.result === 'WIN') byStyleSetup[k].wins++;
  }

  const deltas = {};
  for (const [key, { wins, total }] of Object.entries(byStyleSetup)) {
    if (total < MIN_SAMPLE) continue;
    const wr = wins / total;
    if      (wr >= 0.70) deltas[key] = -2;
    else if (wr <= 0.40) deltas[key] = +4;
  }
  return deltas;
}

// ── Market regime (last 15 resolved trades) ───────────────────────────────────

function getMarketRegime(db) {
  const recent = db.prepare(`
    SELECT o.result
    FROM   outcomes o
    JOIN   signals  s ON s.id = o.signal_id
    ORDER  BY s.received_at DESC
    LIMIT  15
  `).all();

  if (recent.length < 8) return 'unknown';
  const wr = recent.filter(r => r.result === 'WIN').length / recent.length;
  return wr >= 0.60 ? 'trending' : wr <= 0.38 ? 'choppy' : 'mixed';
}

// ── Adaptive min-score (fixed to work on 0-100 confidence scale) ──────────────
/**
 * Returns the adjusted minimum confidence for a given setup/style.
 *
 * Previously broken: was capping output at 28 even when called with 0-100 scale values.
 * Now detects scale automatically and returns values in the same range.
 *
 * @param {object} db
 * @param {string} setup
 * @param {string|number} style
 * @param {number} baseMin  - base threshold (0-100 confidence scale OR legacy 0-25 scale)
 */
function getAdaptiveMinScore(db, setup, style, baseMin = 16) {
  if (typeof style === 'number') { baseMin = style; style = undefined; }

  try {
    const setupDeltas = computeAdaptiveDeltas(db);
    const styleDeltas = style ? computeAdaptiveDeltasByStyle(db) : {};
    const regime      = getMarketRegime(db);

    const setupDelta  = setupDeltas[setup] ?? 0;
    const styleKey    = style ? `${style}::${setup}` : null;
    const styleDelta  = styleKey ? (styleDeltas[styleKey] ?? 0) : 0;

    const combinedDelta = Math.max(setupDelta, styleDelta);
    const regimeDelta   = regime === 'choppy' ? 2 : 0;

    // Auto-detect scale: confidence 0-100 vs legacy 0-25
    if (baseMin > 30) {
      // 0-100 confidence scale — scale up delta proportionally
      const scaledDelta = (combinedDelta + regimeDelta) * 3;
      return Math.max(50, Math.min(85, Math.round(baseMin + scaledDelta)));
    }
    return Math.max(12, Math.min(28, baseMin + combinedDelta + regimeDelta));
  } catch {
    return baseMin;
  }
}

// ── Per-style performance stats ───────────────────────────────────────────────

function getStylePerformance(db) {
  try {
    return db.prepare(`
      SELECT s.trade_style,
             COUNT(*)                                                        AS total,
             SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)               AS wins,
             ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now','-30 days')
      GROUP  BY s.trade_style
      ORDER  BY win_pct DESC
    `).all();
  } catch {
    return [];
  }
}

// ── Full learning stats for /api/learning ─────────────────────────────────────

function getLearningStats(db) {
  const bySetup = db.prepare(`
    SELECT s.setup,
           COUNT(*)                                                      AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)             AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END)             AS losses,
           ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now','-30 days')
    GROUP  BY s.setup
    ORDER  BY win_pct DESC
  `).all();

  const bySession = db.prepare(`
    SELECT s.session,
           COUNT(*)                                                      AS total,
           ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now','-30 days')
    GROUP  BY s.session
    ORDER  BY win_pct DESC
  `).all();

  const byHtf = db.prepare(`
    SELECT s.htf_bias,
           COUNT(*)                                                      AS total,
           ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now','-30 days')
    GROUP  BY s.htf_bias
    ORDER  BY win_pct DESC
  `).all();

  // Also pull backtest win rates by strategy for the last 5 runs
  const btByStrategy = {};
  try {
    const btRows = db.prepare(`
      SELECT t.strategy_name,
             COUNT(*)                                            AS total,
             SUM(CASE WHEN t.outcome='WIN' THEN 1 ELSE 0 END)  AS wins
      FROM   backtest_trades t
      WHERE  t.run_id IN (
        SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 5
      )
      GROUP  BY t.strategy_name
    `).all();
    for (const r of btRows) {
      btByStrategy[r.strategy_name] = {
        total:   r.total,
        wins:    r.wins,
        win_pct: r.total > 0 ? +(r.wins / r.total * 100).toFixed(1) : 0,
      };
    }
  } catch {}

  return {
    bySetup,
    bySession,
    byHtf,
    byStyle:            getStylePerformance(db),
    adaptiveDeltas:     computeAdaptiveDeltas(db),
    learnedThresholds:  getLearnedThresholds(db),
    btByStrategy,
    regime:             getMarketRegime(db),
    windowTrades:       WINDOW,
  };
}

// ── Predicted win rate for a candidate signal (pre-fire) ─────────────────────
/**
 * Compute a DYNAMIC predicted win rate for a signal before it is released.
 *
 * This is NOT a static number. It reacts in real time to:
 *   • Backtest win rate history (last 5 runs for this strategy)
 *   • Live signal outcomes (last 30 days for this strategy + direction)
 *   • Market regime (trending / ranging / choppy / volatile)
 *   • Current ATR vs recent average (detects volatility spikes from news)
 *   • Recent news count (high news volume → wider uncertainty band)
 *
 * The estimate changes every time a signal fires because all inputs are
 * re-queried fresh from the database — not cached.
 *
 * @param {object} db
 * @param {object} signal - { strategy_name, direction, session, confidence, indicators? }
 * @returns {{ predicted_wr_pct, predicted_wr, band, sample_size, source, regime, factors, dynamic_note }}
 */
function getPredictedWinRate(db, signal) {
  const stratName  = signal.strategy_name;
  const direction  = signal.direction;
  const confidence = signal.confidence ?? 70;
  const regime     = getMarketRegime(db);

  // ── Backtest win rate (last 5 runs) ───────────────────────────────────────
  let btWR = null, btCount = 0;
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN t.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   backtest_trades t
      WHERE  t.strategy_name = ?
        AND  t.run_id IN (SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 5)
    `).get(stratName);
    if (r && r.total >= 5) { btWR = r.wins / r.total; btCount = r.total; }
  } catch {}

  // Direction-filtered backtest WR
  let btDirWR = null;
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN t.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   backtest_trades t
      WHERE  t.strategy_name = ? AND t.direction = ?
        AND  t.run_id IN (SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 5)
    `).get(stratName, direction);
    if (r && r.total >= 5) btDirWR = r.wins / r.total;
  } catch {}

  // ── Live signal win rate (last 30 days) ───────────────────────────────────
  let liveWR = null, liveCount = 0;
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   signals s JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.strategy_name = ?
        AND  s.received_at >= datetime('now', '-30 days')
    `).get(stratName);
    if (r && r.total >= 3) { liveWR = r.wins / r.total; liveCount = r.total; }
  } catch {}

  let liveDirWR = null;
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   signals s JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.strategy_name = ? AND s.direction = ?
        AND  s.received_at >= datetime('now', '-30 days')
    `).get(stratName, direction);
    if (r && r.total >= 3) liveDirWR = r.wins / r.total;
  } catch {}

  // ── Blend ─────────────────────────────────────────────────────────────────
  const effectiveBT   = btDirWR   ?? btWR;
  const effectiveLive = liveDirWR ?? liveWR;
  const totalSamples  = btCount + liveCount;

  let predictedWR, source;
  if (effectiveLive !== null && effectiveBT !== null) {
    const liveWeight = Math.min(0.60, 0.20 + (liveCount / Math.max(1, totalSamples)) * 0.40);
    predictedWR = effectiveLive * liveWeight + effectiveBT * (1 - liveWeight);
    source      = 'live+backtest';
  } else if (effectiveLive !== null) {
    predictedWR = effectiveLive; source = 'live';
  } else if (effectiveBT !== null) {
    predictedWR = effectiveBT;   source = 'backtest';
  } else {
    predictedWR = Math.min(0.82, Math.max(0.35, (confidence / 100) * 0.88));
    source      = 'confidence-estimate';
  }

  // ── Regime adjustment (live, re-computed every call) ──────────────────────
  let regimeNote = '';
  if (regime === 'trending')  { predictedWR = Math.min(0.92, predictedWR * 1.06); regimeNote = 'trending+'; }
  else if (regime === 'choppy') { predictedWR = Math.max(0.20, predictedWR * 0.88); regimeNote = 'choppy-'; }
  else if (regime === 'volatile') { predictedWR = Math.max(0.22, predictedWR * 0.82); regimeNote = 'volatile--'; }

  // ── Real-time ATR-based volatility spike detection ────────────────────────
  // If current ATR is significantly above recent average → news/event spike
  // → widen uncertainty band and reduce WR estimate (stops more likely to be hit)
  let volatilityNote = '';
  let atrSpike = false;
  try {
    const currentAtr = signal.indicators?.atr ?? null;
    if (currentAtr != null) {
      const recentAtrRow = db.prepare(`
        SELECT AVG(CAST(json_extract(raw_payload,'$.indicators.atr') AS REAL)) AS avg_atr
        FROM   signals
        WHERE  instrument = ?
          AND  received_at >= datetime('now', '-2 hours')
          AND  json_extract(raw_payload,'$.indicators.atr') IS NOT NULL
        LIMIT  20
      `).get(signal.instrument ?? 'MNQ');
      const avgAtr = recentAtrRow?.avg_atr ?? null;
      if (avgAtr && currentAtr > avgAtr * 1.5) {
        // ATR ≥ 1.5× recent avg — likely news/event spike in progress
        predictedWR  = Math.max(0.20, predictedWR * 0.84);
        atrSpike     = true;
        volatilityNote = `ATR spike (${currentAtr.toFixed(1)} vs avg ${avgAtr.toFixed(1)}) — news/event possible`;
      }
    }
  } catch { /* never crash */ }

  // ── Recent news activity check ────────────────────────────────────────────
  let newsNote = '';
  let highNewsActivity = false;
  try {
    const newsRow = db.prepare(`
      SELECT COUNT(*) AS cnt FROM news_items
      WHERE  published_at >= datetime('now', '-1 hour')
    `).get();
    if (newsRow?.cnt >= 5) {
      // Many news items in last hour — market may be reacting to events
      highNewsActivity = true;
      newsNote = `${newsRow.cnt} news items in last 1h — elevated event risk`;
      if (!atrSpike) predictedWR = Math.max(0.22, predictedWR * 0.93);
    }
  } catch { /* optional */ }

  // ── Confidence band ───────────────────────────────────────────────────────
  // Band widens with: low sample count, ATR spike, high news activity
  let band = totalSamples >= 50 ? 3 : totalSamples >= 20 ? 6 : totalSamples >= 8 ? 9 : 12;
  if (atrSpike)          band = Math.min(20, band + 6);
  if (highNewsActivity)  band = Math.min(20, band + 3);

  const predicted_wr_pct = Math.round(predictedWR * 100);

  // Build dynamic note explaining what influenced this estimate
  const dynamicParts = [];
  if (regimeNote)     dynamicParts.push(`regime=${regime}`);
  if (volatilityNote) dynamicParts.push(volatilityNote);
  if (newsNote)       dynamicParts.push(newsNote);
  const dynamic_note = dynamicParts.length ? dynamicParts.join(' | ') : null;

  return {
    predicted_wr:     +predictedWR.toFixed(3),
    predicted_wr_pct,
    band,
    sample_size:      totalSamples,
    source,
    regime,
    atr_spike:        atrSpike,
    high_news:        highNewsActivity,
    dynamic_note,
    factors: {
      bt_wr:      effectiveBT   !== null ? +(effectiveBT   * 100).toFixed(1) : null,
      live_wr:    effectiveLive !== null ? +(effectiveLive * 100).toFixed(1) : null,
      bt_count:   btCount,
      live_count: liveCount,
    },
  };
}

// ── Live outcome learning: update thresholds after new outcomes resolve ───────
/**
 * Called periodically after auto-resolving live signal outcomes.
 * Feeds live win rates back into the threshold learning system.
 *
 * @param {object} db
 * @param {string} instrument - 'MNQ' | 'MGC'
 * @returns {{ thresholds, changes }}
 */
function updateLearningFromLiveSignals(db, instrument) {
  try {
    const rows = db.prepare(`
      SELECT s.strategy_name,
             COUNT(*)                                              AS total,
             SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END)   AS wins
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.instrument = ?
        AND  s.received_at >= datetime('now', '-14 days')
      GROUP  BY s.strategy_name
      HAVING total >= ?
    `).all(instrument, MIN_SAMPLE);

    if (!rows.length) return { thresholds: getLearnedThresholds(db), changes: {} };

    const metricsMap = {};
    for (const r of rows) {
      metricsMap[r.strategy_name] = {
        winRate:    r.total > 0 ? r.wins / r.total : 0,
        tradeCount: r.total,
      };
    }

    return updateLearnedThresholds(db, metricsMap);
  } catch {
    return { thresholds: getLearnedThresholds(db), changes: {} };
  }
}

module.exports = {
  getAdaptiveMinScore,
  getLearnedThreshold,
  getLearnedThresholds,
  updateLearnedThresholds,
  updateLearningFromLiveSignals,
  getPredictedWinRate,
  getBacktestWinRates,
  getLearningStats,
  getMarketRegime,
  getStylePerformance,
  computeAdaptiveDeltas,
  computeAdaptiveDeltasByStyle,
  THRESHOLD_BOUNDS,
};
