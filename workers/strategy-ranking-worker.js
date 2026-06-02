'use strict';

/**
 * STRATEGY RANKING WORKER  (Prompt #11 — Phase 1, 8, 11)
 *
 * Runs daily at 06:15 UTC. Computes three scores per strategy:
 *
 *   health_score      (0–100)  — how healthy the edge is RIGHT NOW
 *   confidence_score  (0–100)  — how reliable/consistent the strategy is
 *   allocation_score  (0–100)  — combined capital-weight recommendation
 *
 * Also writes `portfolioWeight` (0.50–1.50) and `behaviorMode` into
 * ADAPTIVE_OVERRIDES so scanner-core reads them without extra DB hits.
 *
 * Health Score (base 50, recent-performance bias):
 *   ±25  30d WR  ≥60% → +25; ≥55% → +15; ≥50% → +5; <40% → -15; <35% → -25
 *   ±20  30d PF  ≥1.8 → +20; ≥1.4 → +10; <1.0 → -15
 *   ±15  30d expectancy > 0.5R → +15; > 0.25R → +8; < 0 → -10
 *   ±15  max loss streak ≤3 → +15; ≤5 → +8; ≥8 → -10; ≥12 → -20
 *   ±10  edge_status HEALTHY → +10; WATCH → +5; WARNING → -10; CRIT/COLLAPSE → -25
 *   ±15  behavior_mode AGGRESSIVE → +15; NORMAL → +8; DEFENSIVE → -5; STANDBY → -30
 *
 * Confidence Score (base 20, consistency bias):
 *   ±25  90d trade count ≥50 → +25; ≥25 → +15; ≥10 → +5
 *   ±20  WR consistency: |30d − 90d delta| < 0.05 → +20; <0.10 → +10; >0.15 → -10
 *   ±20  Regime breadth: ≥3 regimes with WR > 0.50 → +20; ≥2 → +10; 0 → -5
 *   ±20  Trades/week ≥4 → +20; ≥2 → +10; <1 → -5
 *   ±15  PF stability (this/last month ratio 0.75–1.35) → +15; outside 0.60–1.60 → -10
 *
 * Allocation Score = 0.5 × health + 0.5 × confidence
 * Portfolio weight = 0.50 + (allocation_score / 100)   [range: 0.50–1.50]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, withOverridesLock } = require('./worker-utils');

const WORKER_NAME = 'strategy-ranking';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];

// ── Score helpers ─────────────────────────────────────────────────────────────

function computeHealthScore({ wr30d, pf30d, expectancy30d, maxLossStreak, edgeStatus, behaviorMode }) {
  let score = 0;

  if (wr30d != null) {
    if      (wr30d >= 0.60) score += 25;
    else if (wr30d >= 0.55) score += 15;
    else if (wr30d >= 0.50) score +=  5;
    else if (wr30d <  0.35) score -= 25;
    else if (wr30d <  0.40) score -= 15;
  }

  if (pf30d != null) {
    if      (pf30d >= 1.8) score += 20;
    else if (pf30d >= 1.4) score += 10;
    else if (pf30d <  1.0) score -= 15;
  }

  if (expectancy30d != null) {
    if      (expectancy30d > 0.50) score += 15;
    else if (expectancy30d > 0.25) score +=  8;
    else if (expectancy30d < 0)    score -= 10;
  }

  if (maxLossStreak != null) {
    if      (maxLossStreak <= 3)  score += 15;
    else if (maxLossStreak <= 5)  score +=  8;
    else if (maxLossStreak >= 12) score -= 20;
    else if (maxLossStreak >= 8)  score -= 10;
  }

  score += { HEALTHY: 10, WATCH: 5, WARNING: -10, CRITICAL: -25, COLLAPSE: -25 }[edgeStatus] ?? 0;
  score += { AGGRESSIVE: 15, NORMAL: 8, DEFENSIVE: -5, STANDBY: -30 }[behaviorMode] ?? 0;

  return Math.max(0, Math.min(100, Math.round(score + 50)));
}

function computeConfidenceScore({ tradeCount90d, wr30d, wr90d, goodRegimes, tradesPerWeek, pfThisMonth, pfLastMonth }) {
  let score = 0;

  if      (tradeCount90d >= 50) score += 25;
  else if (tradeCount90d >= 25) score += 15;
  else if (tradeCount90d >= 10) score +=  5;

  if (wr30d != null && wr90d != null) {
    const delta = Math.abs(wr30d - wr90d);
    if      (delta < 0.05) score += 20;
    else if (delta < 0.10) score += 10;
    else if (delta > 0.15) score -= 10;
  }

  if      (goodRegimes >= 3) score += 20;
  else if (goodRegimes >= 2) score += 10;
  else if (goodRegimes === 0) score -=  5;

  if      (tradesPerWeek >= 4) score += 20;
  else if (tradesPerWeek >= 2) score += 10;
  else if (tradesPerWeek <  1) score -=  5;

  if (pfThisMonth != null && pfLastMonth != null && pfLastMonth > 0) {
    const ratio = pfThisMonth / pfLastMonth;
    if (ratio >= 0.75 && ratio <= 1.35) score += 15;
    else if (ratio < 0.60 || ratio > 1.60) score -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(score + 20)));
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS strategy_rankings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date         TEXT NOT NULL,
      strategy_name    TEXT NOT NULL,
      instrument       TEXT,
      health_score     INTEGER,
      confidence_score INTEGER,
      allocation_score INTEGER,
      rank_position    INTEGER,
      wr_30d           REAL,
      wr_90d           REAL,
      pf_30d           REAL,
      expectancy_30d   REAL,
      trade_count_90d  INTEGER,
      max_loss_streak  INTEGER,
      trades_per_week  REAL,
      edge_status      TEXT,
      behavior_mode    TEXT,
      notes            TEXT,
      computed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name)
    )
  `).run();

  const insertRanking = db.prepare(`
    INSERT OR REPLACE INTO strategy_rankings
      (run_date, strategy_name, instrument, health_score, confidence_score, allocation_score,
       rank_position, wr_30d, wr_90d, pf_30d, expectancy_30d,
       trade_count_90d, max_loss_streak, trades_per_week, edge_status, behavior_mode, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate  = new Date().toISOString().slice(0, 10);
  const rankings = [];
  let processed  = 0;

  for (const strategy of STRATEGIES) {
    try {
      const instrument = strategy.startsWith('MGC') ? 'MGC' : 'MNQ';

      // ── 30-day performance ─────────────────────────────────────────────────
      const perf30 = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
          AVG(CASE WHEN outcome = 'WIN'  THEN pnl_pts ELSE NULL END) AS avg_win,
          AVG(CASE WHEN outcome = 'LOSS' THEN ABS(pnl_pts) ELSE NULL END) AS avg_loss,
          AVG(pnl_pts) AS expectancy
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND source = 'LIVE'
          AND trade_date >= date('now', '-30 days')
      `).get(strategy);

      const wr30d  = (perf30?.total >= 5) ? perf30.wins / perf30.total : null;
      const pf30d  = (perf30?.wins > 0 && perf30?.losses > 0 && perf30.avg_loss > 0)
        ? +((perf30.avg_win * perf30.wins) / (perf30.avg_loss * perf30.losses)).toFixed(3)
        : null;
      const expectancy30d = perf30?.expectancy ?? null;

      // ── 90-day performance ─────────────────────────────────────────────────
      const perf90 = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND source = 'LIVE'
          AND trade_date >= date('now', '-90 days')
      `).get(strategy);

      const wr90d         = (perf90?.total >= 5) ? perf90.wins / perf90.total : null;
      const tradeCount90d = perf90?.total ?? 0;

      // ── Trades per week (last 28 days) ─────────────────────────────────────
      const freq          = db.prepare(
        `SELECT COUNT(*) AS n FROM trade_dna
         WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
           AND source = 'LIVE' AND trade_date >= date('now', '-28 days')`
      ).get(strategy);
      const tradesPerWeek = (freq?.n ?? 0) / 4;

      // ── Max loss streak (90 days) ──────────────────────────────────────────
      const outcomeRows = db.prepare(`
        SELECT outcome FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND source = 'LIVE'
          AND trade_date >= date('now', '-90 days')
        ORDER BY trade_date ASC
      `).all(strategy);

      let maxLossStreak = 0, curStreak = 0;
      for (const r of outcomeRows) {
        if (r.outcome === 'LOSS') { curStreak++; maxLossStreak = Math.max(maxLossStreak, curStreak); }
        else curStreak = 0;
      }

      // ── PF this month vs last month ────────────────────────────────────────
      function monthPF(daysStart, daysEnd) {
        const start = new Date(Date.now() + daysStart * 86400000).toISOString().slice(0, 10);
        const end   = new Date(Date.now() + daysEnd   * 86400000).toISOString().slice(0, 10);
        const r = db.prepare(`
          SELECT AVG(CASE WHEN outcome='WIN'  THEN pnl_pts ELSE NULL END) AS avg_win,
                 AVG(CASE WHEN outcome='LOSS' THEN ABS(pnl_pts) ELSE NULL END) AS avg_loss,
                 SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) AS wins,
                 SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) AS losses
          FROM trade_dna
          WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
            AND source = 'LIVE'
            AND trade_date >= ? AND trade_date < ?
        `).get(strategy, start, end);
        if (!r || (r.wins ?? 0) < 3 || (r.losses ?? 0) < 1 || !r.avg_loss) return null;
        return +((r.avg_win * r.wins) / (r.avg_loss * r.losses)).toFixed(3);
      }
      const pfThisMonth = monthPF(-30, 0);
      const pfLastMonth = monthPF(-60, -30);

      // ── Regime breadth ─────────────────────────────────────────────────────
      const regimeRows = db.prepare(`
        SELECT regime, win_rate FROM regime_performance_stats
        WHERE strategy_name = ?
        ORDER BY run_date DESC LIMIT 20
      `).all(strategy);

      const latestByRegime = {};
      for (const r of regimeRows) {
        if (!latestByRegime[r.regime]) latestByRegime[r.regime] = r;
      }
      const goodRegimes = Object.values(latestByRegime).filter(r => r.win_rate >= 0.50).length;

      // ── Edge health ────────────────────────────────────────────────────────
      const edgeRow = db.prepare(
        `SELECT edge_status FROM edge_health_log WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
      ).get(strategy);
      const edgeStatus = edgeRow?.edge_status ?? 'HEALTHY';

      // ── Regime behavior mode ───────────────────────────────────────────────
      const modeRow = db.prepare(
        `SELECT behavior_mode FROM regime_health_log WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
      ).get(strategy);
      const behaviorMode = modeRow?.behavior_mode ?? 'NORMAL';

      // ── Compute scores ─────────────────────────────────────────────────────
      const healthScore = computeHealthScore({
        wr30d, pf30d, expectancy30d, maxLossStreak, edgeStatus, behaviorMode,
      });
      const confidenceScore = computeConfidenceScore({
        tradeCount90d, wr30d, wr90d, goodRegimes, tradesPerWeek, pfThisMonth, pfLastMonth,
      });
      const allocationScore = Math.round(0.5 * healthScore + 0.5 * confidenceScore);

      const notes = [];
      if (wr30d == null)          notes.push('insufficient_30d_data');
      if (tradeCount90d < 10)     notes.push('low_trade_count');
      if (edgeStatus === 'CRITICAL' || edgeStatus === 'COLLAPSE') notes.push(`edge_${edgeStatus.toLowerCase()}`);
      if (behaviorMode === 'STANDBY') notes.push('regime_standby');

      rankings.push({
        strategy, instrument,
        healthScore, confidenceScore, allocationScore,
        wr30d, wr90d, pf30d, expectancy30d,
        tradeCount90d, maxLossStreak, tradesPerWeek,
        edgeStatus, behaviorMode,
        notes: notes.join('; ') || null,
      });

      processed++;
      console.log(
        `[${WORKER_NAME}] ${strategy}: health=${healthScore} conf=${confidenceScore} alloc=${allocationScore} ` +
        `wr30d=${wr30d != null ? (wr30d * 100).toFixed(0) + '%' : 'n/a'} edge=${edgeStatus} mode=${behaviorMode}`,
      );
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── Rank and compute portfolio weights ───────────────────────────────────────
  rankings.sort((a, b) => b.allocationScore - a.allocationScore);

  const ranked = rankings.map((r, idx) => ({
    ...r,
    rankPos:       idx + 1,
    portfolioWeight: +(0.50 + r.allocationScore / 100).toFixed(3),
  }));

  // ── Phase B: write all portfolio weights atomically ────────────────────────
  withOverridesLock(db, overrides => {
    for (const r of ranked) {
      if (!overrides[r.strategy]) overrides[r.strategy] = {};
      overrides[r.strategy].portfolioWeight = r.portfolioWeight;
    }
  });

  // ── Phase C: persist rankings and notify OUTSIDE the lock ─────────────────
  for (const r of ranked) {
    insertRanking.run(
      runDate, r.strategy, r.instrument,
      r.healthScore, r.confidenceScore, r.allocationScore,
      r.rankPos,
      r.wr30d         != null ? +r.wr30d.toFixed(4)         : null,
      r.wr90d         != null ? +r.wr90d.toFixed(4)         : null,
      r.pf30d         != null ? +r.pf30d.toFixed(3)         : null,
      r.expectancy30d != null ? +r.expectancy30d.toFixed(2) : null,
      r.tradeCount90d, r.maxLossStreak,
      +r.tradesPerWeek.toFixed(2),
      r.edgeStatus, r.behaviorMode, r.notes,
    );

    console.log(`[${WORKER_NAME}] #${r.rankPos} ${r.strategy}: alloc=${r.allocationScore} weight=${r.portfolioWeight}`);

    if (r.rankPos === 1) {
      try {
        insertMsg.run(
          'strategy-ranking', 'observation', r.strategy, 4,
          JSON.stringify({
            rank:             r.rankPos,
            health_score:     r.healthScore,
            confidence_score: r.confidenceScore,
            allocation_score: r.allocationScore,
            portfolio_weight: r.portfolioWeight,
            reason:           `Top-ranked strategy — highest capital allocation priority (score ${r.allocationScore})`,
          }),
        );
      } catch (_) {}
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed,
    rankings: rankings.map(r => ({ strategy: r.strategy, score: r.allocationScore })),
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies ranked`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
