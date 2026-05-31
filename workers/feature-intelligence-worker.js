'use strict';

/**
 * FEATURE INTELLIGENCE WORKER
 *
 * Analyzes signal_features + outcomes to find which indicator dimensions
 * (regime, session, archetype, HTF alignment, RSI zone, chop score) produce
 * win rates significantly above or below the strategy baseline.
 *
 * Writes findings to feature_correlations (idempotent upserts).
 * Posts observations/recommendations to agent_messages for the consensus
 * coordinator to act on.
 *
 * Significance thresholds:
 *   STRONG   — |wr_delta| ≥ 0.18 with N ≥ 15
 *   MODERATE — |wr_delta| ≥ 0.12 with N ≥ 8
 *   WEAK     — |wr_delta| ≥ 0.07 with N ≥ 6
 *
 * PM2 cron: 30 6 * * * (6:30 AM UTC daily — after strategy-health and calibration)
 * autorestart: false — runs once, exits.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME    = 'feature-intelligence';
const STRATEGIES     = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const PERIODS        = [30, 90];
const MIN_N_WEAK     = 6;
const MIN_N_MODERATE = 8;
const MIN_N_STRONG   = 15;
const DELTA_WEAK     = 0.07;
const DELTA_MODERATE = 0.12;
const DELTA_STRONG   = 0.18;

// ── RSI zone classifier ────────────────────────────────────────────────────────
function rsiZone(rsi) {
  if (rsi == null) return null;
  if (rsi < 30) return 'oversold';
  if (rsi < 45) return 'low';
  if (rsi < 55) return 'mid';
  if (rsi < 70) return 'high';
  return 'overbought';
}

// ── Chop score bucket ──────────────────────────────────────────────────────────
function chopBucket(chop) {
  if (chop == null) return null;
  if (chop < 0.25) return 'clean';
  if (chop < 0.38) return 'mild';
  if (chop < 0.50) return 'choppy';
  return 'heavy_chop';
}

// ── HTF alignment label ────────────────────────────────────────────────────────
function htfLabel(feat, dir) {
  if (!feat || dir == null) return null;
  const isLong = dir === 'LONG';
  const aligned = [feat.htf_15m_bias, feat.htf_1h_bias, feat.htf_4h_bias]
    .filter(b => b != null && ((isLong && b > 0) || (!isLong && b < 0)))
    .length;
  return `htf${aligned}of3`;
}

// ── Significance classifier ────────────────────────────────────────────────────
function significance(delta, n) {
  const abs = Math.abs(delta);
  if (abs >= DELTA_STRONG   && n >= MIN_N_STRONG)   return 'STRONG';
  if (abs >= DELTA_MODERATE && n >= MIN_N_MODERATE) return 'MODERATE';
  if (abs >= DELTA_WEAK     && n >= MIN_N_WEAK)     return 'WEAK';
  return null;
}

// ── Compute per-dimension win rates ───────────────────────────────────────────
function analyzeDimension(rows, keyFn) {
  const buckets = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!buckets[k]) buckets[k] = { wins: 0, total: 0 };
    buckets[k].total++;
    if (r.win) buckets[k].wins++;
  }
  return Object.entries(buckets).map(([value, s]) => ({
    value,
    n:      s.total,
    wr:     s.total > 0 ? s.wins / s.total : 0,
  }));
}

// ── Post to agent_messages ─────────────────────────────────────────────────────
function postMessage(db, strategy, msgType, payload, priority = 3) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('feature-intelligence', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

// ── Main analysis loop ─────────────────────────────────────────────────────────
async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  let totalCorrelations = 0;
  let totalMessages     = 0;

  for (const strategy of STRATEGIES) {
    for (const days of PERIODS) {
      try {
        // Load all resolved signals with feature data for this strategy + period
        const rows = db.prepare(`
          SELECT
            o.result,
            CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END AS win,
            s.direction,
            sf.regime,
            sf.session,
            sf.archetype,
            sf.rsi,
            sf.chop_score,
            sf.htf_15m_bias,
            sf.htf_1h_bias,
            sf.htf_4h_bias,
            sf.mtf_agreed,
            sf.atr_percentile
          FROM outcomes o
          JOIN signals s       ON s.id = o.signal_id
          LEFT JOIN signal_features sf ON sf.signal_id = o.signal_id
          WHERE s.strategy_name = ?
            AND o.result IN ('WIN', 'LOSS', 'BE')
            AND o.exit_at >= datetime('now', ? || ' days')
        `).all(strategy, `-${days}`);

        if (rows.length < MIN_N_WEAK) continue;

        // Baseline WR
        const baseline = rows.filter(r => r.win).length / rows.length;

        // Dimensions to analyze
        const dimensions = [
          { key: 'regime',       fn: r => r.regime },
          { key: 'session',      fn: r => r.session },
          { key: 'archetype',    fn: r => r.archetype },
          { key: 'htf_alignment',fn: r => htfLabel(r, r.direction) },
          { key: 'rsi_zone',     fn: r => rsiZone(r.rsi) },
          { key: 'chop_bucket',  fn: r => chopBucket(r.chop_score) },
          { key: 'mtf_agreed',   fn: r => r.mtf_agreed != null ? `mtf${r.mtf_agreed}` : null },
        ];

        for (const { key, fn } of dimensions) {
          const buckets = analyzeDimension(rows, fn);

          for (const { value, n, wr } of buckets) {
            const delta = wr - baseline;
            const sig   = significance(delta, n);

            if (sig === null) continue; // not significant enough to store

            // Upsert to feature_correlations
            db.prepare(`
              INSERT INTO feature_correlations
                (strategy_name, feature_key, feature_value, period_days,
                 sample_size, win_rate, baseline_wr, wr_delta, significance)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(strategy_name, feature_key, feature_value, period_days) DO UPDATE SET
                sample_size  = excluded.sample_size,
                win_rate     = excluded.win_rate,
                baseline_wr  = excluded.baseline_wr,
                wr_delta     = excluded.wr_delta,
                significance = excluded.significance,
                computed_at  = datetime('now')
            `).run(
              strategy, key, value, days,
              n,
              +wr.toFixed(4),
              +baseline.toFixed(4),
              +delta.toFixed(4),
              sig,
            );
            totalCorrelations++;

            // Only post agent messages for 30d period (avoid duplicates vs 90d)
            if (days !== 30) continue;

            const direction = delta > 0 ? 'positive' : 'negative';
            const payload = {
              observation:   `feature_correlation`,
              strategy,
              feature_key:   key,
              feature_value: value,
              win_rate:      +wr.toFixed(4),
              baseline_wr:   +baseline.toFixed(4),
              wr_delta:      +delta.toFixed(4),
              sample_size:   n,
              significance:  sig,
              direction,
              period_days:   days,
              timestamp:     new Date().toISOString(),
            };

            if (sig === 'STRONG') {
              // Strong correlation → post recommendation (agents should act on this)
              const msgType  = delta > 0 ? 'recommendation' : 'recommendation';
              const action   = delta > 0
                ? `Increase signal weight for ${key}=${value} (WR ${(wr*100).toFixed(0)}% vs baseline ${(baseline*100).toFixed(0)}%, N=${n})`
                : `Filter or penalize ${key}=${value} entries (WR ${(wr*100).toFixed(0)}% vs baseline ${(baseline*100).toFixed(0)}%, N=${n})`;
              postMessage(db, strategy, msgType, { ...payload, suggested_action: action }, 2);
              totalMessages++;
            } else if (sig === 'MODERATE') {
              // Moderate → post observation
              postMessage(db, strategy, 'observation', payload, 3);
              totalMessages++;
            }
          }
        }

        console.log(`[${WORKER_NAME}] ${strategy}/${days}d: baseline=${(baseline*100).toFixed(1)}% N=${rows.length} correlations=${totalCorrelations}`);
      } catch (err) {
        console.error(`[${WORKER_NAME}] ${strategy}/${days}d error: ${err.message}`);
        logWorkerError(db, WORKER_NAME, err);
      }
    }
  }

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt:      new Date().toISOString(),
    correlationsFound: totalCorrelations,
    messagesPosted:   totalMessages,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — ${totalCorrelations} correlations, ${totalMessages} messages`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
