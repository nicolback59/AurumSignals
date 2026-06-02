'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'strategy-evolution';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];

const RECENT_MIN_TRADES = 15;
const PRIOR_MIN_TRADES  = 5;
const DELTA_IMPROVING   = 0.10;
const DELTA_DEGRADING   = -0.10;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function dateOffsetDays(base, offsetDays) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return isoDate(d);
}

function classifyTrend(wrDelta) {
  if (wrDelta >= DELTA_IMPROVING) return 'IMPROVING';
  if (wrDelta <= DELTA_DEGRADING) return 'DEGRADING';
  return 'STABLE';
}

function postAgentMessage(db, strategy, msgType, priority, payload) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES (?, 'consensus', ?, ?, ?, ?)
    `).run(WORKER_NAME, msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

function ensureTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS strategy_evolution_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date         TEXT NOT NULL,
      strategy_name    TEXT NOT NULL,
      dimension        TEXT NOT NULL,
      dimension_value  TEXT NOT NULL,
      recent_wr        REAL,
      prior_wr         REAL,
      wr_delta         REAL,
      recent_trades    INTEGER,
      prior_trades     INTEGER,
      trend            TEXT,
      message_posted   INTEGER DEFAULT 0,
      computed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, dimension, dimension_value)
    )
  `).run();
}

function upsertLog(db, runDate, strategyName, dimension, dimensionValue, data) {
  db.prepare(`
    INSERT INTO strategy_evolution_log
      (run_date, strategy_name, dimension, dimension_value,
       recent_wr, prior_wr, wr_delta, recent_trades, prior_trades, trend, message_posted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_date, strategy_name, dimension, dimension_value) DO UPDATE SET
      recent_wr      = excluded.recent_wr,
      prior_wr       = excluded.prior_wr,
      wr_delta       = excluded.wr_delta,
      recent_trades  = excluded.recent_trades,
      prior_trades   = excluded.prior_trades,
      trend          = excluded.trend,
      message_posted = excluded.message_posted,
      computed_at    = datetime('now')
  `).run(
    runDate, strategyName, dimension, dimensionValue,
    data.recentWr, data.priorWr, data.wrDelta,
    data.recentTrades, data.priorTrades, data.trend, data.messagePosted ? 1 : 0,
  );
}

function analyzeWindowedWr(db, strategy, dimension, dimensionValue, colName, recentStart, recentEnd, priorStart, priorEnd) {
  const recent = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) losses
    FROM trade_dna
    WHERE strategy_name = ?
      AND ${colName} = ?
      AND outcome IN ('WIN', 'LOSS')
      AND trade_date >= ? AND trade_date <= ?
  `).get(strategy, dimensionValue, recentStart, recentEnd);

  const prior = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) losses
    FROM trade_dna
    WHERE strategy_name = ?
      AND ${colName} = ?
      AND outcome IN ('WIN', 'LOSS')
      AND trade_date >= ? AND trade_date <= ?
  `).get(strategy, dimensionValue, priorStart, priorEnd);

  const recentTotal = (recent?.wins ?? 0) + (recent?.losses ?? 0);
  const priorTotal  = (prior?.wins  ?? 0) + (prior?.losses  ?? 0);

  return {
    recentWins:   recent?.wins   ?? 0,
    recentLosses: recent?.losses ?? 0,
    recentTotal,
    priorWins:    prior?.wins    ?? 0,
    priorLosses:  prior?.losses  ?? 0,
    priorTotal,
  };
}

function processDimension(db, strategy, dimension, colName, distinctValues, runDate, recentStart, recentEnd, priorStart, priorEnd) {
  const findings = [];

  for (const dimValue of distinctValues) {
    const counts = analyzeWindowedWr(
      db, strategy, dimension, dimValue, colName,
      recentStart, recentEnd, priorStart, priorEnd,
    );

    if (counts.recentTotal < RECENT_MIN_TRADES || counts.priorTotal < PRIOR_MIN_TRADES) continue;

    const recentWr = counts.recentWins / counts.recentTotal;
    const priorWr  = counts.priorWins  / counts.priorTotal;
    const wrDelta  = recentWr - priorWr;
    const trend    = classifyTrend(wrDelta);

    let messagePosted = false;

    if (trend === 'DEGRADING') {
      const payload = {
        [dimension]:    dimValue,
        recent_wr:      +recentWr.toFixed(4),
        prior_wr:       +priorWr.toFixed(4),
        wr_delta:       +wrDelta.toFixed(4),
        recent_trades:  counts.recentTotal,
        prior_trades:   counts.priorTotal,
        recommendation: 'REDUCE_EXPOSURE',
      };
      postAgentMessage(db, strategy, 'recommendation', 2, payload);
      messagePosted = true;
    } else if (trend === 'IMPROVING') {
      const payload = {
        [dimension]:    dimValue,
        recent_wr:      +recentWr.toFixed(4),
        prior_wr:       +priorWr.toFixed(4),
        wr_delta:       +wrDelta.toFixed(4),
        recent_trades:  counts.recentTotal,
        prior_trades:   counts.priorTotal,
        recommendation: 'INCREASE_EXPOSURE',
      };
      postAgentMessage(db, strategy, 'observation', 4, payload);
      messagePosted = true;
    }

    upsertLog(db, runDate, strategy, dimension, dimValue, {
      recentWr:     +recentWr.toFixed(4),
      priorWr:      +priorWr.toFixed(4),
      wrDelta:      +wrDelta.toFixed(4),
      recentTrades: counts.recentTotal,
      priorTrades:  counts.priorTotal,
      trend,
      messagePosted,
    });

    findings.push({ dimValue, trend, recentWr, priorWr, wrDelta, recentTotal: counts.recentTotal });
  }

  return findings;
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  ensureTable(db);

  const now        = new Date();
  const runDate    = isoDate(now);

  // Recent window:  last 30 calendar days  [now-30d, now]
  // Prior window:   31-90 calendar days ago [now-90d, now-31d]
  const recentEnd   = runDate;
  const recentStart = dateOffsetDays(now, -30);
  const priorEnd    = dateOffsetDays(now, -31);
  const priorStart  = dateOffsetDays(now, -90);

  const allDegrading  = [];
  const allImproving  = [];

  for (const strategy of STRATEGIES) {
    try {
      // ── Dimension A: Archetype ──────────────────────────────────────────────
      console.log(`[${WORKER_NAME}] ${strategy} — dimension: archetype`);
      const archetypeRows = db.prepare(`
        SELECT DISTINCT archetype
        FROM trade_dna
        WHERE strategy_name = ? AND archetype IS NOT NULL AND outcome IN ('WIN', 'LOSS')
      `).all(strategy);

      const archetypeValues = archetypeRows.map(r => r.archetype);

      const archetypeFindings = processDimension(
        db, strategy, 'archetype', 'archetype', archetypeValues,
        runDate, recentStart, recentEnd, priorStart, priorEnd,
      );

      for (const f of archetypeFindings) {
        if (f.trend === 'DEGRADING')  allDegrading.push(`${strategy}/archetype=${f.dimValue} WR ${(f.priorWr*100).toFixed(0)}%→${(f.recentWr*100).toFixed(0)}% (n=${f.recentTotal})`);
        if (f.trend === 'IMPROVING')  allImproving.push(`${strategy}/archetype=${f.dimValue} WR ${(f.priorWr*100).toFixed(0)}%→${(f.recentWr*100).toFixed(0)}% (n=${f.recentTotal})`);
      }

      // ── Dimension B: Regime ─────────────────────────────────────────────────
      console.log(`[${WORKER_NAME}] ${strategy} — dimension: regime`);
      const regimeRows = db.prepare(`
        SELECT DISTINCT regime
        FROM trade_dna
        WHERE strategy_name = ? AND regime IS NOT NULL AND outcome IN ('WIN', 'LOSS')
      `).all(strategy);

      const regimeValues = regimeRows.map(r => r.regime);

      const regimeFindings = processDimension(
        db, strategy, 'regime', 'regime', regimeValues,
        runDate, recentStart, recentEnd, priorStart, priorEnd,
      );

      for (const f of regimeFindings) {
        if (f.trend === 'DEGRADING')  allDegrading.push(`${strategy}/regime=${f.dimValue} WR ${(f.priorWr*100).toFixed(0)}%→${(f.recentWr*100).toFixed(0)}% (n=${f.recentTotal})`);
        if (f.trend === 'IMPROVING')  allImproving.push(`${strategy}/regime=${f.dimValue} WR ${(f.priorWr*100).toFixed(0)}%→${(f.recentWr*100).toFixed(0)}% (n=${f.recentTotal})`);
      }

      console.log(`[${WORKER_NAME}] ${strategy} — archetypes: ${archetypeFindings.length} evaluated, regimes: ${regimeFindings.length} evaluated`);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  // ── Summary notification ──────────────────────────────────────────────────
  const lines = [];
  lines.push(`Run: ${runDate}  (recent=last 30d, prior=31-90d)`);

  if (allDegrading.length) {
    lines.push('');
    lines.push(`DEGRADING (${allDegrading.length}):`);
    allDegrading.forEach(s => lines.push(`  - ${s}`));
  }

  if (allImproving.length) {
    lines.push('');
    lines.push(`IMPROVING (${allImproving.length}):`);
    allImproving.forEach(s => lines.push(`  + ${s}`));
  }

  if (!allDegrading.length && !allImproving.length) {
    lines.push('All archetypes and regimes STABLE — no significant WR shifts detected.');
  }

  const notifPriority = allDegrading.length > 0 ? 'high' : 'default';
  const notifBody     = lines.join('\n');

  await sendNotification(
    'Strategy Evolution — Weekly WR Trend Report',
    notifBody,
    { priority: notifPriority, tags: 'dna,chart_increasing' },
  );

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    completedAt:    new Date().toISOString(),
    runDate,
    degradingCount: allDegrading.length,
    improvingCount: allImproving.length,
  });

  console.log(`[${WORKER_NAME}] Done — ${allDegrading.length} degrading, ${allImproving.length} improving`);
  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
