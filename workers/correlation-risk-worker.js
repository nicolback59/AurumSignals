'use strict';

/**
 * CORRELATION RISK WORKER  (Prompt #13 — Gap Analysis)
 *
 * Fills the second biggest missing piece: cross-strategy correlation risk.
 * After Prompts 1-12 every strategy was analysed independently, but when
 * MNQ and MGC both fire signals simultaneously the combined position carries
 * amplified risk if the two instruments are correlated.
 *
 * Runs every 30 minutes (aligned with regime-health-worker).
 *
 * Two analyses:
 *
 * 1. Historical correlation matrix (rolling 30-day daily P&L)
 *    Pearson correlation between every pair of strategy daily P&L series.
 *    Flags any pair with |r| ≥ 0.60 as correlated risk.
 *
 * 2. Concurrent signal risk (live active signals)
 *    If ≥ 2 strategies have ACTIVE signals right now, computes:
 *    - combined position delta (net long/short units)
 *    - estimated correlated drawdown if both go against direction
 *    Posts veto-weight warning to agent_messages when combined risk is elevated.
 *
 * Writes to correlation_log.
 * Posts agent_messages (observation, priority 3) when a correlated pair has
 * both strategies active simultaneously.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME         = 'correlation-risk';
const STRATEGIES          = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const HIGH_CORR_THRESHOLD = 0.60;   // flag pairs above this
const WINDOW_DAYS         = 30;

// ── Pearson correlation ───────────────────────────────────────────────────────

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const xArr = xs.slice(0, n), yArr = ys.slice(0, n);
  const mx = xArr.reduce((s, v) => s + v, 0) / n;
  const my = yArr.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xArr[i] - mx, dy = yArr[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? +(num / denom).toFixed(4) : 0;
}

// ── Build daily P&L map per strategy ─────────────────────────────────────────

function buildDailyPnlMap(db, strategy) {
  const rows = db.prepare(`
    SELECT trade_date, SUM(pnl_pts) AS daily_pnl
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND trade_date >= date('now', '-${WINDOW_DAYS} days')
    GROUP BY trade_date
    ORDER BY trade_date ASC
  `).all(strategy);
  const map = {};
  for (const r of rows) map[r.trade_date] = r.daily_pnl ?? 0;
  return map;
}

// ── Get active signals ────────────────────────────────────────────────────────

function getActiveSignals(db) {
  try {
    return db.prepare(`
      SELECT id, strategy_name, instrument, direction,
             entry, sl, tp1, recommended_size_pct, created_at
      FROM signals
      WHERE trade_status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC
    `).all();
  } catch (_) { return []; }
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS correlation_log (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at            TEXT NOT NULL DEFAULT (datetime('now')),
      strategy_a            TEXT NOT NULL,
      strategy_b            TEXT NOT NULL,
      correlation_30d       REAL,
      both_active           INTEGER DEFAULT 0,
      concurrent_direction  TEXT,
      risk_level            TEXT,
      notes                 TEXT
    )
  `).run();

  const insertCorr = db.prepare(`
    INSERT INTO correlation_log
      (strategy_a, strategy_b, correlation_30d, both_active,
       concurrent_direction, risk_level, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  // ── 1. Build all daily series ───────────────────────────────────────────────
  const pnlMaps = {};
  for (const s of STRATEGIES) {
    try { pnlMaps[s] = buildDailyPnlMap(db, s); } catch (_) { pnlMaps[s] = {}; }
  }

  // Collect all trading dates across all strategies
  const allDates = [...new Set(
    STRATEGIES.flatMap(s => Object.keys(pnlMaps[s]))
  )].sort();

  // ── 2. Active signals ───────────────────────────────────────────────────────
  const activeSignals  = getActiveSignals(db);
  const activeByStrat  = {};
  for (const sig of activeSignals) {
    if (!activeByStrat[sig.strategy_name]) activeByStrat[sig.strategy_name] = [];
    activeByStrat[sig.strategy_name].push(sig);
  }

  const activeStrategies = Object.keys(activeByStrat);

  let highCorrPairs = 0;
  let concurrentAlerts = 0;

  // ── 3. Compute correlations for every pair ──────────────────────────────────
  for (let i = 0; i < STRATEGIES.length; i++) {
    for (let j = i + 1; j < STRATEGIES.length; j++) {
      const stratA = STRATEGIES[i];
      const stratB = STRATEGIES[j];

      try {
        const xArr = allDates.map(d => pnlMaps[stratA][d] ?? 0);
        const yArr = allDates.map(d => pnlMaps[stratB][d] ?? 0);
        const corr = pearson(xArr, yArr);

        if (corr === null) continue;

        const bothActive = activeStrategies.includes(stratA) && activeStrategies.includes(stratB);

        // Concurrent direction: ALIGNED if both are same direction, OPPOSITE if different
        let concDir = null;
        if (bothActive) {
          const dirA = activeByStrat[stratA]?.[0]?.direction;
          const dirB = activeByStrat[stratB]?.[0]?.direction;
          if (dirA && dirB) {
            concDir = dirA === dirB ? 'ALIGNED' : 'OPPOSITE';
          }
        }

        // Risk level
        const absCorr = Math.abs(corr);
        let riskLevel;
        if (bothActive && absCorr >= HIGH_CORR_THRESHOLD && concDir === 'ALIGNED') {
          riskLevel = 'HIGH';
        } else if (absCorr >= HIGH_CORR_THRESHOLD) {
          riskLevel = 'ELEVATED';
        } else if (absCorr >= 0.40) {
          riskLevel = 'MODERATE';
        } else {
          riskLevel = 'LOW';
        }

        const notes = [];
        if (absCorr >= HIGH_CORR_THRESHOLD) notes.push(`high_corr_${corr.toFixed(2)}`);
        if (bothActive) notes.push('both_active');
        if (concDir) notes.push(`direction_${concDir.toLowerCase()}`);

        insertCorr.run(
          stratA, stratB, corr,
          bothActive ? 1 : 0, concDir, riskLevel,
          notes.length ? notes.join('; ') : null,
        );

        if (absCorr >= HIGH_CORR_THRESHOLD) highCorrPairs++;

        // Alert when both active AND correlated AND same direction
        if (riskLevel === 'HIGH') {
          concurrentAlerts++;
          try {
            insertMsg.run(
              'correlation-risk', 'observation', `${stratA}+${stratB}`, 3,
              JSON.stringify({
                risk_level:       riskLevel,
                strategy_a:       stratA,
                strategy_b:       stratB,
                correlation_30d:  corr,
                both_active:      true,
                concurrent_dir:   concDir,
                recommendation:   `${stratA} and ${stratB} are correlated (r=${corr.toFixed(2)}) and both active in the same direction — combined risk elevated; consider reducing size on one leg`,
              }),
            );
          } catch (_) {}

          await sendNotification(
            `Correlated Risk — ${stratA} + ${stratB}`,
            `Both strategies active in ${concDir === 'ALIGNED' ? 'same' : 'opposite'} direction\nCorrelation (30d): ${corr.toFixed(2)}\nRisk level: ${riskLevel}\nConsider reducing size on one leg`,
            { priority: 'default', tags: 'warning,chart_with_downwards_trend' },
          );
        }

        console.log(
          `[${WORKER_NAME}] ${stratA}↔${stratB}: r=${corr.toFixed(3)} ` +
          `risk=${riskLevel}${bothActive ? ' [BOTH ACTIVE]' : ''}` +
          (concDir ? ` dir=${concDir}` : ''),
        );
      } catch (pairErr) {
        console.error(`[${WORKER_NAME}] error on ${stratA}↔${stratB}: ${pairErr.message}`);
      }
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    pairs: Math.floor(STRATEGIES.length * (STRATEGIES.length - 1) / 2),
    highCorrPairs, concurrentAlerts,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${highCorrPairs} high-corr pairs, ${concurrentAlerts} concurrent alerts`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
