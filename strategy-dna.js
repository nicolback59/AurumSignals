'use strict';

/**
 * STRATEGY DNA — Winner Fingerprinting & Adaptive Pattern Intelligence
 *
 * Analyzes every winning backtest and live trade to extract the specific
 * conditions that drive profitability. Builds a continuously updated DNA
 * model per instrument that the live scanner uses to:
 *
 *   1. Boost confidence when a signal matches proven winning patterns
 *   2. Relax confidence thresholds in historically strong timing windows
 *   3. Tighten gates when conditions match historically losing patterns
 *   4. Guide the strategy optimizer toward DNA-proven parameter space
 *   5. Surface actionable insights about what is actually working
 *
 * DNA is stored in strategy_params under instrument-specific keys and
 * updated after every backtest cycle and after every batch of resolved
 * live signal outcomes.
 *
 * Architecture:
 *   ComboFingerprint — strategy + direction + session + regime + htf_bias
 *   TimingFingerprint — hour_et + day_of_week
 *   QualityFingerprint — confidence_band + regime + trade_style
 *   InstrumentProfile — instrument-level behavioral differences (MNQ vs MGC)
 *
 * DNA Score (0–100):
 *   combo_wr × 0.50 + timing_wr × 0.25 + quality_wr × 0.25
 *   → translated into a confidence gate adjustment (−12 to +16)
 */

// ── DB helpers ────────────────────────────────────────────────────────────────

function _q(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

// ── Key builders ──────────────────────────────────────────────────────────────

function comboKey(strategyName, direction, session, regime, htfBias) {
  const s = (session   ?? 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20);
  const r = (regime    ?? 'unknown').toLowerCase().slice(0, 10);
  const h = (htfBias   ?? 'X').toString().toUpperCase().slice(0, 4);
  return `${strategyName}::${direction}::${s}::${r}::${h}`;
}

function timingKey(timestamp) {
  try {
    const d = new Date(timestamp);
    // Convert to approximate ET (UTC-5 standard, ignoring DST for consistency)
    const hourEt  = ((d.getUTCHours() - 5 + 24) % 24);
    const dayOfWk = d.getUTCDay(); // 0=Sun…6=Sat
    // Bucket hours into 2-hour windows
    const hourBucket = Math.floor(hourEt / 2) * 2;
    return `h${hourBucket}::dow${dayOfWk}`;
  } catch { return 'unknown'; }
}

function qualityKey(confidence, regime, tradeStyle) {
  const band = confidence >= 85 ? 'high' : confidence >= 70 ? 'mid' : 'low';
  const r    = (regime     ?? 'unknown').slice(0, 10);
  const ts   = (tradeStyle ?? 'unknown').slice(0, 10);
  return `${band}::${r}::${ts}`;
}

// ── Feature extraction from a trade record ────────────────────────────────────

function extractFeatures(trade) {
  return {
    combo:   comboKey(trade.strategy_name, trade.direction, trade.session, trade.regime, trade.htf_bias),
    timing:  timingKey(trade.timestamp),
    quality: qualityKey(trade.confidence, trade.regime, trade.trade_style),
    instrument: trade.instrument ?? 'MNQ',
    outcome: trade.outcome ?? 'BE',
    pnlPts:  trade.pnl_pts ?? trade.pnlPts ?? 0,
    rr:      trade.rr ?? 1.5,
    conf:    trade.confidence ?? 70,
  };
}

// ── Bucket aggregation ────────────────────────────────────────────────────────

function _accumulate(buckets, key, outcome, pnlPts) {
  if (!buckets[key]) buckets[key] = { wins: 0, losses: 0, total: 0, pnlSum: 0 };
  buckets[key].total++;
  buckets[key].pnlSum += pnlPts ?? 0;
  if (outcome === 'WIN')  buckets[key].wins++;
  if (outcome === 'LOSS') buckets[key].losses++;
}

function _toStats(bucket) {
  const resolved = bucket.wins + bucket.losses;
  return {
    wins:    bucket.wins,
    losses:  bucket.losses,
    total:   bucket.total,
    wr:      resolved > 0 ? +(bucket.wins / resolved).toFixed(4) : null,
    pf:      bucket.losses > 0 ? +(bucket.wins * 1.5 / bucket.losses).toFixed(3) : null,
    pnlAvg:  bucket.total  > 0 ? +(bucket.pnlSum / bucket.total).toFixed(2)    : 0,
  };
}

// ── Build DNA from trade list ─────────────────────────────────────────────────

function buildDNAFromTrades(trades, instrument) {
  const comboBuckets   = {};
  const timingBuckets  = {};
  const qualityBuckets = {};

  for (const t of trades) {
    if ((instrument && t.instrument && t.instrument !== instrument)) continue;
    const f = extractFeatures(t);
    if (!f.combo) continue;
    _accumulate(comboBuckets,   f.combo,   f.outcome, f.pnlPts);
    _accumulate(timingBuckets,  f.timing,  f.outcome, f.pnlPts);
    _accumulate(qualityBuckets, f.quality, f.outcome, f.pnlPts);
  }

  const combo   = {};
  const timing  = {};
  const quality = {};

  for (const [k, v] of Object.entries(comboBuckets))   combo[k]   = _toStats(v);
  for (const [k, v] of Object.entries(timingBuckets))  timing[k]  = _toStats(v);
  for (const [k, v] of Object.entries(qualityBuckets)) quality[k] = _toStats(v);

  // Top winning combos (≥5 trades, WR ≥ 60%)
  const topCombos = Object.entries(combo)
    .filter(([, s]) => s.total >= 5 && s.wr !== null && s.wr >= 0.60)
    .sort(([, a], [, b]) => (b.wr ?? 0) - (a.wr ?? 0))
    .slice(0, 20)
    .map(([k, s]) => ({ key: k, ...s }));

  // Bottom losing combos (≥5 trades, WR ≤ 38%)
  const weakCombos = Object.entries(combo)
    .filter(([, s]) => s.total >= 5 && s.wr !== null && s.wr <= 0.38)
    .sort(([, a], [, b]) => (a.wr ?? 1) - (b.wr ?? 1))
    .slice(0, 10)
    .map(([k, s]) => ({ key: k, ...s }));

  // Best timing windows (≥8 trades, WR ≥ 62%)
  const strongWindows = Object.entries(timing)
    .filter(([, s]) => s.total >= 8 && s.wr !== null && s.wr >= 0.62)
    .sort(([, a], [, b]) => (b.wr ?? 0) - (a.wr ?? 0))
    .slice(0, 8)
    .map(([k, s]) => ({ key: k, ...s }));

  // Worst timing windows
  const weakWindows = Object.entries(timing)
    .filter(([, s]) => s.total >= 8 && s.wr !== null && s.wr <= 0.40)
    .sort(([, a], [, b]) => (a.wr ?? 1) - (b.wr ?? 1))
    .slice(0, 4)
    .map(([k, s]) => ({ key: k, ...s }));

  return {
    instrument: instrument ?? 'ALL',
    updated_at: new Date().toISOString(),
    trade_count: trades.length,
    combo, timing, quality,
    topCombos, weakCombos, strongWindows, weakWindows,
  };
}

// ── DNA persistence ───────────────────────────────────────────────────────────

const DNA_KEY_PREFIX = 'DNA_';

function loadDNA(db, instrument) {
  try {
    const row = db.prepare(
      'SELECT params_json FROM strategy_params WHERE instrument = ?'
    ).get(`${DNA_KEY_PREFIX}${instrument}`);
    if (row) return JSON.parse(row.params_json);
  } catch {}
  return null;
}

function saveDNA(db, instrument, dna) {
  try {
    db.prepare(`
      INSERT INTO strategy_params (instrument, params_json, updated_at, version)
      VALUES (?, ?, datetime('now'), 1)
      ON CONFLICT(instrument) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = excluded.updated_at,
        version     = version + 1
    `).run(`${DNA_KEY_PREFIX}${instrument}`, JSON.stringify(dna));
  } catch { /* never crash */ }
}

// ── Update DNA from backtest signal log ───────────────────────────────────────

/**
 * Called after every backtest cycle with the full signal log.
 * Merges new trades into the existing DNA — incremental, not overwrite.
 */
function updateDNAFromBacktest(db, instrument, signalLog) {
  if (!signalLog || !signalLog.length) return null;

  const validTrades = signalLog
    .filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS')
    .map(t => ({ ...t, instrument }));

  if (!validTrades.length) return null;

  // Load existing DNA and merge
  const existing = loadDNA(db, instrument);
  const allTrades = _mergeWithExistingTrades(db, instrument, validTrades);
  const newDNA    = buildDNAFromTrades(allTrades, instrument);

  saveDNA(db, instrument, newDNA);
  return newDNA;
}

/**
 * Pull the last 5-run backtest trades from DB + merge with new ones for full DNA.
 */
function _mergeWithExistingTrades(db, instrument, newTrades) {
  const dbTrades = _q(db, `
    SELECT t.strategy_name, t.direction, t.session, t.htf_bias, t.regime,
           t.trade_style, t.outcome, t.confidence, t.timestamp,
           t.pnl_pts, t.rr, ? AS instrument
    FROM   backtest_trades t
    WHERE  t.instrument = ?
      AND  t.outcome IN ('WIN', 'LOSS')
      AND  t.run_id IN (SELECT id FROM backtest_runs WHERE instrument = ? ORDER BY run_at DESC LIMIT 8)
  `, [instrument, instrument, instrument]);

  return [...dbTrades, ...newTrades];
}

/**
 * Update DNA from live signal outcomes.
 * Called after auto-resolving live outcomes.
 */
function updateDNAFromLive(db, instrument) {
  const liveTrades = _q(db, `
    SELECT s.strategy_name, s.direction, s.session, s.htf_bias,
           s.trade_style, s.score AS confidence, s.rr, s.received_at AS timestamp,
           o.result AS outcome, o.pnl_pts,
           ? AS instrument, 'unknown' AS regime
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.instrument = ?
      AND  o.result IN ('WIN', 'LOSS')
      AND  s.received_at >= datetime('now', '-60 days')
  `, [instrument, instrument]);

  if (!liveTrades.length) return null;

  const backtracked = _mergeWithExistingTrades(db, instrument, liveTrades);
  const dna = buildDNAFromTrades(backtracked, instrument);
  saveDNA(db, instrument, dna);
  return dna;
}

// ── DNA Scoring — how well does a candidate signal match winning DNA? ─────────

/**
 * Returns a 0–100 DNA score for a candidate signal.
 *
 * Formula: comboWR×0.50 + timingWR×0.25 + qualityWR×0.25
 * Neutral (50) when no data is available.
 *
 * @param {object} dna      - loaded DNA for this instrument
 * @param {object} signal   - candidate signal { strategy_name, direction, session,
 *                            regime, htf_bias, trade_style, confidence, timestamp }
 * @returns {{ dnaScore, comboWR, timingWR, qualityWR, topMatch, weakMatch, adjustment }}
 */
function getDNAScore(dna, signal) {
  const NEUTRAL = 50;

  if (!dna) return {
    dnaScore: NEUTRAL, comboWR: null, timingWR: null, qualityWR: null,
    topMatch: null, weakMatch: null, adjustment: 0, source: 'no_dna',
  };

  const ck = comboKey(signal.strategy_name, signal.direction, signal.session, signal.regime, signal.htf_bias);
  const tk = timingKey(signal.timestamp);
  const qk = qualityKey(signal.confidence, signal.regime, signal.trade_style);

  const comboStats   = dna.combo?.[ck];
  const timingStats  = dna.timing?.[tk];
  const qualityStats = dna.quality?.[qk];

  const MIN_COMBO   = 5;
  const MIN_TIMING  = 8;
  const MIN_QUALITY = 5;

  const comboWR   = (comboStats   && comboStats.total   >= MIN_COMBO)   ? comboStats.wr   : null;
  const timingWR  = (timingStats  && timingStats.total  >= MIN_TIMING)  ? timingStats.wr  : null;
  const qualityWR = (qualityStats && qualityStats.total >= MIN_QUALITY) ? qualityStats.wr : null;

  // Normalize each WR component to 0–100 scale (0% WR→0, 100%→100)
  const toScore = (wr) => wr != null ? Math.round(wr * 100) : NEUTRAL;

  const dnaScore = Math.round(
    toScore(comboWR)   * 0.50 +
    toScore(timingWR)  * 0.25 +
    toScore(qualityWR) * 0.25
  );

  // Top and weak fingerprint matching
  const topMatch  = dna.topCombos?.find(c => c.key === ck);
  const weakMatch = dna.weakCombos?.find(c => c.key === ck);

  // Confidence gate adjustment from DNA score
  // Strong DNA match → lower bar (more signals); weak → raise bar (fewer false positives)
  let adjustment = 0;
  if      (dnaScore >= 80 && (comboStats?.total ?? 0) >= MIN_COMBO)  adjustment = -10;
  else if (dnaScore >= 72 && (comboStats?.total ?? 0) >= MIN_COMBO)  adjustment = -6;
  else if (dnaScore >= 65)                                            adjustment = -3;
  else if (dnaScore >= 55)                                            adjustment =  0;
  else if (dnaScore < 40 && (comboStats?.total ?? 0) >= MIN_COMBO)   adjustment = +8;
  else if (dnaScore < 32 && (comboStats?.total ?? 0) >= MIN_COMBO)   adjustment = +14;

  // Boost if signal exactly matches a top combo pattern
  if (topMatch  && topMatch.wr  >= 0.72) adjustment = Math.min(-12, adjustment);
  // Additional penalty if signal matches a known weak combo
  if (weakMatch && weakMatch.wr <= 0.30) adjustment = Math.max(+18, adjustment);

  return {
    dnaScore,
    comboWR,
    timingWR,
    qualityWR,
    topMatch:  topMatch  ?? null,
    weakMatch: weakMatch ?? null,
    adjustment,
    comboKey:   ck,
    timingKey:  tk,
    qualityKey: qk,
    source:     comboWR !== null ? 'full' : timingWR !== null ? 'timing_only' : 'neutral',
  };
}

// ── Timing Window Gate ────────────────────────────────────────────────────────

/**
 * Returns the current timing window's historical performance for a given instrument.
 * Used by the live scanner to relax or tighten the confidence gate within the
 * daily minimum signal guarantee logic.
 *
 * @returns {{ isStrongWindow, isWeakWindow, timingWR, windowKey }}
 */
function getTimingWindowStatus(dna, timestamp) {
  const tk = timingKey(timestamp);
  const stats = dna?.timing?.[tk];

  if (!stats || stats.total < 8) {
    return { isStrongWindow: false, isWeakWindow: false, timingWR: null, windowKey: tk };
  }

  return {
    isStrongWindow: stats.wr !== null && stats.wr >= 0.65,
    isWeakWindow:   stats.wr !== null && stats.wr <= 0.38,
    timingWR:       stats.wr,
    timingN:        stats.total,
    windowKey:      tk,
  };
}

// ── DNA Guidance for Optimizer ────────────────────────────────────────────────

/**
 * Returns optimizer guidance derived from DNA analysis:
 *   - Which sessions have the strongest WR → relax session filters there
 *   - Which regimes have the strongest WR → weight them higher in optimizer
 *   - Which confidence bands perform best → calibrate threshold around them
 *   - Parameter suggestions based on top winning patterns
 *
 * @param {object} dna
 * @param {string} instrument
 * @returns {object} guidance
 */
function getDNAGuidance(dna, instrument) {
  if (!dna) return { available: false };

  // Extract session WRs from combo keys
  const sessionWRs = {};
  for (const [key, stats] of Object.entries(dna.combo ?? {})) {
    if (stats.total < 5 || stats.wr === null) continue;
    const parts = key.split('::');
    const sess  = parts[2] ?? 'unknown';
    if (!sessionWRs[sess]) sessionWRs[sess] = [];
    sessionWRs[sess].push(stats.wr);
  }

  const sessionAvgWR = {};
  for (const [sess, wrs] of Object.entries(sessionWRs)) {
    sessionAvgWR[sess] = +(wrs.reduce((a, b) => a + b, 0) / wrs.length).toFixed(3);
  }

  // Best and worst sessions
  const sortedSessions = Object.entries(sessionAvgWR)
    .sort(([, a], [, b]) => b - a);
  const bestSessions  = sortedSessions.slice(0, 3).map(([s, w]) => ({ session: s, avg_wr: w }));
  const worstSessions = sortedSessions.slice(-2).map(([s, w]) => ({ session: s, avg_wr: w }));

  // Extract regime WRs from combo keys
  const regimeWRs = {};
  for (const [key, stats] of Object.entries(dna.combo ?? {})) {
    if (stats.total < 5 || stats.wr === null) continue;
    const parts  = key.split('::');
    const regime = parts[3] ?? 'unknown';
    if (!regimeWRs[regime]) regimeWRs[regime] = [];
    regimeWRs[regime].push(stats.wr);
  }
  const regimeAvgWR = {};
  for (const [reg, wrs] of Object.entries(regimeWRs)) {
    regimeAvgWR[reg] = +(wrs.reduce((a, b) => a + b, 0) / wrs.length).toFixed(3);
  }

  // Best confidence band (from quality keys)
  const bandWRs = { high: [], mid: [], low: [] };
  for (const [key, stats] of Object.entries(dna.quality ?? {})) {
    if (stats.total < 5 || stats.wr === null) continue;
    const band = key.split('::')[0];
    if (bandWRs[band]) bandWRs[band].push(stats.wr);
  }
  const optimalBand = Object.entries(bandWRs)
    .map(([b, wrs]) => ({
      band: b,
      avg_wr: wrs.length ? wrs.reduce((a, c) => a + c, 0) / wrs.length : 0,
    }))
    .sort((a, b) => b.avg_wr - a.avg_wr)[0];

  // Top timing windows for parameter hints
  const strongWindowHours = (dna.strongWindows ?? [])
    .map(w => {
      const parts = w.key.split('::');
      return { hour_bucket: parseInt(parts[0]?.replace('h', '') ?? '0'), wr: w.wr, n: w.total };
    })
    .filter(w => !isNaN(w.hour_bucket))
    .slice(0, 4);

  // Threshold suggestions: if top combos WR > 72%, threshold can be lowered safely
  const topComboWRs  = (dna.topCombos  ?? []).map(c => c.wr).filter(Boolean);
  const weakComboWRs = (dna.weakCombos ?? []).map(c => c.wr).filter(Boolean);
  const avgTopWR  = topComboWRs.length  ? topComboWRs.reduce((a, b)  => a + b, 0) / topComboWRs.length  : null;
  const avgWeakWR = weakComboWRs.length ? weakComboWRs.reduce((a, b) => a + b, 0) / weakComboWRs.length : null;

  let thresholdHint = null;
  if (avgTopWR !== null && avgTopWR >= 0.72) {
    thresholdHint = { action: 'lower', magnitude: 3, reason: `Top combos avg WR=${(avgTopWR*100).toFixed(0)}% — threshold can be safely relaxed for matched conditions` };
  } else if (avgWeakWR !== null && avgWeakWR <= 0.35) {
    thresholdHint = { action: 'raise', magnitude: 4, reason: `Weak combos avg WR=${(avgWeakWR*100).toFixed(0)}% — threshold should be raised for unmatched conditions` };
  }

  return {
    available:         true,
    instrument,
    top_combo_count:   dna.topCombos?.length  ?? 0,
    weak_combo_count:  dna.weakCombos?.length ?? 0,
    bestSessions,
    worstSessions,
    regimeAvgWR,
    optimalBand,
    strongWindowHours,
    thresholdHint,
    tradeCount:        dna.trade_count ?? 0,
    updatedAt:         dna.updated_at ?? null,
  };
}

// ── DNA Insights — plain-language analysis ────────────────────────────────────

function getDNAInsights(db, instrument) {
  const dna = loadDNA(db, instrument);
  if (!dna) return { instrument, status: 'no_dna_data', insights: [] };

  const insights = [];
  const guidance = getDNAGuidance(dna, instrument);

  // Top winning patterns
  for (const c of (dna.topCombos ?? []).slice(0, 5)) {
    const parts = c.key.split('::');
    insights.push({
      type:     'strength',
      pattern:  c.key,
      strategy: parts[0],
      direction: parts[1],
      session:  parts[2],
      regime:   parts[3],
      htf_bias: parts[4],
      wr_pct:   c.wr != null ? +(c.wr * 100).toFixed(1) : null,
      n:        c.total,
      message:  `[STRENGTH] ${parts[0]} ${parts[1]} in ${parts[2].replace(/_/g,' ')} (${parts[3]} regime, HTF=${parts[4]}): ${c.wr != null ? (c.wr*100).toFixed(0) : '?'}% WR on ${c.total} trades — DNA gate relaxed for this pattern`,
    });
  }

  // Known weak patterns
  for (const c of (dna.weakCombos ?? []).slice(0, 5)) {
    const parts = c.key.split('::');
    insights.push({
      type:    'weakness',
      pattern: c.key,
      wr_pct:  c.wr != null ? +(c.wr * 100).toFixed(1) : null,
      n:       c.total,
      message: `[WEAKNESS] ${parts[0]} ${parts[1]} in ${parts[2].replace(/_/g,' ')} (${parts[3]}): ${c.wr != null ? (c.wr*100).toFixed(0) : '?'}% WR on ${c.total} trades — gate raised, deprioritized`,
    });
  }

  // Timing windows
  for (const w of (dna.strongWindows ?? []).slice(0, 3)) {
    const parts = w.key.split('::');
    const h = parseInt(parts[0]?.replace('h', '') ?? '0');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = parseInt(parts[1]?.replace('dow', '') ?? '0');
    insights.push({
      type:    'timing',
      key:     w.key,
      wr_pct:  w.wr != null ? +(w.wr * 100).toFixed(1) : null,
      n:       w.total,
      message: `[TIMING STRENGTH] ${dayNames[dow] ?? '?'} ${h}:00–${h+2}:00 ET: ${w.wr != null ? (w.wr*100).toFixed(0) : '?'}% WR on ${w.total} trades — confidence gate relaxed during this window`,
    });
  }

  for (const w of (dna.weakWindows ?? []).slice(0, 2)) {
    const parts = w.key.split('::');
    const h = parseInt(parts[0]?.replace('h', '') ?? '0');
    insights.push({
      type:    'timing_weak',
      key:     w.key,
      wr_pct:  w.wr != null ? +(w.wr * 100).toFixed(1) : null,
      n:       w.total,
      message: `[TIMING WEAKNESS] ${h}:00–${h+2}:00 ET: ${w.wr != null ? (w.wr*100).toFixed(0) : '?'}% WR on ${w.total} trades — confidence gate raised, signals suppressed in this window`,
    });
  }

  // Session guidance
  if (guidance.bestSessions?.length) {
    const bs = guidance.bestSessions[0];
    insights.push({
      type:    'session_best',
      session: bs.session,
      wr_pct:  +(bs.avg_wr * 100).toFixed(1),
      message: `[SESSION EDGE] Best session for ${instrument}: "${bs.session}" (avg WR=${(bs.avg_wr*100).toFixed(0)}%) — prioritize trades here`,
    });
  }
  if (guidance.worstSessions?.length) {
    const ws = guidance.worstSessions[0];
    insights.push({
      type:    'session_worst',
      session: ws.session,
      wr_pct:  +(ws.avg_wr * 100).toFixed(1),
      message: `[SESSION RISK] Worst session for ${instrument}: "${ws.session}" (avg WR=${(ws.avg_wr*100).toFixed(0)}%) — session gate should be tightened`,
    });
  }

  // Threshold hint
  if (guidance.thresholdHint) {
    insights.push({
      type:    'threshold',
      action:  guidance.thresholdHint.action,
      message: `[THRESHOLD] ${guidance.thresholdHint.reason}`,
    });
  }

  return {
    instrument,
    status:      'ok',
    trade_count: dna.trade_count ?? 0,
    updated_at:  dna.updated_at,
    top_patterns: dna.topCombos?.length  ?? 0,
    weak_patterns: dna.weakCombos?.length ?? 0,
    insights,
    guidance,
  };
}

// ── DNA-informed confidence adjustment (used by scanner) ─────────────────────

/**
 * Returns the final effective confidence gate adjustment for a candidate signal
 * based on its DNA score, combining:
 *   1. DNA combo match (strongest factor)
 *   2. Timing window strength
 *   3. Pattern memory consistency (passed in from learning.js)
 *
 * @param {object} dna      - loaded DNA object
 * @param {object} signal   - candidate signal object
 * @returns {number} gate adjustment (-12 to +18)
 */
function getDNAGateAdjustment(dna, signal) {
  const { adjustment, isWeakWindow, isStrongWindow } = (() => {
    const score  = getDNAScore(dna, signal);
    const timing = getTimingWindowStatus(dna, signal.timestamp);
    let timingAdj = 0;
    if (timing.isStrongWindow) timingAdj = -4;
    if (timing.isWeakWindow)   timingAdj = +5;
    return { adjustment: score.adjustment + timingAdj, ...timing };
  })();

  // Cap total adjustment
  return Math.max(-12, Math.min(18, adjustment));
}

module.exports = {
  buildDNAFromTrades,
  updateDNAFromBacktest,
  updateDNAFromLive,
  loadDNA,
  saveDNA,
  getDNAScore,
  getDNAGateAdjustment,
  getDNAInsights,
  getDNAGuidance,
  getTimingWindowStatus,
  comboKey,
  timingKey,
  qualityKey,
};
