'use strict';

/**
 * STOP LOSS AGENT WORKER
 *
 * Analyzes stop-loss placement quality across completed trades.
 * Uses ABS(entry - sl) as stop distance and compares to maximum adverse
 * excursion (mae_pts) to determine if stops are properly sized.
 *
 * Key metrics per dimension:
 *   avg_sl_pts         — average stop distance in price points
 *   avg_mae_pts        — average maximum adverse excursion in points
 *   mae_sl_ratio       — avg MAE / avg SL (>1.0 means MAE typically exceeds stop)
 *   stop_too_tight_pct — % of WINS where MAE > stop distance
 *                        (trade came back after briefly touching stop zone)
 *   avg_sl_atr_ratio   — avg stop distance as multiple of ATR
 *   optimal_sl_atr     — empirical 80th-percentile MAE/ATR (floor for stop sizing)
 *
 * Dimensions: overall | by regime | by session | by entry_type
 *
 * Writes to stop_analysis (idempotent upserts).
 * Posts observation to agent_messages when stop_too_tight_pct > 35% on N ≥ 15.
 *
 * PM2 cron: 0 *\/6 * * * (every 6h)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'stop-agent';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const LOOKBACK    = 90;
const MIN_SAMPLE  = 8;

function setupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_analysis (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name        TEXT    NOT NULL,
      dimension            TEXT    NOT NULL,
      dimension_value      TEXT    NOT NULL,
      period_days          INTEGER NOT NULL DEFAULT 90,
      sample_size          INTEGER NOT NULL DEFAULT 0,
      avg_sl_pts           REAL,
      avg_mae_pts          REAL,
      mae_sl_ratio         REAL,
      stop_too_tight_pct   REAL,
      avg_sl_atr_ratio     REAL,
      optimal_sl_atr       REAL,
      win_rate             REAL,
      computed_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(strategy_name, dimension, dimension_value, period_days)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stpa_strategy ON stop_analysis(strategy_name, computed_at DESC)`);
}

function seedTrustScore(db) {
  try {
    db.prepare(`INSERT OR IGNORE INTO agent_trust_scores (agent_name, trust_score) VALUES ('stop-agent', 0.70)`).run();
  } catch (_) {}
}

function postMessage(db, strategy, msgType, payload, priority = 3) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('stop-agent', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

function percentile80(sorted) {
  if (sorted.length < 4) return null;
  const pos = 0.8 * (sorted.length - 1);
  const lo  = Math.floor(pos);
  const hi  = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function analyzeGroup(rows) {
  if (rows.length < MIN_SAMPLE) return null;

  const wins = rows.filter(r => r.win);
  const wr   = wins.length / rows.length;

  const slPtsAll = rows.map(r => r.sl_pts).filter(v => v != null && v > 0);
  if (!slPtsAll.length) return null;
  const avgSlPts = slPtsAll.reduce((a, b) => a + b, 0) / slPtsAll.length;

  const maePtsAll = rows.map(r => r.mae_pts).filter(v => v != null && v >= 0);
  const avgMaePts = maePtsAll.length
    ? maePtsAll.reduce((a, b) => a + b, 0) / maePtsAll.length
    : null;

  const maeSLRatio = avgMaePts != null && avgSlPts > 0
    ? +(avgMaePts / avgSlPts).toFixed(3)
    : null;

  const winsWithBoth = wins.filter(r => r.mae_pts != null && r.sl_pts != null && r.sl_pts > 0);
  const stopTooTightPct = winsWithBoth.length
    ? +(winsWithBoth.filter(r => r.mae_pts > r.sl_pts).length / winsWithBoth.length * 100).toFixed(1)
    : null;

  const atrRows = rows.filter(r => r.atr != null && r.atr > 0 && r.sl_pts != null && r.sl_pts > 0);
  const avgSlAtrRatio = atrRows.length
    ? +(atrRows.reduce((a, r) => a + r.sl_pts / r.atr, 0) / atrRows.length).toFixed(3)
    : null;

  const maeAtrRatios = rows
    .filter(r => r.mae_pts != null && r.atr != null && r.atr > 0)
    .map(r => r.mae_pts / r.atr)
    .sort((a, b) => a - b);
  const optimalSlAtr = maeAtrRatios.length >= 4
    ? +(percentile80(maeAtrRatios)).toFixed(2)
    : null;

  return {
    sample_size:         rows.length,
    win_rate:            +wr.toFixed(4),
    avg_sl_pts:          +avgSlPts.toFixed(2),
    avg_mae_pts:         avgMaePts != null ? +avgMaePts.toFixed(2) : null,
    mae_sl_ratio:        maeSLRatio,
    stop_too_tight_pct:  stopTooTightPct,
    avg_sl_atr_ratio:    avgSlAtrRatio,
    optimal_sl_atr:      optimalSlAtr,
  };
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  setupSchema(db);
  seedTrustScore(db);

  const upsert = db.prepare(`
    INSERT INTO stop_analysis
      (strategy_name, dimension, dimension_value, period_days, sample_size,
       avg_sl_pts, avg_mae_pts, mae_sl_ratio, stop_too_tight_pct,
       avg_sl_atr_ratio, optimal_sl_atr, win_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_name, dimension, dimension_value, period_days) DO UPDATE SET
      sample_size        = excluded.sample_size,
      avg_sl_pts         = excluded.avg_sl_pts,
      avg_mae_pts        = excluded.avg_mae_pts,
      mae_sl_ratio       = excluded.mae_sl_ratio,
      stop_too_tight_pct = excluded.stop_too_tight_pct,
      avg_sl_atr_ratio   = excluded.avg_sl_atr_ratio,
      optimal_sl_atr     = excluded.optimal_sl_atr,
      win_rate           = excluded.win_rate,
      computed_at        = datetime('now')
  `);

  let totalRows = 0;

  for (const strategy of STRATEGIES) {
    try {
      const rows = db.prepare(`
        SELECT
          CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END AS win,
          ABS(s.entry - s.sl)                           AS sl_pts,
          o.mae_pts,
          sf.atr,
          sf.regime,
          sf.session,
          sf.entry_type
        FROM outcomes o
        JOIN signals s            ON s.id = o.signal_id
        LEFT JOIN signal_features sf ON sf.signal_id = o.signal_id
        WHERE s.strategy_name = ?
          AND o.result IN ('WIN', 'LOSS')
          AND s.entry IS NOT NULL
          AND s.sl    IS NOT NULL
          AND o.exit_at >= datetime('now', ? || ' days')
      `).all(strategy, `-${LOOKBACK}`);

      if (!rows.length) continue;

      const groups = [
        { dim: 'overall',    fn: _ => 'all' },
        { dim: 'regime',     fn: r => r.regime     || null },
        { dim: 'session',    fn: r => r.session    || null },
        { dim: 'entry_type', fn: r => r.entry_type || null },
      ];

      for (const { dim, fn } of groups) {
        const buckets = {};
        for (const row of rows) {
          const k = fn(row);
          if (k == null) continue;
          if (!buckets[k]) buckets[k] = [];
          buckets[k].push(row);
        }

        for (const [value, grpRows] of Object.entries(buckets)) {
          const stats = analyzeGroup(grpRows);
          if (!stats) continue;

          upsert.run(
            strategy, dim, value, LOOKBACK,
            stats.sample_size, stats.avg_sl_pts, stats.avg_mae_pts,
            stats.mae_sl_ratio, stats.stop_too_tight_pct,
            stats.avg_sl_atr_ratio, stats.optimal_sl_atr, stats.win_rate,
          );
          totalRows++;

          if (dim === 'overall' &&
              stats.stop_too_tight_pct != null &&
              stats.stop_too_tight_pct > 35 &&
              stats.sample_size >= 15) {
            const optStr = stats.optimal_sl_atr != null
              ? ` Empirical floor: ${stats.optimal_sl_atr}× ATR.`
              : '';
            postMessage(db, strategy, 'observation', {
              observation:        'stop_too_tight',
              strategy,
              stop_too_tight_pct: stats.stop_too_tight_pct,
              avg_sl_atr_ratio:   stats.avg_sl_atr_ratio,
              optimal_sl_atr:     stats.optimal_sl_atr,
              sample_size:        stats.sample_size,
              suggested_action:   `Stop too tight on ${stats.stop_too_tight_pct}% of wins.${optStr}`,
              timestamp:          new Date().toISOString(),
            }, 3);
          }
        }
      }

      console.log(`[${WORKER_NAME}] ${strategy}: ${rows.length} trades analyzed`);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt: new Date().toISOString(),
    rowsStored:  totalRows,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — ${totalRows} rows stored`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
