'use strict';

/**
 * FREQUENCY AGENT WORKER
 *
 * Analyzes signal_rejections to identify valid setups being consistently blocked.
 * The scanner stores near-miss trades (score within 4 pts of threshold) in
 * signal_rejections — this agent finds patterns in those near-misses.
 *
 * Analysis:
 *   • Rejection reason category distribution per strategy (30d / 90d)
 *   • Score gap stats — how close to passing were blocked signals
 *   • Peak rejection hours — when is filtering most aggressive
 *   • Strategies with high block-to-pass ratios
 *
 * Reason categories (parsed from free-text reason field):
 *   duplicate_guard         — same-bar de-duplication
 *   adaptive_cooldown       — adaptive cooldown window
 *   strategy_paused         — strategy paused by learning engine
 *   direction_blocked       — LONG or SHORT blocked by low WR
 *   session_blocked         — session blocked by adaptive learning
 *   confidence_threshold    — confidence below learned minimum
 *   fuzzy_dedup             — fuzzy de-duplication
 *   tier_gate               — institutional tier gate
 *   intelligence_gate       — signal gate worker GATED status
 *   other                   — unclassified
 *
 * Writes to frequency_analysis (idempotent upserts).
 * Posts observation to agent_messages when one reason > 60% of near-misses.
 *
 * PM2 cron: 0 *\/4 * * * (every 4h)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'frequency-agent';
const PERIODS     = [30, 90];
const MIN_SAMPLE  = 5;

function setupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frequency_analysis (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name    TEXT    NOT NULL,
      instrument       TEXT    NOT NULL DEFAULT 'ALL',
      dimension        TEXT    NOT NULL,
      dimension_value  TEXT    NOT NULL,
      period_days      INTEGER NOT NULL DEFAULT 30,
      rejection_count  INTEGER NOT NULL DEFAULT 0,
      avg_score_gap    REAL,
      pct_of_total     REAL,
      computed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(strategy_name, instrument, dimension, dimension_value, period_days)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_frqa_strategy ON frequency_analysis(strategy_name, computed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_frqa_pct ON frequency_analysis(pct_of_total DESC, computed_at DESC)`);
}

function seedTrustScore(db) {
  try {
    db.prepare(`INSERT OR IGNORE INTO agent_trust_scores (agent_name, trust_score) VALUES ('frequency-agent', 0.65)`).run();
  } catch (_) {}
}

function postMessage(db, strategy, msgType, payload, priority = 3) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('frequency-agent', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

function classifyReason(reason) {
  if (!reason) return 'other';
  const r = reason.toLowerCase();
  if (r.startsWith('duplicate_guard'))               return 'duplicate_guard';
  if (r.startsWith('adaptive_cooldown'))             return 'adaptive_cooldown';
  if (r.startsWith('strategy paused'))               return 'strategy_paused';
  if (r.includes('long direction blocked') ||
      r.includes('short direction blocked'))         return 'direction_blocked';
  if (r.startsWith("session '") && r.includes('blocked')) return 'session_blocked';
  if (r.startsWith('confidence'))                    return 'confidence_threshold';
  if (r.includes('intelligence-gate') ||
      r.includes('gated by edge'))                   return 'intelligence_gate';
  if (r.includes('tier') || r.includes('rank'))      return 'tier_gate';
  if (r.includes('dedup') || r.includes('duplicate')) return 'fuzzy_dedup';
  return 'other';
}

function hourOfDay(isoStr) {
  try {
    return new Date(isoStr).getUTCHours();
  } catch (_) {
    return null;
  }
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  setupSchema(db);
  seedTrustScore(db);

  const upsert = db.prepare(`
    INSERT INTO frequency_analysis
      (strategy_name, instrument, dimension, dimension_value, period_days,
       rejection_count, avg_score_gap, pct_of_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_name, instrument, dimension, dimension_value, period_days) DO UPDATE SET
      rejection_count = excluded.rejection_count,
      avg_score_gap   = excluded.avg_score_gap,
      pct_of_total    = excluded.pct_of_total,
      computed_at     = datetime('now')
  `);

  let totalRows = 0;

  for (const days of PERIODS) {
    try {
      const allRows = db.prepare(`
        SELECT
          COALESCE(strategy, 'UNKNOWN') AS strategy,
          COALESCE(instrument, 'ALL')   AS instrument,
          reason,
          score,
          min_score,
          rejected_at
        FROM signal_rejections
        WHERE rejected_at >= datetime('now', ? || ' days')
      `).all(`-${days}`);

      if (!allRows.length) continue;

      // Group by strategy
      const byStrategy = {};
      for (const row of allRows) {
        const key = row.strategy;
        if (!byStrategy[key]) byStrategy[key] = [];
        byStrategy[key].push(row);
      }

      for (const [strategy, rows] of Object.entries(byStrategy)) {
        if (rows.length < MIN_SAMPLE) continue;

        const total = rows.length;

        // ── Dimension 1: reason category distribution ────────────────────────
        const reasonBuckets = {};
        for (const row of rows) {
          const cat = classifyReason(row.reason);
          if (!reasonBuckets[cat]) reasonBuckets[cat] = { count: 0, gaps: [] };
          reasonBuckets[cat].count++;
          if (row.score != null && row.min_score != null) {
            reasonBuckets[cat].gaps.push(row.min_score - row.score);
          }
        }

        for (const [cat, { count, gaps }] of Object.entries(reasonBuckets)) {
          const avgGap = gaps.length
            ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)
            : null;
          const pct = +(count / total * 100).toFixed(1);

          upsert.run(strategy, 'ALL', 'reason_category', cat, days, count, avgGap, pct);
          totalRows++;

          // Post if single reason is blocking > 60% of near-misses (30d only)
          if (days === 30 && pct > 60 && count >= 10) {
            const catLabel = cat.replace(/_/g, ' ');
            postMessage(db, strategy, 'observation', {
              observation:      'dominant_rejection_reason',
              strategy,
              reason_category:  cat,
              rejection_count:  count,
              pct_of_total:     pct,
              avg_score_gap:    avgGap,
              period_days:      days,
              suggested_action: `${pct}% of near-miss trades blocked by '${catLabel}'. Review threshold — may be over-filtering.`,
              timestamp:        new Date().toISOString(),
            }, 3);
          }
        }

        // ── Dimension 2: peak rejection hour (UTC) ───────────────────────────
        const hourBuckets = {};
        for (const row of rows) {
          const h = hourOfDay(row.rejected_at);
          if (h == null) continue;
          const label = `h${String(h).padStart(2, '0')}`;
          if (!hourBuckets[label]) hourBuckets[label] = { count: 0, gaps: [] };
          hourBuckets[label].count++;
          if (row.score != null && row.min_score != null) {
            hourBuckets[label].gaps.push(row.min_score - row.score);
          }
        }

        for (const [label, { count, gaps }] of Object.entries(hourBuckets)) {
          const avgGap = gaps.length
            ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)
            : null;
          const pct = +(count / total * 100).toFixed(1);
          upsert.run(strategy, 'ALL', 'rejection_hour_utc', label, days, count, avgGap, pct);
          totalRows++;
        }

        // ── Dimension 3: direction distribution ─────────────────────────────
        const dirBuckets = {};
        for (const row of rows) {
          const inst = row.instrument || 'ALL';
          if (!dirBuckets[inst]) dirBuckets[inst] = { count: 0, gaps: [] };
          dirBuckets[inst].count++;
          if (row.score != null && row.min_score != null) {
            dirBuckets[inst].gaps.push(row.min_score - row.score);
          }
        }

        for (const [inst, { count, gaps }] of Object.entries(dirBuckets)) {
          const avgGap = gaps.length
            ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)
            : null;
          const pct = +(count / total * 100).toFixed(1);
          upsert.run(strategy, inst, 'instrument_share', inst, days, count, avgGap, pct);
          totalRows++;
        }
      }

      console.log(`[${WORKER_NAME}] ${days}d: ${allRows.length} rejections across ${Object.keys(byStrategy).length} strategies`);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${days}d error: ${err.message}`);
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
