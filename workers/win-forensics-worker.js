'use strict';

/**
 * WIN FORENSICS WORKER
 *
 * Classifies every unclassified WIN/BE into a win_category using a rule engine.
 * Writes to win_forensics table (INSERT OR IGNORE — idempotent). Posts
 * agent_messages observations when a dominant win archetype is identified
 * (enables the consensus engine to suggest leaning into winning patterns).
 *
 * PM2 cron: 0 * /4 * * * (every 4 hours)
 * autorestart: false — runs once, exits.
 *
 * Win categories (priority order):
 *   sweep_reversal       — liquidity sweep then institutional reversal (CHoCH)
 *   fade_extreme         — overbought/oversold mean-reversion
 *   vwap_reclaim         — price reclaimed VWAP and ran
 *   compression_breakout — tight range broke out cleanly
 *   clean_trend          — entered in confirmed trend, rode it to TP2+
 *   momentum_continuation— quick re-entry in trending move (< 20 bars to TP)
 *   session_open_play    — London or NY open directional play
 *   htf_confluence       — all 3 HTF biases aligned with direction
 *   generic_win          — insufficient data to classify
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME          = 'win-forensics';
const CLASSIFIER_VERSION   = '1.0';
const LOOKBACK_DAYS        = 30;
const DOMINANT_THRESHOLD   = 0.40; // if one category > 40% of wins → post agent message

// Determine which TP was reached based on exit_price and signal targets.
// Returns 1-4, or 0 for BE, or null if undetermined.
function inferTpReached(sig, out) {
  if (!out.exit_price || !sig.entry) return null;
  const isLong  = sig.direction === 'LONG';
  const exitDist = isLong
    ? out.exit_price - sig.entry
    : sig.entry - out.exit_price;

  if (exitDist <= 0) return 0; // BE or slight loss that was rounded to WIN
  if (sig.tp4 && isLong  ? out.exit_price >= sig.tp4 : sig.tp4 && out.exit_price <= sig.tp4) return 4;
  if (sig.tp3 && isLong  ? out.exit_price >= sig.tp3 : sig.tp3 && out.exit_price <= sig.tp3) return 3;
  if (sig.tp2 && isLong  ? out.exit_price >= sig.tp2 : sig.tp2 && out.exit_price <= sig.tp2) return 2;
  if (sig.tp1 && isLong  ? out.exit_price >= sig.tp1 : sig.tp1 && out.exit_price <= sig.tp1) return 1;
  return null;
}

// Count HTF biases aligned with direction (0-3).
function countHtfAlignment(feat, dir) {
  if (!feat) return 0;
  const isLong = dir === 'LONG';
  return [feat.htf_15m_bias, feat.htf_1h_bias, feat.htf_4h_bias]
    .filter(b => b != null && ((isLong && b > 0) || (!isLong && b < 0)))
    .length;
}

// ── Win classifier ─────────────────────────────────────────────────────────────

function classify(sig, out, feat) {
  const dir     = sig.direction;
  const archetype = feat?.archetype ?? '';

  // ── 1. Sweep reversal ──────────────────────────────────────────────────────
  if (archetype === 'sweep_reversal' || archetype === 'liquidity_sweep') {
    return { category: 'sweep_reversal', subcategory: `arch=${archetype}` };
  }

  // ── 2. Fade extreme ────────────────────────────────────────────────────────
  if (archetype === 'fade_extreme' || archetype === 'chop_mean_revert') {
    return { category: 'fade_extreme', subcategory: `arch=${archetype}` };
  }
  if (feat?.rsi != null) {
    const isLong = dir === 'LONG';
    if ((isLong && feat.rsi <= 30) || (!isLong && feat.rsi >= 70)) {
      return { category: 'fade_extreme', subcategory: `rsi=${feat.rsi.toFixed(1)}` };
    }
  }

  // ── 3. VWAP reclaim / reject ───────────────────────────────────────────────
  if (archetype === 'vwap_reclaim' || archetype === 'vwap_reject' || archetype === 'vwap_reclaim_reject') {
    return { category: 'vwap_reclaim', subcategory: `arch=${archetype}` };
  }
  if (feat?.vwap_state != null) {
    const state = String(feat.vwap_state).toUpperCase();
    if (state === 'RECLAIM' || state === 'REJECT') {
      return { category: 'vwap_reclaim', subcategory: `vwap_state=${state}` };
    }
  }

  // ── 4. Compression breakout ────────────────────────────────────────────────
  if (archetype === 'compression_breakout' || archetype === 'range_breakout') {
    return { category: 'compression_breakout', subcategory: `arch=${archetype}` };
  }

  // ── 5. Clean trend ─────────────────────────────────────────────────────────
  if (feat?.regime) {
    const isTrend = feat.regime === 'TREND_BULL' || feat.regime === 'TREND_BEAR';
    const htfAlign = countHtfAlignment(feat, dir);
    if (isTrend && htfAlign >= 2) {
      const tp = inferTpReached(sig, out);
      if (tp != null && tp >= 2) {
        return { category: 'clean_trend', subcategory: `regime=${feat.regime} tp=${tp}` };
      }
    }
  }

  // ── 6. Momentum continuation ───────────────────────────────────────────────
  if (out.hold_time_min != null && out.hold_time_min < 20 &&
      feat?.regime && (feat.regime === 'TREND_BULL' || feat.regime === 'TREND_BEAR')) {
    return { category: 'momentum_continuation', subcategory: `hold=${out.hold_time_min?.toFixed(1)}m` };
  }

  // ── 7. Session open play ───────────────────────────────────────────────────
  const session = (feat?.session ?? sig.session ?? '').toUpperCase();
  if (session === 'NY_OPEN' || session === 'LONDON' || session === 'NY_PRE') {
    return { category: 'session_open_play', subcategory: session };
  }

  // ── 8. HTF confluence ─────────────────────────────────────────────────────
  const htfAlign = countHtfAlignment(feat, dir);
  if (htfAlign === 3) {
    return { category: 'htf_confluence', subcategory: 'all3_aligned' };
  }

  return { category: 'generic_win', subcategory: null };
}

// ── Post dominant pattern alert ────────────────────────────────────────────────

function postDominantPattern(db, strategy, category, pct, periodDays) {
  try {
    const payload = JSON.stringify({
      observation: 'dominant_win_pattern_detected',
      strategy,
      win_category: category,
      pct_of_wins: +pct.toFixed(4),
      period_days: periodDays,
      timestamp: new Date().toISOString(),
    });
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('win-forensics', 'consensus', 'observation', ?, ?, 2)
    `).run(strategy, payload);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] Failed to post agent message: ${err.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  const unclassified = db.prepare(`
    SELECT
      o.id AS outcome_id,
      o.signal_id,
      o.result,
      o.exit_price,
      o.pnl_pts,
      o.mfe_pts,
      o.mae_pts,
      o.hold_time_min,
      o.exit_at,
      s.strategy_name,
      s.instrument,
      s.direction,
      s.session,
      s.confidence,
      s.rr,
      s.entry,
      s.sl,
      s.tp1,
      s.tp2,
      s.tp3
    FROM outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE o.result IN ('WIN', 'BE')
      AND o.exit_at >= datetime('now', ? || ' days')
      AND NOT EXISTS (
        SELECT 1 FROM win_forensics wf WHERE wf.signal_id = o.signal_id
      )
    ORDER BY o.exit_at DESC
    LIMIT 500
  `).all(`-${LOOKBACK_DAYS}`);

  const getFeat = db.prepare('SELECT * FROM signal_features WHERE signal_id = ? LIMIT 1');

  let classified = 0;
  let skipped    = 0;

  for (const row of unclassified) {
    try {
      let feat = null;
      try { feat = getFeat.get(row.signal_id); } catch (_) {}

      const { category, subcategory } = classify(row, row, feat);
      const htfAlignment = countHtfAlignment(feat, row.direction);
      const tpReached    = inferTpReached(row, row);
      const rrAchieved   = row.entry && row.sl && row.pnl_pts != null
        ? +(Math.abs(row.pnl_pts) / Math.abs(row.entry - row.sl)).toFixed(2)
        : null;
      const dow = row.exit_at ? new Date(row.exit_at).getUTCDay() : null;

      db.prepare(`
        INSERT OR IGNORE INTO win_forensics
          (signal_id, strategy_name, instrument, direction, result,
           win_category, win_subcategory, classifier_version,
           session, day_of_week, regime, htf_bias, confidence,
           archetype, htf_alignment, tp_reached, hold_time_min,
           mfe_pts, pnl_pts, rr_achieved, entry, data_quality)
        VALUES
          (?, ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?, ?)
      `).run(
        row.signal_id,
        row.strategy_name ?? 'UNKNOWN',
        row.instrument    ?? 'UNKNOWN',
        row.direction,
        row.result,
        category,
        subcategory,
        CLASSIFIER_VERSION,
        feat?.session ?? row.session,
        dow,
        feat?.regime,
        feat?.htf_1h_bias != null ? String(feat.htf_1h_bias) : null,
        row.confidence,
        feat?.archetype,
        htfAlignment,
        tpReached,
        row.hold_time_min,
        row.mfe_pts,
        row.pnl_pts,
        rrAchieved,
        row.entry,
        feat ? 'full' : 'signal_only',
      );
      classified++;
    } catch (err) {
      console.error(`[${WORKER_NAME}] signal ${row.signal_id} error: ${err.message}`);
      skipped++;
    }
  }

  // ── Dominant pattern detection ─────────────────────────────────────────────
  const strategies = [...new Set(unclassified.map(r => r.strategy_name).filter(Boolean))];
  for (const strategy of strategies) {
    try {
      const rows = db.prepare(`
        SELECT win_category, COUNT(*) n
        FROM win_forensics
        WHERE strategy_name = ?
          AND created_at >= datetime('now', '-14 days')
        GROUP BY win_category
        ORDER BY n DESC
      `).all(strategy);

      const total = rows.reduce((s, r) => s + r.n, 0);
      if (total < 5) continue;

      const top = rows[0];
      if (top && top.n / total > DOMINANT_THRESHOLD) {
        postDominantPattern(db, strategy, top.win_category, top.n / total, 14);
        console.log(`[${WORKER_NAME}] Dominant pattern: ${strategy} → ${top.win_category} (${(top.n/total*100).toFixed(0)}%)`);
      }
    } catch (_) {}
  }

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt: new Date().toISOString(),
    classified,
    skipped,
    found: unclassified.length,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — classified ${classified}/${unclassified.length} wins`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
