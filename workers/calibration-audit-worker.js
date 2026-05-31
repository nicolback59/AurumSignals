'use strict';

/**
 * CALIBRATION AUDIT WORKER
 *
 * Groups resolved signals by confidence bucket (e.g. "55-60", "60-65") and
 * computes actual win-rate vs the midpoint of each bucket. Writes to
 * calibration_audit. A calibration_err > 0.10 means the confidence score is
 * over- or under-confident by 10+ percentage points.
 *
 * PM2 cron: 0 6 * * 1 (6 AM UTC every Monday)
 * autorestart: false — runs once, exits.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'calibration-audit-worker';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const PERIODS     = [14, 30, 90];

// Confidence buckets: lower bound → label
const BUCKETS = [
  { lo: 55, hi: 60, label: '55-60' },
  { lo: 60, hi: 65, label: '60-65' },
  { lo: 65, hi: 70, label: '65-70' },
  { lo: 70, hi: 75, label: '70-75' },
  { lo: 75, hi: 80, label: '75-80' },
  { lo: 80, hi: 85, label: '80-85' },
  { lo: 85, hi: 95, label: '85-95' },
];

function bucketLabel(confidence) {
  for (const b of BUCKETS) {
    if (confidence >= b.lo && confidence < b.hi) return b.label;
  }
  if (confidence >= 95) return '85-95';
  return null;
}

function bucketMidpoint(label) {
  const [lo, hi] = label.split('-').map(Number);
  return (lo + hi) / 2 / 100; // as fraction (0–1)
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  let rowsWritten = 0;

  for (const strategy of STRATEGIES) {
    for (const days of PERIODS) {
      try {
        // Fetch resolved outcomes with confidence
        const rows = db.prepare(`
          SELECT s.confidence, o.win
          FROM outcomes o
          JOIN signals  s ON s.id = o.signal_id
          WHERE s.strategy_name = ?
            AND o.resolved_at >= datetime('now', ? || ' days')
            AND o.win IS NOT NULL
            AND s.confidence IS NOT NULL
        `).all(strategy, `-${days}`);

        if (rows.length < 5) continue;

        // Group by bucket
        const bucketMap = {};
        for (const r of rows) {
          const label = bucketLabel(Number(r.confidence));
          if (!label) continue;
          if (!bucketMap[label]) bucketMap[label] = { wins: 0, total: 0, sumConf: 0 };
          bucketMap[label].total++;
          if (r.win) bucketMap[label].wins++;
          bucketMap[label].sumConf += Number(r.confidence);
        }

        for (const [label, stats] of Object.entries(bucketMap)) {
          if (stats.total < 3) continue;

          const actualWr     = stats.wins / stats.total;
          const avgPredicted = stats.sumConf / stats.total / 100;
          const calErr       = Math.abs(actualWr - avgPredicted);

          db.prepare(`
            INSERT INTO calibration_audit
              (strategy_name, conf_bucket, period_days,
               total_signals, wins, actual_wr, avg_predicted, calibration_err)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(strategy_name, conf_bucket, period_days) DO UPDATE SET
              total_signals  = excluded.total_signals,
              wins           = excluded.wins,
              actual_wr      = excluded.actual_wr,
              avg_predicted  = excluded.avg_predicted,
              calibration_err= excluded.calibration_err,
              computed_at    = datetime('now')
          `).run(
            strategy, label, days,
            stats.total, stats.wins,
            +actualWr.toFixed(4), +avgPredicted.toFixed(4), +calErr.toFixed(4),
          );
          rowsWritten++;
        }

        console.log(`[${WORKER_NAME}] ${strategy} ${days}d: ${Object.keys(bucketMap).length} buckets`);
      } catch (err) {
        console.error(`[${WORKER_NAME}] ${strategy}/${days}d error: ${err.message}`);
        logWorkerError(db, WORKER_NAME, err);
      }
    }
  }

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt: new Date().toISOString(),
    rowsWritten,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — ${rowsWritten} calibration rows written`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
