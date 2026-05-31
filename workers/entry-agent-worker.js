'use strict';

/**
 * ENTRY AGENT WORKER
 *
 * Analyzes which entry types and timing conditions produce the best win rates
 * per strategy. Extends feature-intelligence-worker with cross-dimensional
 * entry analysis and time-in-session breakdown.
 *
 * Dimensions:
 *   • entry_type              (reclaim / sweep / continuation / breakout / fade)
 *   • entry_type × session    (composite key — finds best entry per session)
 *   • entry_type × regime     (composite key — finds best entry per regime)
 *   • time_in_session bucket  (early / mid / late)
 *
 * Significance thresholds:
 *   STRONG   — |wr_delta| ≥ 0.18, N ≥ 15
 *   MODERATE — |wr_delta| ≥ 0.12, N ≥ 8
 *
 * Writes to entry_analysis (idempotent upserts).
 * Posts recommendation/observation messages to agent_messages.
 *
 * PM2 cron: 0 7 * * * (7:00 AM UTC — after feature-intelligence at 6:30 AM)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME     = 'entry-agent';
const STRATEGIES      = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const PERIODS         = [30, 90];
const MIN_N_STRONG    = 15;
const MIN_N_MODERATE  = 8;
const DELTA_STRONG    = 0.18;
const DELTA_MODERATE  = 0.12;

function sessionBucket(t) {
  if (t == null) return null;
  if (t < 0.33) return 'early';
  if (t < 0.67) return 'mid';
  return 'late';
}

function significance(delta, n) {
  const abs = Math.abs(delta);
  if (abs >= DELTA_STRONG   && n >= MIN_N_STRONG)   return 'STRONG';
  if (abs >= DELTA_MODERATE && n >= MIN_N_MODERATE) return 'MODERATE';
  return null;
}

function postMessage(db, strategy, msgType, payload, priority = 3) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('entry-agent', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

function setupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entry_analysis (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name   TEXT    NOT NULL,
      dimension       TEXT    NOT NULL,
      dimension_value TEXT    NOT NULL,
      period_days     INTEGER NOT NULL DEFAULT 30,
      sample_size     INTEGER NOT NULL DEFAULT 0,
      win_rate        REAL,
      baseline_wr     REAL,
      wr_delta        REAL,
      significance    TEXT,
      computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(strategy_name, dimension, dimension_value, period_days)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_enta_strategy ON entry_analysis(strategy_name, computed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_enta_sig ON entry_analysis(significance, wr_delta DESC)`);
}

function seedTrustScore(db) {
  try {
    db.prepare(`INSERT OR IGNORE INTO agent_trust_scores (agent_name, trust_score) VALUES ('entry-agent', 0.70)`).run();
  } catch (_) {}
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  setupSchema(db);
  seedTrustScore(db);

  const upsert = db.prepare(`
    INSERT INTO entry_analysis
      (strategy_name, dimension, dimension_value, period_days, sample_size,
       win_rate, baseline_wr, wr_delta, significance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_name, dimension, dimension_value, period_days) DO UPDATE SET
      sample_size  = excluded.sample_size,
      win_rate     = excluded.win_rate,
      baseline_wr  = excluded.baseline_wr,
      wr_delta     = excluded.wr_delta,
      significance = excluded.significance,
      computed_at  = datetime('now')
  `);

  let totalFindings = 0;
  let totalMessages = 0;

  for (const strategy of STRATEGIES) {
    for (const days of PERIODS) {
      try {
        const rows = db.prepare(`
          SELECT
            CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END AS win,
            sf.entry_type,
            sf.session,
            sf.regime,
            sf.time_in_session
          FROM outcomes o
          JOIN signals s            ON s.id = o.signal_id
          LEFT JOIN signal_features sf ON sf.signal_id = o.signal_id
          WHERE s.strategy_name = ?
            AND o.result IN ('WIN', 'LOSS')
            AND o.exit_at >= datetime('now', ? || ' days')
        `).all(strategy, `-${days}`);

        if (rows.length < MIN_N_MODERATE) continue;

        const baseline = rows.filter(r => r.win).length / rows.length;

        const dimensions = [
          { key: 'entry_type',      fn: r => r.entry_type  || null },
          { key: 'entry_x_session', fn: r => (r.entry_type && r.session) ? `${r.entry_type}:${r.session}` : null },
          { key: 'entry_x_regime',  fn: r => (r.entry_type && r.regime)  ? `${r.entry_type}:${r.regime}`  : null },
          { key: 'time_in_session', fn: r => sessionBucket(r.time_in_session) },
        ];

        for (const { key, fn } of dimensions) {
          const buckets = {};
          for (const row of rows) {
            const k = fn(row);
            if (k == null) continue;
            if (!buckets[k]) buckets[k] = { wins: 0, total: 0 };
            buckets[k].total++;
            if (row.win) buckets[k].wins++;
          }

          for (const [value, { wins, total }] of Object.entries(buckets)) {
            if (total < 3) continue;
            const wr    = wins / total;
            const delta = wr - baseline;
            const sig   = significance(delta, total);

            try {
              upsert.run(
                strategy, key, value, days, total,
                +wr.toFixed(4), +baseline.toFixed(4), +delta.toFixed(4), sig,
              );
              totalFindings++;
            } catch (err) {
              console.warn(`[${WORKER_NAME}] upsert error: ${err.message}`);
            }

            if (sig === null || days !== 30) continue;

            const payload = {
              observation:     'entry_type_correlation',
              strategy,
              dimension:       key,
              dimension_value: value,
              win_rate:        +wr.toFixed(4),
              baseline_wr:     +baseline.toFixed(4),
              wr_delta:        +delta.toFixed(4),
              sample_size:     total,
              significance:    sig,
              period_days:     days,
              timestamp:       new Date().toISOString(),
            };

            if (sig === 'STRONG') {
              const dir    = delta > 0 ? 'Prioritize' : 'Reduce';
              const action = `${dir} ${key}=${value} (WR ${(wr*100).toFixed(0)}% vs baseline ${(baseline*100).toFixed(0)}%, N=${total})`;
              postMessage(db, strategy, 'recommendation', { ...payload, suggested_action: action }, 2);
              totalMessages++;
            } else if (sig === 'MODERATE') {
              postMessage(db, strategy, 'observation', payload, 3);
              totalMessages++;
            }
          }
        }

        console.log(`[${WORKER_NAME}] ${strategy}/${days}d: baseline=${(baseline*100).toFixed(1)}% N=${rows.length}`);
      } catch (err) {
        console.error(`[${WORKER_NAME}] ${strategy}/${days}d error: ${err.message}`);
        logWorkerError(db, WORKER_NAME, err);
      }
    }
  }

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt:    new Date().toISOString(),
    findingsStored: totalFindings,
    messagesPosted: totalMessages,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — ${totalFindings} findings, ${totalMessages} messages`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
