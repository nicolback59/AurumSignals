'use strict';

/**
 * REGIME CLASSIFIER VALIDATOR  (Prompt #15 Phase 3 — Red Team Foundation)
 *
 * Addresses the third critical red-team finding: the regime classifier is
 * treated as ground truth when it is itself an untested model. The entire
 * sizing pipeline depends on regime labels being correct and predictive, yet
 * no test has ever been run asking: "Do TREND_BULL trades actually outperform
 * NORMAL trades? Is the 1.25× multiplier justified by data?"
 *
 * Current hardcoded regime multipliers in scanner-core.js:
 *   TREND_BULL: 1.25  TREND_BEAR: 1.25  EXPANSION: 1.10
 *   NORMAL: 1.00  SOFT_CHOP: 0.80  COMPRESSION: 0.70  RANGE_CHOP: 0.35
 *
 * These numbers were set by intuition. This worker tests each one empirically.
 *
 * Per strategy, per regime label, over a 180-day window:
 *   - n, WR, avg_pnl, expectancy vs baseline
 *   - z-test: is this regime's WR significantly different from NORMAL?
 *   - current_multiplier: what scanner-core currently uses
 *   - empirical_multiplier: WR(regime) / WR(NORMAL) — what data justifies
 *   - multiplier_delta: how far off the current multiplier is from data
 *   - multiplier_validated: 1 = z-test supports using a multiplier ≠ 1.0
 *
 * Also validates the regime quality score adjustment in Part 5 of scanner-core:
 *   TREND_BULL/BEAR +10pts, EXPANSION +5, COMPRESSION -5, RANGE_CHOP -15
 *
 * Runs weekly Sunday 08:00 UTC (after quality-score-validator at 07:30).
 *
 * Posts agent_messages (priority 2) when:
 *   - A positive multiplier (>1.0) has no statistically significant edge
 *   - A negative multiplier (<1.0) is not significantly worse than NORMAL
 *   - Empirical multiplier differs from current by > 0.20
 *
 * Writes to regime_classifier_validation + regime_quality_weights.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME  = 'regime-classifier-validator';
const STRATEGIES   = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const WINDOW_DAYS  = 180;
const MIN_N        = 12;
const Z_THRESHOLD  = 1.28;   // p < 0.10 one-tailed — sufficient for multiplier validation
const MULT_DELTA_ALERT = 0.20;  // flag if empirical differs from current by > this

// Current hardcoded multipliers from scanner-core.js (source of truth for comparison)
const CURRENT_REGIME_MULT = {
  TREND_BULL:  1.25,
  TREND_BEAR:  1.25,
  EXPANSION:   1.10,
  NORMAL:      1.00,
  SOFT_CHOP:   0.80,
  COMPRESSION: 0.70,
  RANGE_CHOP:  0.35,
};

// Current quality pts adjustment from scanner-core.js Part 5
const CURRENT_REGIME_PTS = {
  TREND_BULL:  10,
  TREND_BEAR:  10,
  EXPANSION:    5,
  NORMAL:       0,
  SOFT_CHOP:    0,
  COMPRESSION: -5,
  RANGE_CHOP: -15,
};

// ── Statistical helpers ───────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function zTestProps(n1, p1, n2, p2) {
  if (n1 < 2 || n2 < 2) return 0;
  const p = (n1 * p1 + n2 * p2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? +((p1 - p2) / se).toFixed(3) : 0;
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS regime_classifier_validation (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date              TEXT NOT NULL,
      strategy_name         TEXT NOT NULL,
      regime                TEXT NOT NULL,
      trade_count           INTEGER,
      win_rate              REAL,
      baseline_wr           REAL,
      wr_delta              REAL,
      z_score               REAL,
      avg_pnl_pts           REAL,
      expectancy_score      REAL,
      current_multiplier    REAL,
      empirical_multiplier  REAL,
      multiplier_delta      REAL,
      multiplier_validated  INTEGER,
      current_quality_pts   INTEGER,
      empirical_quality_pts REAL,
      quality_pts_delta     REAL,
      recommendation        TEXT,
      computed_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, regime)
    )
  `).run();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO regime_classifier_validation
      (run_date, strategy_name, regime, trade_count, win_rate, baseline_wr,
       wr_delta, z_score, avg_pnl_pts, expectancy_score,
       current_multiplier, empirical_multiplier, multiplier_delta,
       multiplier_validated, current_quality_pts, empirical_quality_pts,
       quality_pts_delta, recommendation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate = new Date().toISOString().slice(0, 10);
  const allFindings = [];

  for (const strategy of STRATEGIES) {
    try {
      // Pull all trades in window
      const trades = db.prepare(`
        SELECT outcome, pnl_pts, regime, confidence
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND trade_date >= date('now', '-${WINDOW_DAYS} days')
          AND regime IS NOT NULL
      `).all(strategy);

      if (trades.length < MIN_N * 2) {
        console.log(`[${WORKER_NAME}] ${strategy}: insufficient trades (${trades.length}) — skip`);
        continue;
      }

      const baselineWins = trades.filter(t => t.outcome === 'WIN').length;
      const baselineWr   = baselineWins / trades.length;
      const baselineExp  = mean(trades.map(t => t.pnl_pts ?? 0));

      // NORMAL regime stats — used as the denominator for empirical_multiplier
      const normalTrades = trades.filter(t => t.regime === 'NORMAL');
      const normalWr     = normalTrades.length >= MIN_N
        ? normalTrades.filter(t => t.outcome === 'WIN').length / normalTrades.length
        : baselineWr;

      // Group by regime
      const byRegime = {};
      for (const t of trades) {
        if (!byRegime[t.regime]) byRegime[t.regime] = [];
        byRegime[t.regime].push(t);
      }

      const stratFindings = [];

      for (const [regime, grp] of Object.entries(byRegime)) {
        if (grp.length < MIN_N) continue;

        const wins    = grp.filter(t => t.outcome === 'WIN').length;
        const wr      = wins / grp.length;
        const wrDelta = wr - baselineWr;
        const avgPnl  = mean(grp.map(t => t.pnl_pts ?? 0));

        // z-test this regime WR vs baseline (using all other trades as control)
        const otherTrades = trades.filter(t => t.regime !== regime);
        const otherWins   = otherTrades.filter(t => t.outcome === 'WIN').length;
        const otherWr     = otherTrades.length ? otherWins / otherTrades.length : baselineWr;
        const z = zTestProps(grp.length, wr, otherTrades.length || 1, otherWr);

        // Empirical multiplier: WR(regime) / WR(NORMAL)
        // Clamped to [0.20, 1.80] — extreme values are likely data artefacts
        const empiricalMult = normalWr > 0
          ? Math.max(0.20, Math.min(1.80, +(wr / normalWr).toFixed(3)))
          : 1.0;

        const currentMult  = CURRENT_REGIME_MULT[regime] ?? 1.0;
        const multDelta    = +(empiricalMult - currentMult).toFixed(3);

        // Is the multiplier validated?
        // Positive multiplier (>1.0): need z >= Z_THRESHOLD to confirm edge
        // Negative multiplier (<1.0): need z <= -Z_THRESHOLD to confirm avoid
        const expectsEdge  = currentMult > 1.00;
        const expectsAvoid = currentMult < 1.00;
        const validated =
          (expectsEdge  && z >=  Z_THRESHOLD) ? 1 :
          (expectsAvoid && z <= -Z_THRESHOLD) ? 1 :
          (currentMult === 1.0)               ? 1 :  // NORMAL always valid
          0;

        // Empirical quality pts: WR delta × 100 (same approach as quality-score-validator)
        const empiricalQPts = +(wrDelta * 100).toFixed(1);
        const currentQPts   = CURRENT_REGIME_PTS[regime] ?? 0;
        const qptsDelta     = +(empiricalQPts - currentQPts).toFixed(1);

        // Recommendation
        let recommendation = 'VALIDATED';
        if (!validated) {
          if (expectsEdge) {
            recommendation = `OVERSTATED — ${regime} gets ${currentMult}× but WR delta is only ${(wrDelta*100).toFixed(0)}% (z=${z.toFixed(2)}). Consider reducing to ~${empiricalMult.toFixed(2)}×`;
          } else {
            recommendation = `UNDERSTATED_PENALTY — ${regime} gets ${currentMult}× but WR delta is ${(wrDelta*100).toFixed(0)}% (z=${z.toFixed(2)}). Consider adjusting to ~${empiricalMult.toFixed(2)}×`;
          }
        } else if (Math.abs(multDelta) >= MULT_DELTA_ALERT) {
          recommendation = `RECALIBRATE — validated direction correct but magnitude off: current ${currentMult}×, empirical ${empiricalMult}×`;
        }

        upsert.run(
          runDate, strategy, regime,
          grp.length, +wr.toFixed(4), +baselineWr.toFixed(4),
          +wrDelta.toFixed(4), z,
          +avgPnl.toFixed(3), +avgPnl.toFixed(3),  // expectancy ≈ avg_pnl per trade
          currentMult, empiricalMult, multDelta,
          validated,
          currentQPts, empiricalQPts, qptsDelta,
          recommendation,
        );

        const needsAlert = !validated || Math.abs(multDelta) >= MULT_DELTA_ALERT;
        if (needsAlert && grp.length >= MIN_N) {
          stratFindings.push({ regime, validated, multDelta, recommendation, z, grp_n: grp.length });
          allFindings.push(`${strategy}/${regime}: ${recommendation} (n=${grp.length})`);
        }

        console.log(
          `[${WORKER_NAME}] ${strategy} ${regime}: n=${grp.length} WR=${(wr*100).toFixed(0)}% ` +
          `z=${z.toFixed(2)} mult=${currentMult}→${empiricalMult} [${validated ? 'OK' : 'UNVALIDATED'}]`
        );
      }

      // Post per-strategy findings
      if (stratFindings.length > 0) {
        try {
          insertMsg.run(
            WORKER_NAME, 'observation', strategy, 2,
            JSON.stringify({
              alert: 'regime_multipliers_unvalidated',
              window_days: WINDOW_DAYS,
              findings: stratFindings.map(f => ({
                regime: f.regime, validated: f.validated,
                multiplier_delta: f.multDelta, z_score: f.z,
                recommendation: f.recommendation,
              })),
              note: `${strategy}: ${stratFindings.length} regime multiplier(s) need review`,
            }),
          );
        } catch (_) {}
      }
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── ntfy digest ──────────────────────────────────────────────────────────────
  const summary = db.prepare(`
    SELECT strategy_name, regime, win_rate, baseline_wr, current_multiplier,
           empirical_multiplier, multiplier_delta, multiplier_validated, z_score
    FROM regime_classifier_validation
    WHERE run_date = ? AND multiplier_validated = 0
    ORDER BY ABS(multiplier_delta) DESC
    LIMIT 8
  `).all(runDate);

  if (summary.length > 0) {
    const lines = summary.map(r =>
      `${r.strategy_name}/${r.regime}: current ${r.current_multiplier}× → empirical ${r.empirical_multiplier?.toFixed(2)}× (z=${r.z_score?.toFixed(2)})`
    );
    await sendNotification(
      'Regime Classifier — Unvalidated Multipliers Detected',
      `${summary.length} regime multiplier(s) not supported by data:\n${lines.join('\n')}`,
      { priority: 'default', tags: 'warning,bar_chart' },
    );
  } else {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM regime_classifier_validation WHERE run_date = ?`).get(runDate)?.n ?? 0;
    if (total > 0) {
      await sendNotification(
        'Regime Classifier — All Multipliers Validated',
        `All ${total} regime × strategy combinations pass z-test validation`,
        { priority: 'low', tags: 'white_check_mark,bar_chart' },
      );
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    findings: allFindings.length,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${allFindings.length} multiplier(s) flagged`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
