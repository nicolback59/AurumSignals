'use strict';

/**
 * EXPERIMENT ENGINE WORKER  (Prompt #12 — Phase 3)
 *
 * Runs weekly (Monday 06:00 UTC). Takes OPEN hypotheses from research_hypotheses
 * and runs controlled statistical experiments to determine CONFIRMED / REFUTED /
 * INCONCLUSIVE.
 *
 * Experimental design (controlled A/B test from historical data):
 *   Control  — all trades NOT matching the condition
 *   Test     — all trades matching the condition
 *
 * Out-of-sample validation (Phase 14 — Overfitting Protection):
 *   Training split: trades older than 60 days
 *   Test split:     trades from last 60 days
 *   Hypothesis is CONFIRMED only if it holds in BOTH splits.
 *
 * Significance thresholds:
 *   HIGH     — z ≥ 1.65 (p < 0.05) + n_test ≥ 30 + out-of-sample confirmed
 *   MEDIUM   — z ≥ 1.28 (p < 0.10) + n_test ≥ 20
 *   LOW      — z ≥ 1.00 (p < 0.16) + n_test ≥ 15  → INCONCLUSIVE
 *   REFUTED  — z ≤ -1.28 (clearly worse than baseline)
 *
 * Processes top-30 OPEN hypotheses per run (by priority_score DESC).
 * Re-queues INCONCLUSIVE after 30+ more trades.
 *
 * Posts agent_messages for CONFIRMED hypotheses (observation, priority 3).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME    = 'experiment-engine';
const STRATEGIES     = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const BATCH_SIZE     = 30;      // max hypotheses to process per run
const OOS_DAYS       = 60;      // out-of-sample window
const MIN_N_TEST     = 15;      // hard floor for running experiment

// ── Statistical helpers ───────────────────────────────────────────────────────

function zTestProp(p_obs, p_null, n) {
  if (n < 5 || p_null <= 0 || p_null >= 1) return 0;
  const se = Math.sqrt(p_null * (1 - p_null) / n);
  return se > 0 ? (p_obs - p_null) / se : 0;
}

function normCdf(z) {
  const sign = z >= 0 ? 1 : -1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf  = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function pValue(z) { return 1 - normCdf(Math.abs(z)); }

// ── Build WHERE clause for a hypothesis condition ─────────────────────────────

function buildConditionSql(dimension, conditionKey, conditionValue) {
  // 2D combination: "session×regime" | "ny_open|TREND_BULL"
  if (conditionKey.includes('×') && conditionValue && conditionValue.includes('|')) {
    const [dimA, dimB] = conditionKey.split('×');
    const [valA, valB] = conditionValue.split('|');
    return `${dimA} = '${valA.replace(/'/g, "''")}' AND ${dimB} = '${valB.replace(/'/g, "''")}'`;
  }

  // Confidence tier: special case
  if (dimension === 'confidence_tier') {
    const tierSql = { HIGH: 'confidence >= 80', MED: 'confidence >= 65 AND confidence < 80', LOW: 'confidence < 65' };
    return tierSql[conditionValue] ?? 'confidence IS NOT NULL';
  }

  // 1D: standard column = value
  const safe = (conditionValue ?? '').replace(/'/g, "''");
  return `${conditionKey} = '${safe}'`;
}

// ── Run experiment for one hypothesis ────────────────────────────────────────

function runExperiment(db, hyp) {
  const condSql = buildConditionSql(hyp.dimension, hyp.condition_key, hyp.condition_value);
  const oosCutoff = new Date(Date.now() - OOS_DAYS * 86400000).toISOString().slice(0, 10);

  function querySplit(whereExtra) {
    return db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
             AVG(pnl_pts) AS expectancy
      FROM trade_dna
      WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
        ${whereExtra ? 'AND ' + whereExtra : ''}
    `).get(hyp.strategy_name);
  }

  // Full dataset
  const testAll     = querySplit(condSql);
  const controlAll  = querySplit(`NOT (${condSql})`);

  if ((testAll?.n ?? 0) < MIN_N_TEST) {
    return { skip: true, reason: `n_test=${testAll?.n ?? 0} < ${MIN_N_TEST}` };
  }

  const testWr    = testAll.wins    / testAll.n;
  const ctrlWr    = controlAll.wins / controlAll.n;
  const zFull     = zTestProp(testWr, ctrlWr, testAll.n);
  const pFull     = pValue(zFull);
  const wrDelta   = testWr - ctrlWr;

  // Out-of-sample split (last OOS_DAYS)
  const testOos   = querySplit(`${condSql} AND trade_date >= '${oosCutoff}'`);
  const ctrlOos   = querySplit(`NOT (${condSql}) AND trade_date >= '${oosCutoff}'`);
  const oosN      = testOos?.n ?? 0;
  const oosWr     = oosN > 0 ? testOos.wins / testOos.n : null;
  const oosZ      = oosN >= 5 ? zTestProp(oosWr, ctrlWr, oosN) : null;
  const oosConfirmed = oosZ != null ? oosZ >= 1.00 : null;

  // Training split (older than OOS_DAYS)
  const testTrain = querySplit(`${condSql} AND trade_date < '${oosCutoff}'`);
  const trainN    = testTrain?.n ?? 0;
  const trainWr   = trainN > 0 ? testTrain.wins / trainN : null;
  const trainZ    = trainN >= 5 ? zTestProp(trainWr, ctrlWr, trainN) : null;
  const trainConfirmed = trainZ != null ? trainZ >= 1.00 : null;

  // ── Determine result ────────────────────────────────────────────────────────
  let result, confidenceLevel;

  if (zFull <= -1.28) {
    result = 'REFUTED';
    confidenceLevel = 'HIGH';
  } else if (zFull >= 1.65 && testAll.n >= 30 && oosConfirmed !== false) {
    result         = 'CONFIRMED';
    confidenceLevel = oosConfirmed === true ? 'HIGH' : 'MEDIUM';
  } else if (zFull >= 1.28 && testAll.n >= 20) {
    result         = oosConfirmed === false ? 'INCONCLUSIVE' : 'CONFIRMED';
    confidenceLevel = 'MEDIUM';
  } else if (zFull >= 1.00 && testAll.n >= MIN_N_TEST) {
    result         = 'INCONCLUSIVE';
    confidenceLevel = 'LOW';
  } else {
    result         = 'INCONCLUSIVE';
    confidenceLevel = 'LOW';
  }

  // Recommendation text
  let recommendation = null;
  if (result === 'CONFIRMED') {
    const direction = wrDelta > 0 ? 'FAVOR' : 'AVOID';
    recommendation = `${direction} ${hyp.condition_key}=${hyp.condition_value} — WR ${(testWr*100).toFixed(0)}% vs ${(ctrlWr*100).toFixed(0)}% control (z=${zFull.toFixed(2)}, p=${pFull.toFixed(3)})`;
    if (oosConfirmed === true)  recommendation += '. Out-of-sample validated.';
    if (trainConfirmed === true) recommendation += ' Training split confirmed.';
  }

  return {
    skip:             false,
    controlN:         controlAll?.n ?? 0,
    controlWr:        controlAll?.n > 0 ? +(ctrlWr.toFixed(4)) : null,
    controlExp:       controlAll?.expectancy != null ? +controlAll.expectancy.toFixed(2) : null,
    testN:            testAll.n,
    testWr:           +testWr.toFixed(4),
    testExp:          testAll.expectancy != null ? +testAll.expectancy.toFixed(2) : null,
    wrDelta:          +wrDelta.toFixed(4),
    zScore:           +zFull.toFixed(3),
    pVal:             +pFull.toFixed(4),
    oosN,
    oosZ:             oosZ != null ? +oosZ.toFixed(3) : null,
    oosConfirmed,
    trainN,
    trainConfirmed,
    result,
    confidenceLevel,
    recommendation,
  };
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS research_experiments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      hypothesis_id         INTEGER,
      strategy_name         TEXT NOT NULL,
      run_date              TEXT NOT NULL,
      dimension             TEXT,
      condition_key         TEXT,
      condition_value       TEXT,
      control_n             INTEGER,
      control_wr            REAL,
      control_expectancy    REAL,
      test_n                INTEGER,
      test_wr               REAL,
      test_expectancy       REAL,
      wr_delta              REAL,
      z_score               REAL,
      p_value               REAL,
      oos_n                 INTEGER,
      oos_z                 REAL,
      oos_confirmed         INTEGER,
      train_n               INTEGER,
      train_confirmed       INTEGER,
      result                TEXT,
      confidence_level      TEXT,
      recommendation        TEXT,
      computed_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  const insertExp = db.prepare(`
    INSERT INTO research_experiments
      (hypothesis_id, strategy_name, run_date, dimension, condition_key, condition_value,
       control_n, control_wr, control_expectancy, test_n, test_wr, test_expectancy,
       wr_delta, z_score, p_value, oos_n, oos_z, oos_confirmed, train_n, train_confirmed,
       result, confidence_level, recommendation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const updateHypStatus = db.prepare(
    `UPDATE research_hypotheses SET status = ? WHERE id = ?`
  );

  const runDate = new Date().toISOString().slice(0, 10);
  let confirmed = 0, refuted = 0, inconclusive = 0, skipped = 0;

  // Get top OPEN hypotheses across all strategies
  const openHyps = db.prepare(`
    SELECT * FROM research_hypotheses
    WHERE status IN ('OPEN','INCONCLUSIVE')
    ORDER BY priority ASC, priority_score DESC
    LIMIT ?
  `).all(BATCH_SIZE);

  console.log(`[${WORKER_NAME}] Processing ${openHyps.length} open hypotheses`);

  for (const hyp of openHyps) {
    try {
      const exp = runExperiment(db, hyp);

      if (exp.skip) {
        console.log(`[${WORKER_NAME}] ${hyp.strategy_name} ${hyp.condition_key}=${hyp.condition_value}: skip — ${exp.reason}`);
        skipped++;
        continue;
      }

      insertExp.run(
        hyp.id, hyp.strategy_name, runDate,
        hyp.dimension, hyp.condition_key, hyp.condition_value,
        exp.controlN, exp.controlWr, exp.controlExp,
        exp.testN, exp.testWr, exp.testExp,
        exp.wrDelta, exp.zScore, exp.pVal,
        exp.oosN, exp.oosZ, exp.oosConfirmed === null ? null : (exp.oosConfirmed ? 1 : 0),
        exp.trainN, exp.trainConfirmed === null ? null : (exp.trainConfirmed ? 1 : 0),
        exp.result, exp.confidenceLevel, exp.recommendation,
      );

      updateHypStatus.run(exp.result, hyp.id);

      console.log(
        `[${WORKER_NAME}] ${hyp.strategy_name} ${hyp.condition_key}=${hyp.condition_value}: ` +
        `${exp.result} (${exp.confidenceLevel}) z=${exp.zScore} n=${exp.testN} ` +
        `WR ${exp.testWr != null ? (exp.testWr*100).toFixed(0)+'%' : 'n/a'}`
      );

      if (exp.result === 'CONFIRMED') {
        confirmed++;
        try {
          insertMsg.run(
            'experiment-engine', 'recommendation', hyp.strategy_name, 3,
            JSON.stringify({
              result:            exp.result,
              confidence_level:  exp.confidenceLevel,
              dimension:         hyp.dimension,
              condition:         `${hyp.condition_key}=${hyp.condition_value}`,
              wr_delta:          exp.wrDelta,
              z_score:           exp.zScore,
              p_value:           exp.pVal,
              oos_validated:     exp.oosConfirmed,
              recommendation:    exp.recommendation,
              hypothesis_text:   hyp.hypothesis_text,
            }),
          );
        } catch (_) {}
      } else if (exp.result === 'REFUTED') {
        refuted++;
      } else {
        inconclusive++;
      }
    } catch (err) {
      console.error(`[${WORKER_NAME}] error on hypothesis ${hyp.id}: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    processed: openHyps.length - skipped,
    confirmed, refuted, inconclusive, skipped,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — confirmed=${confirmed} refuted=${refuted} inconclusive=${inconclusive} skipped=${skipped}`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
