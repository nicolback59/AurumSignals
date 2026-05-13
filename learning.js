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
  MGC_INTRADAY: { min: 50, max: 72, default: 60 },
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
function updateLearnedThresholds(db, btMetricsByStrategy, instrument = null) {
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
      const candidate = Math.max(bounds.min, Math.min(bounds.max, thresh + delta));

      // Anti-regression safeguard — never regress after successful periods
      if (instrument && !isThresholdChangeSafe(db, instrument, strat, candidate)) {
        changes[strat] = {
          from:     thresh,
          to:       thresh,  // unchanged
          wr:       +(wr * 100).toFixed(1),
          trades:   metrics.tradeCount,
          delta:    0,
          blocked:  true,
          reason:   delta < 0
            ? `Lowering blocked by anti-regression safeguard (degradation alert or poor BT WR)`
            : `Raising blocked — delta ${delta} exceeds single-cycle cap`,
        };
        continue;
      }

      const explanation = delta > 0
        ? `WR=${(wr*100).toFixed(1)}% on ${metrics.tradeCount} trades is below target — threshold raised from ${thresh} to ${candidate} to reduce false positives`
        : `WR=${(wr*100).toFixed(1)}% on ${metrics.tradeCount} trades is strong — threshold lowered from ${thresh} to ${candidate} to capture more high-quality setups`;

      changes[strat] = {
        from:        thresh,
        to:          candidate,
        wr:          +(wr * 100).toFixed(1),
        trades:      metrics.tradeCount,
        delta,
        blocked:     false,
        explanation,
      };
      current[strat] = candidate;
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

// ── Per-instrument behavior profile (live signal stats) ───────────────────────
/**
 * Returns key behavioral metrics for one instrument from live signal outcomes.
 * Used by the scanner and confidence scorer to apply instrument-specific intelligence.
 */
function getInstrumentProfile(db, instrument) {
  try {
    const rows = db.prepare(`
      SELECT s.session, s.direction, s.htf_bias, s.trade_style, o.result
      FROM   signals s JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.instrument = ?
        AND  s.received_at >= datetime('now', '-60 days')
    `).all(instrument);

    if (rows.length < 10) return null;

    const groupWR = (field) => {
      const m = {};
      for (const r of rows) {
        const k = r[field] ?? 'unknown';
        if (!m[k]) m[k] = { w: 0, t: 0 };
        m[k].t++;
        if (r.result === 'WIN') m[k].w++;
      }
      return Object.fromEntries(
        Object.entries(m)
          .filter(([, v]) => v.t >= 3)
          .map(([k, v]) => [k, { wr: +(v.w / v.t).toFixed(3), n: v.t }])
      );
    };

    return {
      instrument,
      sample: rows.length,
      bySession:   groupWR('session'),
      byDirection: groupWR('direction'),
      byHtfBias:   groupWR('htf_bias'),
      byStyle:     groupWR('trade_style'),
    };
  } catch {
    return null;
  }
}

// ── Edge degradation detection ────────────────────────────────────────────────
/**
 * Detects when a historically successful strategy is degrading.
 * Compares the last 3 backtest run win rates vs the prior 3.
 * If recent avg WR dropped > 8% → alert.
 */
function detectEdgeDegradation(db, instrument) {
  try {
    const rows = db.prepare(`
      SELECT win_rate, run_at FROM backtest_runs
      WHERE  instrument = ?
      ORDER  BY run_at DESC LIMIT 8
    `).all(instrument);

    if (rows.length < 6) {
      return {
        instrument,
        status: 'insufficient_data',
        alert:  false,
        message: `Building data — need 6+ backtest runs (have ${rows.length}). No degradation alert until enough history exists.`,
        recentAvgWR: null, priorAvgWR: null, delta: null,
      };
    }

    const wrs = rows.map(r => r.win_rate).filter(v => v != null);
    if (wrs.length < 6) {
      return { instrument, status: 'insufficient_data', alert: false, message: 'Win rate data unavailable.', recentAvgWR: null, priorAvgWR: null, delta: null };
    }

    const recent3 = (wrs[0] + wrs[1] + wrs[2]) / 3;
    const prior3  = (wrs[3] + wrs[4] + wrs[5]) / 3;
    const delta   = recent3 - prior3;

    // Only flag degradation if:
    //  1. Drop is > 8 percentage points AND
    //  2. Recent avg WR is actually below 50% (not just relatively worse)
    const isDegrading = delta < -0.08 && recent3 < 0.50;

    return {
      instrument,
      status:        isDegrading ? 'degrading' : delta > 0.04 ? 'improving' : 'stable',
      recentAvgWR:   +(recent3 * 100).toFixed(1),
      priorAvgWR:    +(prior3  * 100).toFixed(1),
      delta:         +(delta   * 100).toFixed(1),
      // Legacy field names for existing UI
      recent_avg_wr_pct: +(recent3 * 100).toFixed(1),
      prior_avg_wr_pct:  +(prior3  * 100).toFixed(1),
      delta_pct:         +(delta   * 100).toFixed(1),
      alert:         isDegrading,
      message: isDegrading
        ? `${instrument} edge degrading — last 3 avg ${(recent3*100).toFixed(1)}% WR vs prior 3 avg ${(prior3*100).toFixed(1)}% WR. Optimizer will run next cycle.`
        : delta > 0.04
        ? `${instrument} edge improving — +${(delta*100).toFixed(1)}% vs prior period.`
        : `${instrument} edge stable — win rate variance within normal bounds.`,
    };
  } catch {
    return { instrument, status: 'error' };
  }
}

// ── Anti-regression safeguard ─────────────────────────────────────────────────
/**
 * Checks whether a proposed threshold change would regress the system.
 * Returns true if the change is safe to apply.
 *
 * Anti-regression rules:
 *   1. Cannot lower threshold below (current - 6) in a single cycle if recent BT WR < 58%
 *   2. Cannot raise threshold above (current + 8) in a single cycle regardless of WR
 *   3. After a degradation alert, thresholds may only increase, not decrease
 */
function isThresholdChangeSafe(db, instrument, strategyName, proposedThreshold) {
  try {
    const bounds = THRESHOLD_BOUNDS[strategyName];
    if (!bounds) return true; // unknown strategy — allow

    const current = getLearnedThresholds(db)[strategyName] ?? bounds.default;
    const delta   = proposedThreshold - current;

    // Rule 2: cap single-cycle increase
    if (Math.abs(delta) > 8) return false;

    // Rule 1: don't lower during poor BT performance
    if (delta < -6) {
      const btRow = db.prepare(`
        SELECT win_rate FROM backtest_runs
        WHERE  instrument = ? ORDER BY run_at DESC LIMIT 1
      `).get(instrument);
      if (btRow && btRow.win_rate < 0.58) return false;
    }

    // Rule 3: degradation lock — only allow increases
    const degradation = detectEdgeDegradation(db, instrument);
    if (degradation.alert && delta < 0) return false;

    return true;
  } catch {
    return true; // never crash — allow on error
  }
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
  if (regime === 'trending') {
    predictedWR = Math.min(0.92, predictedWR * 1.06);
    regimeNote  = 'trending+6%';
  } else if (regime === 'choppy') {
    predictedWR = Math.max(0.20, predictedWR * 0.88);
    regimeNote  = 'choppy-12%';
  } else if (regime === 'volatile') {
    predictedWR = Math.max(0.22, predictedWR * 0.82);
    regimeNote  = 'volatile-18%';
  }

  // ── Instrument behavior profile adjustment ─────────────────────────────────
  // Apply per-instrument session & direction bias from live signal history.
  // Only adjusts if sufficient sample size to avoid noise contamination.
  let profileNote = '';
  try {
    const profile = getInstrumentProfile(db, signal.instrument ?? 'MNQ');
    if (profile) {
      const sessWR = profile.bySession[signal.session];
      const dirWR  = profile.byDirection[signal.direction];
      if (sessWR && sessWR.n >= 5) {
        const sessAdj = sessWR.wr - 0.55;
        predictedWR = Math.max(0.15, Math.min(0.92, predictedWR + sessAdj * 0.3));
        if (Math.abs(sessAdj) > 0.08) {
          profileNote = `session=${signal.session} hist-WR=${(sessWR.wr*100).toFixed(0)}% adj${sessAdj > 0 ? '+' : ''}${(sessAdj*30).toFixed(1)}%`;
        }
      }
      if (dirWR && dirWR.n >= 8) {
        const dirAdj = dirWR.wr - 0.55;
        predictedWR = Math.max(0.15, Math.min(0.92, predictedWR + dirAdj * 0.15));
        if (Math.abs(dirAdj) > 0.08 && !profileNote) {
          profileNote = `${signal.direction} hist-WR=${(dirWR.wr*100).toFixed(0)}%`;
        }
      }
    }
  } catch { /* never crash */ }

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
  if (regimeNote)     dynamicParts.push(regimeNote);
  if (profileNote)    dynamicParts.push(profileNote);
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

// ── Pattern memory — condition fingerprint → historical WR ────────────────────
// Each unique combination of (strategy + direction + htfBias + session) is a
// distinct trading context. The system tracks WR per context and adjusts the
// effective confidence gate: high-WR patterns lower the bar, low-WR patterns
// raise it or get blocked. This makes the indicator genuinely learn from itself.

const PATTERN_MEMORY_KEY = 'PATTERN_MEMORY';
const OVERRIDE_KEY       = 'ADAPTIVE_OVERRIDES';

function _upsertStratParams(db, key, json) {
  db.prepare(`
    INSERT INTO strategy_params (instrument, params_json, updated_at, version)
    VALUES (?, ?, datetime('now'), 1)
    ON CONFLICT(instrument) DO UPDATE SET
      params_json = excluded.params_json,
      updated_at  = excluded.updated_at,
      version     = version + 1
  `).run(key, json);
}

function _loadStratParams(db, key) {
  try {
    const row = db.prepare(
      `SELECT params_json FROM strategy_params WHERE instrument = ?`
    ).get(key);
    if (row) return JSON.parse(row.params_json);
  } catch {}
  return null;
}

function buildPatternKey(strategyName, direction, htfBias, session) {
  const sess = (session ?? 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20);
  return `${strategyName}::${direction}::${htfBias ?? 'X'}::${sess}`;
}

function loadPatternMemory(db) {
  return _loadStratParams(db, PATTERN_MEMORY_KEY) ?? {};
}

/**
 * Update pattern memory from trades. Each trade needs:
 * { strategy_name, direction, htf_bias, session, outcome }
 */
function updatePatternMemory(db, trades) {
  if (!trades || !trades.length) return;
  const patterns = loadPatternMemory(db);

  for (const t of trades) {
    if (!t.strategy_name || !t.direction) continue;
    const key = buildPatternKey(t.strategy_name, t.direction, t.htf_bias, t.session);
    if (!patterns[key]) patterns[key] = { wins: 0, total: 0 };
    patterns[key].total++;
    if (t.outcome === 'WIN') patterns[key].wins++;
    patterns[key].wr = +(patterns[key].wins / patterns[key].total).toFixed(3);
    patterns[key].updated = new Date().toISOString();
  }

  _upsertStratParams(db, PATTERN_MEMORY_KEY, JSON.stringify(patterns));
  return patterns;
}

/**
 * Returns a confidence gate adjustment for a candidate signal based on how this
 * exact pattern (strategy + direction + htfBias + session) has historically performed.
 *
 * Rules (minimum sample sizes enforced to avoid noise):
 *   WR ≥ 75% (≥8 trades) → -8  (strong pattern, widen the net)
 *   WR ≥ 65% (≥6 trades) → -4
 *   WR ≥ 55% (≥5 trades) → -2
 *   WR 45-55%             →  0  (neutral — no adjustment)
 *   WR < 45% (≥5 trades)  → +6  (underperforming — tighten)
 *   WR < 35% (≥6 trades)  → +12 (poor — raise bar significantly)
 *   WR < 28% (≥8 trades)  → +20 (effectively blocks the pattern)
 */
function getPatternAdjustment(db, signal) {
  const key = buildPatternKey(signal.strategy_name, signal.direction, signal.htf_bias, signal.session);
  const patterns = loadPatternMemory(db);
  const p = patterns[key];

  if (!p || p.total < 5) {
    return { adjustment: 0, patternKey: key, patternWR: null, patternTrades: p?.total ?? 0 };
  }

  const wr = p.wins / p.total;
  let adjustment = 0;

  if      (p.total >= 8 && wr >= 0.75) adjustment = -8;
  else if (p.total >= 6 && wr >= 0.65) adjustment = -4;
  else if (p.total >= 5 && wr >= 0.55) adjustment = -2;
  else if (p.total >= 8 && wr <  0.28) adjustment = +20;
  else if (p.total >= 6 && wr <  0.35) adjustment = +12;
  else if (p.total >= 5 && wr <  0.45) adjustment = +6;

  return { adjustment, patternKey: key, patternWR: +wr.toFixed(3), patternTrades: p.total };
}

// ── Adaptive overrides — auto-pause, direction-block, session-block ───────────
// Computed from live signal outcomes (last 30 days) after every backtest or
// outcome-resolve cycle. Makes real behavioral decisions — not just threshold nudges.

function loadAdaptiveOverrides(db) {
  return _loadStratParams(db, OVERRIDE_KEY) ?? {};
}

function saveAdaptiveOverrides(db, overrides) {
  _upsertStratParams(db, OVERRIDE_KEY, JSON.stringify(overrides));
}

/**
 * Compute adaptive overrides from live signal + backtest outcome data.
 *
 * Rules (per strategy, last 30 days live signals):
 *   Auto-pause:     overall WR < 38% with ≥ 8 trades
 *   Auto-unpause:   overall WR ≥ 48% with ≥ 5 trades (cancels auto-pause)
 *   Block LONG:     LONG WR < 35% with ≥ 8 trades
 *   Block SHORT:    SHORT WR < 35% with ≥ 8 trades
 *   Unblock dir:    directional WR ≥ 45% with ≥ 5 trades
 *   Block session:  session WR < 35% with ≥ 5 trades
 *   Unblock sess:   session WR ≥ 45% with ≥ 5 trades
 *
 * NOTE: manual overrides (manualPause: true) are never automatically cleared.
 */
function computeAdaptiveOverrides(db) {
  const overrides = loadAdaptiveOverrides(db);

  let stratRows = [], dirRows = [], sessRows = [];
  try {
    stratRows = db.prepare(`
      SELECT s.strategy_name, COUNT(*) AS total,
             SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   signals s JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now', '-30 days')
      GROUP  BY s.strategy_name
    `).all();
  } catch {}

  try {
    dirRows = db.prepare(`
      SELECT s.strategy_name, s.direction, COUNT(*) AS total,
             SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   signals s JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now', '-30 days')
      GROUP  BY s.strategy_name, s.direction
    `).all();
  } catch {}

  try {
    sessRows = db.prepare(`
      SELECT s.strategy_name, s.session, COUNT(*) AS total,
             SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   signals s JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now', '-30 days')
      GROUP  BY s.strategy_name, s.session
    `).all();
  } catch {}

  // Start from existing overrides (preserve manual overrides)
  const result = {};
  for (const [strat, existing] of Object.entries(overrides)) {
    result[strat] = { ...existing };
  }

  const ensureEntry = (strat) => {
    if (!result[strat]) result[strat] = { paused: false, blockLong: false, blockShort: false, blockedSessions: [], reasons: [] };
    if (!result[strat].reasons) result[strat].reasons = [];
    if (!result[strat].blockedSessions) result[strat].blockedSessions = [];
  };

  for (const r of stratRows) {
    const strat = r.strategy_name; if (!strat) continue;
    ensureEntry(strat);
    const ov = result[strat];
    if (ov.manualPause) continue; // respect manual overrides
    const wr = r.total > 0 ? r.wins / r.total : 0;

    if (r.total >= 8 && wr < 0.38) {
      ov.paused = true;
      const msg = `auto-paused: WR=${(wr * 100).toFixed(1)}% (${r.total} trades) < 38%`;
      if (!ov.reasons.some(x => x.startsWith('auto-paused'))) ov.reasons.push(msg);
    } else if (r.total >= 5 && wr >= 0.48 && ov.paused && !ov.manualPause) {
      ov.paused = false;
      ov.reasons = ov.reasons.filter(x => !x.startsWith('auto-paused'));
      ov.reasons.push(`auto-unpaused: WR recovered to ${(wr * 100).toFixed(1)}% (${r.total} trades)`);
    }
  }

  for (const r of dirRows) {
    const strat = r.strategy_name; if (!strat || !r.direction) continue;
    ensureEntry(strat);
    const ov = result[strat];
    const wr = r.total > 0 ? r.wins / r.total : 0;
    const tag = `block-${r.direction}`;

    if (r.total >= 8 && wr < 0.35) {
      if (r.direction === 'LONG')  ov.blockLong  = true;
      if (r.direction === 'SHORT') ov.blockShort = true;
      if (!ov.reasons.some(x => x.startsWith(tag))) {
        ov.reasons.push(`${tag}: WR=${(wr * 100).toFixed(1)}% (${r.total} trades) < 35%`);
      }
    } else if (r.total >= 5 && wr >= 0.45) {
      if (r.direction === 'LONG'  && ov.blockLong)  { ov.blockLong  = false; ov.reasons = ov.reasons.filter(x => !x.startsWith(tag)); }
      if (r.direction === 'SHORT' && ov.blockShort) { ov.blockShort = false; ov.reasons = ov.reasons.filter(x => !x.startsWith(tag)); }
    }
  }

  for (const r of sessRows) {
    const strat = r.strategy_name; if (!strat || !r.session) continue;
    ensureEntry(strat);
    const ov = result[strat];
    const wr = r.total > 0 ? r.wins / r.total : 0;
    const tag = `block-session(${r.session})`;

    if (r.total >= 5 && wr < 0.35) {
      if (!ov.blockedSessions.includes(r.session)) {
        ov.blockedSessions.push(r.session);
        if (!ov.reasons.some(x => x.startsWith(tag))) {
          ov.reasons.push(`${tag}: WR=${(wr * 100).toFixed(1)}% (${r.total} trades) < 35%`);
        }
      }
    } else if (r.total >= 5 && wr >= 0.45 && ov.blockedSessions.includes(r.session)) {
      ov.blockedSessions = ov.blockedSessions.filter(s => s !== r.session);
      ov.reasons = ov.reasons.filter(x => !x.startsWith(tag));
    }
  }

  saveAdaptiveOverrides(db, result);
  return result;
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
  buildPatternKey,
  loadPatternMemory,
  updatePatternMemory,
  getPatternAdjustment,
  loadAdaptiveOverrides,
  saveAdaptiveOverrides,
  computeAdaptiveOverrides,
  // New exports
  getInstrumentProfile,
  detectEdgeDegradation,
  isThresholdChangeSafe,
};
