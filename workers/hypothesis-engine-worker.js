'use strict';

/**
 * HYPOTHESIS ENGINE WORKER  (Prompt #12 — Phase 2; Phase 15-P7 FDR correction)
 *
 * Runs weekly (Sunday 07:00 UTC). Scans trade_dna to auto-generate testable
 * hypotheses about what dimensions drive above/below-baseline win rates.
 *
 * Methodology (Phase 14 — Overfitting Protection):
 *   • Minimum n = 15 per condition (1D), n = 20 (2D combinations)
 *   • z-test for proportions vs baseline WR (one-tailed)
 *   • |z| ≥ 1.28 required (p < 0.10) to generate hypothesis
 *   • Uses ALL historical data — avoids period-fitting
 *   • Flags n < 30 as "exploratory" in notes
 *
 * Phase 15-P7 — Benjamini-Hochberg FDR correction:
 *   • All hypotheses across all strategies collected before persisting
 *   • BH procedure at q = 0.10 applied globally (m = total hypotheses)
 *   • Hypotheses failing BH stored with status = INCONCLUSIVE
 *   • fdr_adjusted_p column added to research_hypotheses (via ALTER TABLE)
 *
 * Dimensions tested (1D):
 *   session, regime, entry_type, archetype, htf_bias, hour_et, confidence_tier
 *
 * Combinations tested (2D):
 *   session × regime, entry_type × regime, archetype × session, htf_bias × regime
 *
 * Priority score: |wr_delta| × sqrt(n) × (weekly_freq / 5)
 * Higher = bigger impact on bottom line.
 *
 * Writes to research_hypotheses (INSERT OR REPLACE — refreshes with latest data).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME  = 'hypothesis-engine';
const STRATEGIES   = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const MIN_N_1D     = 15;
const MIN_N_2D     = 20;
const Z_THRESHOLD  = 1.28;  // p < 0.10 one-tailed
const BH_Q        = 0.10;  // Benjamini-Hochberg FDR level

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
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function pValue(z) { return 1 - normCdf(Math.abs(z)); }

// ── Benjamini-Hochberg FDR correction ─────────────────────────────────────────
// Returns { fdrAdjustedP, passesFdr } for each element (mutates input array).
// Assumes arr elements have { pVal } field; adds { fdrAdjustedP, passesFdr }.
function applyBenjaminiHochberg(hypotheses) {
  const m = hypotheses.length;
  if (!m) return;

  // Sort by p-value ascending, track original index
  const indexed = hypotheses.map((h, i) => ({ h, i, p: h.pVal }));
  indexed.sort((a, b) => a.p - b.p);

  // Find the largest k where p(k) ≤ (k/m) × q
  let kMax = -1;
  for (let k = 0; k < m; k++) {
    if (indexed[k].p <= ((k + 1) / m) * BH_Q) kMax = k;
  }

  // BH adjusted p = min over j ≥ i of (p_j × m / j)  [step-up formula]
  // Traverse from largest p downward
  let runMin = 1;
  for (let k = m - 1; k >= 0; k--) {
    const adjusted = Math.min(1, indexed[k].p * m / (k + 1));
    runMin = Math.min(runMin, adjusted);
    indexed[k].fdrAdjustedP = +runMin.toFixed(4);
    indexed[k].passesFdr    = k <= kMax;
  }

  // Write back to original hypotheses array
  for (const { h, fdrAdjustedP, passesFdr } of indexed) {
    h.fdrAdjustedP = fdrAdjustedP;
    h.passesFdr    = passesFdr;
  }
}

// ── Hypothesis text builder ───────────────────────────────────────────────────

function buildText(strategy, dim, value, obsWr, baseWr, n) {
  const dir  = obsWr > baseWr ? 'outperforms' : 'underperforms';
  const diff = Math.abs((obsWr - baseWr) * 100).toFixed(0);
  const obs  = (obsWr * 100).toFixed(0);
  const base = (baseWr * 100).toFixed(0);
  const labels = {
    session:         `${value} session`,
    regime:          `${value} regime`,
    entry_type:      `${value} entry type`,
    archetype:       `${value} archetype`,
    htf_bias:        `${value} HTF bias`,
    hour_et:         `hour ${value} ET`,
    confidence_tier: `${value} confidence tier`,
  };
  const label = labels[dim] ?? `${dim}=${value}`;
  return `${strategy}: ${label} ${dir} baseline by ${diff}pp (${obs}% vs ${base}%, n=${n})`;
}

// ── Scan one dimension ────────────────────────────────────────────────────────

function scanDimension(db, strategy, dimension, colExpr, baselineWr, minN, weeklyFreqFn) {
  const rows = db.prepare(`
    SELECT ${colExpr} AS dim_val,
           COUNT(*) AS n,
           SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND ${colExpr} IS NOT NULL AND ${colExpr} != ''
    GROUP BY dim_val
    HAVING n >= ${minN}
  `).all(strategy);

  const results = [];
  for (const r of rows) {
    const obsWr  = r.wins / r.n;
    const z      = zTestProp(obsWr, baselineWr, r.n);
    if (Math.abs(z) < Z_THRESHOLD) continue;

    const weeklyFreq  = weeklyFreqFn ? weeklyFreqFn(r.n) : r.n / 52;
    const priorityScore = Math.abs(obsWr - baselineWr) * Math.sqrt(r.n) * Math.min(2, weeklyFreq / 5);

    results.push({
      dimension,
      conditionKey:   dimension,
      conditionValue: String(r.dim_val),
      sampleSize:     r.n,
      observedWr:     +obsWr.toFixed(4),
      baselineWr:     +baselineWr.toFixed(4),
      wrDelta:        +(obsWr - baselineWr).toFixed(4),
      zScore:         +z.toFixed(3),
      pVal:           +pValue(z).toFixed(4),
      priorityScore:  +priorityScore.toFixed(3),
      text:           buildText(strategy, dimension, r.dim_val, obsWr, baselineWr, r.n),
      notes:          r.n < 30 ? 'exploratory_small_sample' : null,
    });
  }
  return results;
}

// ── Scan a 2D combination ─────────────────────────────────────────────────────

function scan2D(db, strategy, dimA, colA, dimB, colB, baselineWr) {
  const rows = db.prepare(`
    SELECT ${colA} AS val_a, ${colB} AS val_b,
           COUNT(*) AS n,
           SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND ${colA} IS NOT NULL AND ${colA} != ''
      AND ${colB} IS NOT NULL AND ${colB} != ''
    GROUP BY val_a, val_b
    HAVING n >= ${MIN_N_2D}
  `).all(strategy);

  const results = [];
  for (const r of rows) {
    const obsWr = r.wins / r.n;
    const z     = zTestProp(obsWr, baselineWr, r.n);
    if (Math.abs(z) < Z_THRESHOLD) continue;

    const priorityScore = Math.abs(obsWr - baselineWr) * Math.sqrt(r.n) * 0.8; // 2D gets 0.8× weight
    const condKey  = `${dimA}×${dimB}`;
    const condVal  = `${r.val_a}|${r.val_b}`;
    const text     = `${strategy}: ${dimA}=${r.val_a} + ${dimB}=${r.val_b} → WR ${(obsWr*100).toFixed(0)}% vs ${(baselineWr*100).toFixed(0)}% baseline (delta ${((obsWr-baselineWr)*100).toFixed(0)}pp, n=${r.n})`;

    results.push({
      dimension:      condKey,
      conditionKey:   condKey,
      conditionValue: condVal,
      sampleSize:     r.n,
      observedWr:     +obsWr.toFixed(4),
      baselineWr:     +baselineWr.toFixed(4),
      wrDelta:        +(obsWr - baselineWr).toFixed(4),
      zScore:         +z.toFixed(3),
      pVal:           +pValue(z).toFixed(4),
      priorityScore:  +priorityScore.toFixed(3),
      text,
      notes:          r.n < 30 ? 'exploratory_small_sample' : null,
    });
  }
  return results;
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS research_hypotheses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      strategy_name   TEXT NOT NULL,
      hypothesis_text TEXT NOT NULL,
      dimension       TEXT NOT NULL,
      condition_key   TEXT NOT NULL,
      condition_value TEXT,
      sample_size     INTEGER,
      observed_wr     REAL,
      baseline_wr     REAL,
      wr_delta        REAL,
      z_score         REAL,
      p_value         REAL,
      priority_score  REAL,
      priority        INTEGER DEFAULT 5,
      status          TEXT NOT NULL DEFAULT 'OPEN',
      notes           TEXT,
      UNIQUE(strategy_name, condition_key, condition_value)
    )
  `).run();

  // Phase 15-P7: Add fdr_adjusted_p column if not yet present
  try { db.exec(`ALTER TABLE research_hypotheses ADD COLUMN fdr_adjusted_p REAL`); } catch (_) {}

  const upsertHypothesis = db.prepare(`
    INSERT INTO research_hypotheses
      (strategy_name, hypothesis_text, dimension, condition_key, condition_value,
       sample_size, observed_wr, baseline_wr, wr_delta, z_score, p_value,
       fdr_adjusted_p, priority_score, priority, status, notes, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(strategy_name, condition_key, condition_value) DO UPDATE SET
      hypothesis_text = excluded.hypothesis_text,
      sample_size     = excluded.sample_size,
      observed_wr     = excluded.observed_wr,
      wr_delta        = excluded.wr_delta,
      z_score         = excluded.z_score,
      p_value         = excluded.p_value,
      fdr_adjusted_p  = excluded.fdr_adjusted_p,
      priority_score  = excluded.priority_score,
      priority        = excluded.priority,
      notes           = excluded.notes,
      generated_at    = excluded.generated_at,
      -- Only reset status to OPEN if new data significantly changes the picture
      status = CASE
        WHEN excluded.status = 'INCONCLUSIVE' THEN 'INCONCLUSIVE'
        WHEN excluded.wr_delta * research_hypotheses.wr_delta < 0 THEN 'OPEN'
        WHEN research_hypotheses.status = 'REFUTED' AND ABS(excluded.wr_delta) > 0.15 THEN 'OPEN'
        ELSE research_hypotheses.status
      END
  `);

  let totalGenerated = 0;
  // Collect ALL hypotheses across all strategies before persisting — needed for global BH FDR
  const allHypotheses = [];

  for (const strategy of STRATEGIES) {
    try {
      // Baseline: all-time WR for this strategy
      const base = db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      `).get(strategy);

      if ((base?.n ?? 0) < MIN_N_1D) {
        console.log(`[${WORKER_NAME}] ${strategy}: insufficient data (${base?.n ?? 0} trades) — skip`);
        continue;
      }

      const baselineWr = base.wins / base.n;
      const weeklyFreq = base.n / 52;

      const hypotheses = [];

      // ── 1D dimensions ──────────────────────────────────────────────────────
      hypotheses.push(...scanDimension(db, strategy, 'session',     'session',     baselineWr, MIN_N_1D, () => weeklyFreq));
      hypotheses.push(...scanDimension(db, strategy, 'regime',      'regime',      baselineWr, MIN_N_1D, () => weeklyFreq));
      hypotheses.push(...scanDimension(db, strategy, 'entry_type',  'entry_type',  baselineWr, MIN_N_1D, () => weeklyFreq));
      hypotheses.push(...scanDimension(db, strategy, 'archetype',   'archetype',   baselineWr, MIN_N_1D, () => weeklyFreq));
      hypotheses.push(...scanDimension(db, strategy, 'htf_bias',    'htf_bias',    baselineWr, MIN_N_1D, () => weeklyFreq));
      hypotheses.push(...scanDimension(db, strategy, 'hour_et',     'hour_et',     baselineWr, MIN_N_1D, () => weeklyFreq));

      // Confidence tier: bucket confidence into LOW(<65)/MED(65-79)/HIGH(80+)
      hypotheses.push(...scanDimension(db, strategy, 'confidence_tier',
        "CASE WHEN confidence >= 80 THEN 'HIGH' WHEN confidence >= 65 THEN 'MED' ELSE 'LOW' END",
        baselineWr, MIN_N_1D, () => weeklyFreq));

      // ── 2D combinations ────────────────────────────────────────────────────
      hypotheses.push(...scan2D(db, strategy, 'session',    'session',    'regime',    'regime',     baselineWr));
      hypotheses.push(...scan2D(db, strategy, 'entry_type', 'entry_type', 'regime',    'regime',     baselineWr));
      hypotheses.push(...scan2D(db, strategy, 'archetype',  'archetype',  'session',   'session',    baselineWr));
      hypotheses.push(...scan2D(db, strategy, 'htf_bias',   'htf_bias',   'regime',    'regime',     baselineWr));

      // Tag each hypothesis with its strategy and baseline WR for later ranking
      for (const h of hypotheses) {
        h.strategy   = strategy;
        h.baselineWr = h.baselineWr ?? baselineWr;
      }

      console.log(
        `[${WORKER_NAME}] ${strategy}: ${hypotheses.length} raw hypotheses ` +
        `(baseline WR ${(baselineWr * 100).toFixed(0)}%, n=${base.n})`
      );

      allHypotheses.push(...hypotheses);
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── Apply Benjamini-Hochberg FDR correction globally ───────────────────────
  applyBenjaminiHochberg(allHypotheses);
  const fdrPassCount = allHypotheses.filter(h => h.passesFdr).length;
  console.log(
    `[${WORKER_NAME}] BH FDR @ q=${BH_Q}: ${fdrPassCount}/${allHypotheses.length} hypotheses pass FDR`
  );

  // ── Rank within each strategy and persist ──────────────────────────────────
  const byStrategy = {};
  for (const h of allHypotheses) {
    (byStrategy[h.strategy] ??= []).push(h);
  }

  for (const [strategy, hypotheses] of Object.entries(byStrategy)) {
    hypotheses.sort((a, b) => b.priorityScore - a.priorityScore);

    for (const h of hypotheses) {
      const rank     = hypotheses.indexOf(h);
      const pct      = rank / hypotheses.length;
      const priority = pct < 0.20 ? 1 : pct < 0.40 ? 2 : pct < 0.60 ? 3 : pct < 0.80 ? 4 : 5;
      const status   = h.passesFdr ? 'OPEN' : 'INCONCLUSIVE';

      upsertHypothesis.run(
        strategy, h.text, h.dimension, h.conditionKey, h.conditionValue,
        h.sampleSize, h.observedWr, h.baselineWr, h.wrDelta,
        h.zScore, h.pVal, h.fdrAdjustedP ?? null, h.priorityScore, priority, status, h.notes,
      );
      totalGenerated++;
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, totalGenerated,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${totalGenerated} hypotheses generated/updated`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
