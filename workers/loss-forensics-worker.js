'use strict';

/**
 * LOSS FORENSICS WORKER
 *
 * Classifies every unclassified loss/BE into a failure_category using a
 * deterministic rule engine. Writes to loss_forensics table (INSERT OR IGNORE
 * on signal_id — idempotent). Also posts agent_messages observations for the
 * consensus engine when a systemic failure pattern is detected.
 *
 * PM2 cron: 0 * /2 * * * (every 2 hours)
 * autorestart: false — runs once, exits.
 *
 * Classifier v1.0 categories (priority order):
 *   news_spike       — rapid adverse move in < 3 min (macro/news)
 *   volatility_sweep — swept by a spike then recovered (MFE > 0, MAE > 2× risk)
 *   htf_conflict     — HTF bias conflicted with direction at entry
 *   chop_fakeout     — choppy regime at entry; no trend structure
 *   late_entry       — entered far from VWAP (> 2× ATR distance)
 *   exhaustion       — RSI extreme at entry (overbought long / oversold short)
 *   session_fade     — loss during MIDDAY/PM (low-edge sessions)
 *   low_rr           — entry RR < 1.2 (bad trade geometry)
 *   unclassified     — insufficient data to determine
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME          = 'loss-forensics';
const CLASSIFIER_VERSION   = '1.0';
const LOOKBACK_DAYS        = 30;
const SYSTEMIC_THRESHOLD   = 0.45; // if one category > 45% of losses → post agent message

// ── Failure classifier ─────────────────────────────────────────────────────────
// Returns { category, subcategory } from signal + outcome + features data.

function classify(sig, out, feat) {
  const dir = sig.direction; // 'LONG' | 'SHORT'

  // ── 1. News spike: stopped out in < 3 min with large MAE ──────────────────
  if (out.hold_time_min != null && out.hold_time_min < 3 &&
      out.mae_pts != null && out.pnl_pts != null &&
      Math.abs(out.mae_pts) > Math.abs(out.pnl_pts) * 1.8) {
    return { category: 'news_spike', subcategory: `hold=${out.hold_time_min?.toFixed(1)}m` };
  }

  // ── 2. Volatility sweep: had positive MFE then got stopped ────────────────
  if (out.mfe_pts != null && out.mae_pts != null && out.pnl_pts != null) {
    const mfe = Math.abs(out.mfe_pts);
    const mae = Math.abs(out.mae_pts);
    const loss = Math.abs(out.pnl_pts);
    if (mfe > loss * 0.3 && mae > loss * 1.5) {
      return { category: 'volatility_sweep', subcategory: `mfe=${mfe.toFixed(1)}pts` };
    }
  }

  // ── 3. HTF conflict ────────────────────────────────────────────────────────
  if (feat) {
    const htf1h  = feat.htf_1h_bias;
    const htf4h  = feat.htf_4h_bias;
    const isLong = dir === 'LONG';
    // At least 2 HTF levels clearly opposing direction
    const conflicts = [htf1h, htf4h].filter(b => b != null && ((isLong && b < 0) || (!isLong && b > 0))).length;
    if (conflicts >= 2) {
      return { category: 'htf_conflict', subcategory: `htf1h=${htf1h} htf4h=${htf4h}` };
    }
  }

  // ── 4. Chop fakeout ────────────────────────────────────────────────────────
  if (feat) {
    const isChopRegime = feat.regime && (feat.regime.includes('CHOP') || feat.regime === 'SOFT_CHOP');
    const highChopScore = feat.chop_score != null && feat.chop_score > 0.45;
    if (isChopRegime || highChopScore) {
      return {
        category: 'chop_fakeout',
        subcategory: `regime=${feat.regime ?? 'unknown'} chop=${feat.chop_score?.toFixed(2) ?? 'N/A'}`,
      };
    }
  }

  // ── 5. Late entry ──────────────────────────────────────────────────────────
  if (feat && feat.vwap_dist_atr != null && feat.atr != null) {
    if (feat.vwap_dist_atr > 2.0) {
      return { category: 'late_entry', subcategory: `vwap_dist_atr=${feat.vwap_dist_atr.toFixed(2)}` };
    }
  }

  // ── 6. Exhaustion ──────────────────────────────────────────────────────────
  if (feat && feat.rsi != null) {
    const rsi = feat.rsi;
    const isLong = dir === 'LONG';
    if ((isLong && rsi > 70) || (!isLong && rsi < 30)) {
      return { category: 'exhaustion', subcategory: `rsi=${rsi.toFixed(1)}` };
    }
  }

  // ── 7. Session fade ────────────────────────────────────────────────────────
  const session = (feat?.session ?? sig.session ?? '').toUpperCase();
  if (session === 'MIDDAY' || session === 'PM' || session === 'LATE_DAY') {
    return { category: 'session_fade', subcategory: session };
  }

  // ── 8. Low RR ──────────────────────────────────────────────────────────────
  if (sig.rr != null && sig.rr < 1.2) {
    return { category: 'low_rr', subcategory: `rr=${sig.rr.toFixed(2)}` };
  }

  return { category: 'unclassified', subcategory: null };
}

// ── Post agent message if a systemic pattern is detected ──────────────────────

function postSystemicAlert(db, strategy, category, pct, periodDays) {
  try {
    const payload = JSON.stringify({
      observation: 'systemic_failure_detected',
      strategy,
      failure_category: category,
      pct_of_losses: +pct.toFixed(4),
      period_days: periodDays,
      timestamp: new Date().toISOString(),
    });
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('loss-forensics', 'consensus', 'observation', ?, ?, 3)
    `).run(strategy, payload);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] Failed to post agent message: ${err.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  // Find unclassified losses/BEs within the lookback window
  const unclassified = db.prepare(`
    SELECT
      o.id AS outcome_id,
      o.signal_id,
      o.result,
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
      s.sl
    FROM outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE o.result IN ('LOSS', 'BE')
      AND o.exit_at >= datetime('now', ? || ' days')
      AND NOT EXISTS (
        SELECT 1 FROM loss_forensics lf WHERE lf.signal_id = o.signal_id
      )
    ORDER BY o.exit_at DESC
    LIMIT 500
  `).all(`-${LOOKBACK_DAYS}`);

  const getFeat = db.prepare(
    'SELECT * FROM signal_features WHERE signal_id = ? LIMIT 1'
  );

  let classified = 0;
  let skipped    = 0;

  for (const row of unclassified) {
    try {
      let feat = null;
      try { feat = getFeat.get(row.signal_id); } catch (_) {}

      const { category, subcategory } = classify(row, row, feat);

      const dow = row.exit_at
        ? new Date(row.exit_at).getUTCDay()
        : null;

      db.prepare(`
        INSERT OR IGNORE INTO loss_forensics
          (signal_id, strategy_name, instrument, direction, result,
           failure_category, failure_subcategory, classifier_version,
           session, day_of_week, regime, htf_bias, confidence,
           setup_type, hold_time_min, mfe_pts, mae_pts, pnl_pts,
           entry, sl, data_quality, auto_flagged)
        VALUES
          (?, ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, 1)
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
        row.hold_time_min,
        row.mfe_pts,
        row.mae_pts,
        row.pnl_pts,
        row.entry,
        row.sl,
        feat ? 'full' : 'signal_only',
      );
      classified++;
    } catch (err) {
      console.error(`[${WORKER_NAME}] signal ${row.signal_id} error: ${err.message}`);
      skipped++;
    }
  }

  // ── Systemic pattern detection ─────────────────────────────────────────────
  // If any single failure category > SYSTEMIC_THRESHOLD of 14d losses → alert
  const strategies = [...new Set(unclassified.map(r => r.strategy_name).filter(Boolean))];
  for (const strategy of strategies) {
    try {
      const rows = db.prepare(`
        SELECT failure_category, COUNT(*) n
        FROM loss_forensics
        WHERE strategy_name = ?
          AND created_at >= datetime('now', '-14 days')
        GROUP BY failure_category
        ORDER BY n DESC
      `).all(strategy);

      const total = rows.reduce((s, r) => s + r.n, 0);
      if (total < 5) continue;

      const top = rows[0];
      if (top && top.n / total > SYSTEMIC_THRESHOLD) {
        postSystemicAlert(db, strategy, top.failure_category, top.n / total, 14);
        console.log(`[${WORKER_NAME}] Systemic alert: ${strategy} → ${top.failure_category} (${(top.n/total*100).toFixed(0)}%)`);
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

  console.log(`[${WORKER_NAME}] Done — classified ${classified}/${unclassified.length} losses`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
