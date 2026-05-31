'use strict';

/**
 * TAKE PROFIT AGENT WORKER
 *
 * Analyzes take-profit level efficiency across completed trades.
 * Computes TP hit rates using maximum favorable excursion (mfe_pts) vs
 * the distance to each TP level.
 *
 * Key metrics per dimension:
 *   tp1_hit_rate  — % of resolved trades where mfe_pts ≥ tp1 distance
 *   tp2_hit_rate  — % of resolved trades where mfe_pts ≥ tp2 distance
 *   tp3_hit_rate  — % of resolved trades where mfe_pts ≥ tp3 distance
 *   avg_mfe_pts   — average maximum favorable excursion in points
 *   avg_tp1_pts   — average TP1 distance in points
 *   avg_rr        — average risk:reward ratio
 *
 * Dimensions: overall | by session | by regime | by entry_type
 *
 * Writes to tp_analysis (idempotent upserts).
 * Posts agent_messages when TP levels are systematically under/over-extended.
 *
 * PM2 cron: 0 *\/6 * * * (every 6h, offset from stop-agent)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'tp-agent';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const LOOKBACK    = 90;
const MIN_SAMPLE  = 8;

function setupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tp_analysis (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name   TEXT    NOT NULL,
      dimension       TEXT    NOT NULL,
      dimension_value TEXT    NOT NULL,
      period_days     INTEGER NOT NULL DEFAULT 90,
      sample_size     INTEGER NOT NULL DEFAULT 0,
      tp1_hit_rate    REAL,
      tp2_hit_rate    REAL,
      tp3_hit_rate    REAL,
      avg_mfe_pts     REAL,
      avg_tp1_pts     REAL,
      avg_tp2_pts     REAL,
      avg_rr          REAL,
      win_rate        REAL,
      computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(strategy_name, dimension, dimension_value, period_days)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tpa_strategy ON tp_analysis(strategy_name, computed_at DESC)`);
}

function seedTrustScore(db) {
  try {
    db.prepare(`INSERT OR IGNORE INTO agent_trust_scores (agent_name, trust_score) VALUES ('tp-agent', 0.70)`).run();
  } catch (_) {}
}

function postMessage(db, strategy, msgType, payload, priority = 3) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('tp-agent', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

function analyzeGroup(rows) {
  if (rows.length < MIN_SAMPLE) return null;

  const wins = rows.filter(r => r.win);
  const wr   = wins.length / rows.length;

  // TP1 analysis — only rows where tp1_pts > 0 and mfe_pts is available
  const tp1Rows = rows.filter(r => r.tp1_pts != null && r.tp1_pts > 0 && r.mfe_pts != null);
  const tp1HitRate = tp1Rows.length
    ? +(tp1Rows.filter(r => r.mfe_pts >= r.tp1_pts).length / tp1Rows.length * 100).toFixed(1)
    : null;
  const avgTp1Pts = tp1Rows.length
    ? +(tp1Rows.reduce((a, r) => a + r.tp1_pts, 0) / tp1Rows.length).toFixed(2)
    : null;

  // TP2 analysis
  const tp2Rows = rows.filter(r => r.tp2_pts != null && r.tp2_pts > 0 && r.mfe_pts != null);
  const tp2HitRate = tp2Rows.length
    ? +(tp2Rows.filter(r => r.mfe_pts >= r.tp2_pts).length / tp2Rows.length * 100).toFixed(1)
    : null;
  const avgTp2Pts = tp2Rows.length
    ? +(tp2Rows.reduce((a, r) => a + r.tp2_pts, 0) / tp2Rows.length).toFixed(2)
    : null;

  // TP3 analysis
  const tp3Rows = rows.filter(r => r.tp3_pts != null && r.tp3_pts > 0 && r.mfe_pts != null);
  const tp3HitRate = tp3Rows.length
    ? +(tp3Rows.filter(r => r.mfe_pts >= r.tp3_pts).length / tp3Rows.length * 100).toFixed(1)
    : null;

  // MFE average
  const mfeRows = rows.filter(r => r.mfe_pts != null && r.mfe_pts >= 0);
  const avgMfePts = mfeRows.length
    ? +(mfeRows.reduce((a, r) => a + r.mfe_pts, 0) / mfeRows.length).toFixed(2)
    : null;

  // Average RR
  const rrRows = rows.filter(r => r.rr != null && r.rr > 0);
  const avgRr = rrRows.length
    ? +(rrRows.reduce((a, r) => a + r.rr, 0) / rrRows.length).toFixed(2)
    : null;

  return {
    sample_size:  rows.length,
    win_rate:     +wr.toFixed(4),
    tp1_hit_rate: tp1HitRate,
    tp2_hit_rate: tp2HitRate,
    tp3_hit_rate: tp3HitRate,
    avg_mfe_pts:  avgMfePts,
    avg_tp1_pts:  avgTp1Pts,
    avg_tp2_pts:  avgTp2Pts,
    avg_rr:       avgRr,
  };
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  setupSchema(db);
  seedTrustScore(db);

  const upsert = db.prepare(`
    INSERT INTO tp_analysis
      (strategy_name, dimension, dimension_value, period_days, sample_size,
       tp1_hit_rate, tp2_hit_rate, tp3_hit_rate, avg_mfe_pts,
       avg_tp1_pts, avg_tp2_pts, avg_rr, win_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_name, dimension, dimension_value, period_days) DO UPDATE SET
      sample_size  = excluded.sample_size,
      tp1_hit_rate = excluded.tp1_hit_rate,
      tp2_hit_rate = excluded.tp2_hit_rate,
      tp3_hit_rate = excluded.tp3_hit_rate,
      avg_mfe_pts  = excluded.avg_mfe_pts,
      avg_tp1_pts  = excluded.avg_tp1_pts,
      avg_tp2_pts  = excluded.avg_tp2_pts,
      avg_rr       = excluded.avg_rr,
      win_rate     = excluded.win_rate,
      computed_at  = datetime('now')
  `);

  let totalRows = 0;

  for (const strategy of STRATEGIES) {
    try {
      const rows = db.prepare(`
        SELECT
          CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END   AS win,
          o.mfe_pts,
          s.rr,
          CASE WHEN s.entry IS NOT NULL AND s.tp1 IS NOT NULL
               THEN ABS(s.tp1 - s.entry) ELSE NULL END   AS tp1_pts,
          CASE WHEN s.entry IS NOT NULL AND s.tp2 IS NOT NULL
               THEN ABS(s.tp2 - s.entry) ELSE NULL END   AS tp2_pts,
          CASE WHEN s.entry IS NOT NULL AND s.tp3 IS NOT NULL
               THEN ABS(s.tp3 - s.entry) ELSE NULL END   AS tp3_pts,
          sf.session,
          sf.regime,
          sf.entry_type
        FROM outcomes o
        JOIN signals s            ON s.id = o.signal_id
        LEFT JOIN signal_features sf ON sf.signal_id = o.signal_id
        WHERE s.strategy_name = ?
          AND o.result IN ('WIN', 'LOSS')
          AND o.exit_at >= datetime('now', ? || ' days')
      `).all(strategy, `-${LOOKBACK}`);

      if (!rows.length) continue;

      const groups = [
        { dim: 'overall',    fn: _ => 'all' },
        { dim: 'session',    fn: r => r.session    || null },
        { dim: 'regime',     fn: r => r.regime     || null },
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
            stats.sample_size, stats.tp1_hit_rate, stats.tp2_hit_rate, stats.tp3_hit_rate,
            stats.avg_mfe_pts, stats.avg_tp1_pts, stats.avg_tp2_pts,
            stats.avg_rr, stats.win_rate,
          );
          totalRows++;

          // Alert when overall TP1 hit rate is very low (TP too far)
          if (dim === 'overall' && stats.tp1_hit_rate != null &&
              stats.tp1_hit_rate < 30 && stats.sample_size >= 15) {
            postMessage(db, strategy, 'observation', {
              observation:  'tp1_miss_rate_high',
              strategy,
              tp1_hit_rate: stats.tp1_hit_rate,
              avg_tp1_pts:  stats.avg_tp1_pts,
              avg_mfe_pts:  stats.avg_mfe_pts,
              sample_size:  stats.sample_size,
              suggested_action: `TP1 hit rate only ${stats.tp1_hit_rate}% — consider tightening TP1 from ~${stats.avg_tp1_pts} pts (avg MFE: ${stats.avg_mfe_pts} pts)`,
              timestamp:    new Date().toISOString(),
            }, 3);
          }

          // Alert when MFE consistently exceeds TP1 by >50% (leaving money on table)
          if (dim === 'overall' && stats.avg_mfe_pts != null &&
              stats.avg_tp1_pts != null && stats.avg_tp1_pts > 0 &&
              stats.avg_mfe_pts > stats.avg_tp1_pts * 1.5 && stats.sample_size >= 15) {
            postMessage(db, strategy, 'observation', {
              observation:  'mfe_exceeds_tp1',
              strategy,
              avg_mfe_pts:  stats.avg_mfe_pts,
              avg_tp1_pts:  stats.avg_tp1_pts,
              ratio:        +(stats.avg_mfe_pts / stats.avg_tp1_pts).toFixed(2),
              sample_size:  stats.sample_size,
              suggested_action: `Avg MFE (${stats.avg_mfe_pts} pts) is ${((stats.avg_mfe_pts/stats.avg_tp1_pts - 1)*100).toFixed(0)}% beyond TP1 — consider staging TPs or extending TP1`,
              timestamp:    new Date().toISOString(),
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
