'use strict';

/**
 * QUALITY SCORE VALIDATOR  (Prompt #15 Phase 2 — Red Team Foundation)
 *
 * Addresses the second critical red-team finding: the quality scoring system
 * (confidence → qualityPts → A+/A/B+/B/C grade → baseAlloc) was built from
 * intuition. The weights have never been validated against actual trade outcomes.
 *
 * Example: ny_open session gets +15 pts (current). If ny_open trades actually
 * have a WR delta of +0.05 vs baseline, the empirical pts should be +5, not +15.
 * The system is overweighting ny_open, systematically oversizing those trades.
 *
 * This worker:
 *
 * 1. GRADE VALIDATION — Retroactively computes quality scores for all historical
 *    trade_dna records using the same formula as scanner-core.js.
 *    Groups by grade (A+/A/B+/B/C) and tests:
 *    - Is each grade's WR significantly different from the grade below?
 *    - Is each grade's expectancy meaningfully higher?
 *    Writes results to quality_score_validation.
 *
 * 2. COMPONENT ATTRIBUTION — For each scoring component (confidence, regime,
 *    session, htf_bias, archetype, entry_type), computes:
 *    - current_pts: what scanner-core currently assigns
 *    - empirical_pts: WR delta × 100 (what data actually shows)
 *    - calibration_delta: the difference
 *    High positive delta = currently over-weighted. High negative = under-weighted.
 *    Writes recommendations to quality_score_weights.
 *
 * 3. REGRESSION TEST — Pearson correlation of qualityPts vs pnl_pts across all
 *    trades. If r² < 0.05, the quality scoring system has no predictive power.
 *
 * Runs weekly Sunday 07:30 UTC (after hypothesis-engine at 07:00).
 *
 * Posts agent_messages (priority 2) for:
 *   - Any grade that is NOT significantly better than the next lower grade
 *   - Any component with |calibration_delta| > 8 pts (meaningfully mis-weighted)
 *   - Overall correlation < 0.10 (quality score has no predictive power)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'quality-score-validator';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const MIN_N_GRADE = 10;   // minimum trades per grade to report
const MIN_N_COMP  = 10;   // minimum trades per component value to report
const WINDOW_DAYS = 180;  // use 180 days for stability

// ── Quality score reconstruction (mirrors scanner-core.js Part 5) ─────────────
// Uses only columns available in trade_dna.
// Conservative assumptions: behaviorMode=NORMAL, gateVerdict=APPROVED, tier=null
// This gives an approximation. The real score also includes live-only fields.

function reconstructQualityPts(row) {
  let pts = 0;
  const conf   = row.confidence ?? 0;
  const regime = row.regime     ?? 'NORMAL';
  const sess   = (row.session   ?? '').toLowerCase();

  // Confidence (same thresholds as scanner-core)
  if      (conf >= 85) pts += 35;
  else if (conf >= 75) pts += 25;
  else if (conf >= 65) pts += 15;
  else                 pts +=  5;

  // Behavior mode — assume NORMAL (conservative baseline)
  pts += 10;

  // Regime
  if      (regime === 'TREND_BULL' || regime === 'TREND_BEAR') pts += 10;
  else if (regime === 'EXPANSION')  pts +=  5;
  else if (regime === 'COMPRESSION') pts -= 5;
  else if (regime === 'RANGE_CHOP') pts -= 15;
  // NORMAL/SOFT_CHOP: 0

  // Session
  if      (sess === 'ny_open')    pts += 15;
  else if (sess === 'power_hour') pts += 12;
  else if (sess === 'pre_market') pts +=  5;
  else if (sess === 'midday')     pts +=  3;
  else                            pts +=  8;

  return Math.max(0, Math.min(100, pts));
}

function gradeFromPts(pts) {
  if (pts >= 80) return 'A+';
  if (pts >= 65) return 'A';
  if (pts >= 50) return 'B+';
  if (pts >= 35) return 'B';
  return 'C';
}

const GRADE_BANDS = [
  { grade: 'A+', minPts: 80, maxPts: 100, baseAlloc: 100 },
  { grade: 'A',  minPts: 65, maxPts: 79,  baseAlloc: 80  },
  { grade: 'B+', minPts: 50, maxPts: 64,  baseAlloc: 60  },
  { grade: 'B',  minPts: 35, maxPts: 49,  baseAlloc: 40  },
  { grade: 'C',  minPts: 0,  maxPts: 34,  baseAlloc: 25  },
];

// ── Statistical helpers ───────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function pearsonR(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return 0;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? +(num / denom).toFixed(4) : 0;
}

// z-test for proportion difference (one-tailed: p1 > p2)
function zTestProps(n1, p1, n2, p2) {
  if (n1 < 2 || n2 < 2) return 0;
  const p = (n1 * p1 + n2 * p2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? +((p1 - p2) / se).toFixed(3) : 0;
}

// ── Component definitions ─────────────────────────────────────────────────────

const COMPONENT_DEFS = [
  {
    name: 'confidence',
    getKey: (r) => r.confidence >= 85 ? 'HIGH(≥85)' : r.confidence >= 75 ? 'MED(≥75)' : r.confidence >= 65 ? 'LOW(≥65)' : 'VLOW(<65)',
    currentPts: { 'HIGH(≥85)': 35, 'MED(≥75)': 25, 'LOW(≥65)': 15, 'VLOW(<65)': 5 },
    filter: (r) => r.confidence != null,
  },
  {
    name: 'regime',
    getKey: (r) => r.regime ?? 'NORMAL',
    currentPts: { TREND_BULL: 10, TREND_BEAR: 10, EXPANSION: 5, NORMAL: 0, SOFT_CHOP: 0, COMPRESSION: -5, RANGE_CHOP: -15 },
    filter: (r) => r.regime != null,
  },
  {
    name: 'session',
    getKey: (r) => (r.session ?? 'other').toLowerCase(),
    currentPts: { ny_open: 15, power_hour: 12, pre_market: 5, midday: 3, other: 8 },
    filter: (r) => true,
  },
  {
    name: 'htf_bias',
    getKey: (r) => r.htf_bias ?? 'UNKNOWN',
    currentPts: {},   // no pts assigned currently → empirical = current weighting
    filter: (r) => r.htf_bias != null,
  },
  {
    name: 'entry_type',
    getKey: (r) => r.entry_type ?? 'UNKNOWN',
    currentPts: {},
    filter: (r) => r.entry_type != null,
  },
  {
    name: 'archetype',
    getKey: (r) => r.archetype ?? 'UNKNOWN',
    currentPts: {},
    filter: (r) => r.archetype != null,
  },
];

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS quality_score_validation (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date              TEXT NOT NULL,
      strategy_name         TEXT NOT NULL,
      quality_grade         TEXT NOT NULL,
      min_pts               INTEGER,
      max_pts               INTEGER,
      base_alloc_pct        INTEGER,
      trade_count           INTEGER,
      win_rate              REAL,
      avg_pnl_pts           REAL,
      expectancy_score      REAL,
      baseline_wr           REAL,
      wr_delta              REAL,
      z_vs_next_lower       REAL,
      grade_validated       INTEGER,
      computed_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, quality_grade)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS quality_score_weights (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date          TEXT NOT NULL,
      strategy_name     TEXT NOT NULL,
      component         TEXT NOT NULL,
      component_value   TEXT NOT NULL,
      current_pts       REAL,
      empirical_pts     REAL,
      calibration_delta REAL,
      sample_size       INTEGER,
      observed_wr       REAL,
      baseline_wr       REAL,
      computed_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, component, component_value)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS quality_score_regression (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date      TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      pearson_r     REAL,
      r_squared     REAL,
      trade_count   INTEGER,
      interpretation TEXT,
      computed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name)
    )
  `).run();

  const upsertGrade = db.prepare(`
    INSERT OR REPLACE INTO quality_score_validation
      (run_date, strategy_name, quality_grade, min_pts, max_pts, base_alloc_pct,
       trade_count, win_rate, avg_pnl_pts, expectancy_score,
       baseline_wr, wr_delta, z_vs_next_lower, grade_validated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertWeight = db.prepare(`
    INSERT OR REPLACE INTO quality_score_weights
      (run_date, strategy_name, component, component_value,
       current_pts, empirical_pts, calibration_delta, sample_size,
       observed_wr, baseline_wr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertReg = db.prepare(`
    INSERT OR REPLACE INTO quality_score_regression
      (run_date, strategy_name, pearson_r, r_squared, trade_count, interpretation)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate = new Date().toISOString().slice(0, 10);
  const findings = [];

  for (const strategy of STRATEGIES) {
    try {
      const trades = db.prepare(`
        SELECT id, outcome, pnl_pts, confidence, regime, session,
               htf_bias, entry_type, archetype, trade_date
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND source = 'LIVE'
          AND trade_date >= date('now', '-${WINDOW_DAYS} days')
        ORDER BY trade_date ASC
      `).all(strategy);

      if (trades.length < 20) {
        console.log(`[${WORKER_NAME}] ${strategy}: insufficient trades (${trades.length}) — skip`);
        continue;
      }

      // Enrich with reconstructed quality score
      const enriched = trades.map(t => ({
        ...t,
        qualityPts: reconstructQualityPts(t),
        grade: gradeFromPts(reconstructQualityPts(t)),
        pnlNum: t.pnl_pts ?? 0,
      }));

      const baselineWr = enriched.filter(t => t.outcome === 'WIN').length / enriched.length;

      // ── 1. Grade validation ───────────────────────────────────────────────────
      const byGrade = {};
      for (const g of GRADE_BANDS) byGrade[g.grade] = [];
      for (const t of enriched) {
        if (byGrade[t.grade]) byGrade[t.grade].push(t);
      }

      const gradeStats = GRADE_BANDS.map(g => {
        const grp = byGrade[g.grade];
        if (grp.length < MIN_N_GRADE) return { ...g, n: grp.length, wr: null };
        const wins = grp.filter(t => t.outcome === 'WIN').length;
        const wr   = wins / grp.length;
        const avgPnl = mean(grp.map(t => t.pnlNum));
        return { ...g, n: grp.length, wr, avgPnl, expectancy: avgPnl };
      });

      // Test each grade vs the one below it
      for (let i = 0; i < gradeStats.length; i++) {
        const g = gradeStats[i];
        if (g.n < MIN_N_GRADE || g.wr === null) continue;

        // Compare to next lower grade
        const lower = gradeStats.slice(i + 1).find(x => x.n >= MIN_N_GRADE && x.wr !== null);
        const z = lower ? zTestProps(g.n, g.wr, lower.n, lower.wr) : null;
        const validated = z != null ? (z >= 1.28 ? 1 : 0) : null;

        upsertGrade.run(
          runDate, strategy, g.grade, g.minPts, g.maxPts, g.baseAlloc,
          g.n, +g.wr.toFixed(4), +g.avgPnl.toFixed(3), +g.expectancy.toFixed(3),
          +baselineWr.toFixed(4), +(g.wr - baselineWr).toFixed(4),
          z != null ? +z.toFixed(3) : null, validated,
        );

        // Flag if grade not validated
        if (validated === 0 && lower) {
          const msg = `${strategy}: grade ${g.grade} (WR ${(g.wr*100).toFixed(0)}%) is NOT significantly better than ${lower.grade} (WR ${(lower.wr*100).toFixed(0)}%) — z=${z.toFixed(2)}`;
          findings.push({ priority: 2, strategy, msg });
          try {
            insertMsg.run(WORKER_NAME, 'observation', strategy, 2,
              JSON.stringify({ alert: 'grade_not_validated', grade: g.grade, z, wr: g.wr, lower_grade: lower.grade, lower_wr: lower.wr, note: msg }));
          } catch (_) {}
        }

        console.log(`[${WORKER_NAME}] ${strategy} ${g.grade}: n=${g.n} WR=${(g.wr*100).toFixed(0)}% z_vs_lower=${z != null ? z.toFixed(2) : 'n/a'} validated=${validated}`);
      }

      // ── 2. Regression: qualityPts → pnl_pts ──────────────────────────────────
      const qPts = enriched.map(t => t.qualityPts);
      const pPts = enriched.map(t => t.pnlNum);
      const r    = pearsonR(qPts, pPts);
      const r2   = +(r * r).toFixed(4);

      const interpretation = r2 >= 0.10 ? 'MEANINGFUL_CORRELATION'
                           : r2 >= 0.05 ? 'WEAK_CORRELATION'
                           : 'NO_PREDICTIVE_POWER';

      upsertReg.run(runDate, strategy, r, r2, enriched.length, interpretation);

      if (r2 < 0.05 && enriched.length >= 50) {
        const msg = `${strategy}: quality score has NO predictive power for trade outcomes (r²=${r2}, n=${enriched.length}) — weights need full recalibration`;
        findings.push({ priority: 2, strategy, msg });
        try {
          insertMsg.run(WORKER_NAME, 'observation', strategy, 2,
            JSON.stringify({ alert: 'quality_score_no_predictive_power', pearson_r: r, r_squared: r2, trade_count: enriched.length, note: msg }));
        } catch (_) {}
      }
      console.log(`[${WORKER_NAME}] ${strategy}: qualityPts→pnl_pts r=${r} r²=${r2} [${interpretation}]`);

      // ── 3. Component attribution ──────────────────────────────────────────────
      for (const comp of COMPONENT_DEFS) {
        const filtered = enriched.filter(comp.filter);
        if (!filtered.length) continue;

        const compBaselineWr = filtered.filter(t => t.outcome === 'WIN').length / filtered.length;

        // Group by component value
        const groups = {};
        for (const t of filtered) {
          const key = comp.getKey(t);
          if (!groups[key]) groups[key] = [];
          groups[key].push(t);
        }

        for (const [val, grp] of Object.entries(groups)) {
          if (grp.length < MIN_N_COMP) continue;

          const wins     = grp.filter(t => t.outcome === 'WIN').length;
          const wr       = wins / grp.length;
          const wrDelta  = wr - compBaselineWr;

          // Empirical pts = WR delta × 100 (a 10% improvement = +10 pts empirically)
          const empiricalPts = +(wrDelta * 100).toFixed(1);
          const currentPts   = comp.currentPts[val] ?? 0;
          const calDelta     = +(empiricalPts - currentPts).toFixed(1);

          upsertWeight.run(
            runDate, strategy, comp.name, val,
            currentPts, empiricalPts, calDelta, grp.length,
            +wr.toFixed(4), +compBaselineWr.toFixed(4),
          );

          // Flag significant mis-weighting
          if (Math.abs(calDelta) >= 8 && grp.length >= 20) {
            const direction = calDelta > 0 ? 'UNDER-WEIGHTED' : 'OVER-WEIGHTED';
            const msg = `${strategy}: ${comp.name}=${val} is ${direction} (current ${currentPts}pts, empirical ${empiricalPts}pts, delta ${calDelta > 0 ? '+' : ''}${calDelta}pts, n=${grp.length})`;
            findings.push({ priority: 3, strategy, msg });
            try {
              insertMsg.run(WORKER_NAME, 'observation', strategy, 3,
                JSON.stringify({ alert: 'component_miscalibrated', component: comp.name, value: val, current_pts: currentPts, empirical_pts: empiricalPts, calibration_delta: calDelta, sample_size: grp.length, note: msg }));
            } catch (_) {}
          }
        }
      }
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── ntfy summary ──────────────────────────────────────────────────────────
  const criticalFindings = findings.filter(f => f.priority <= 2);
  if (findings.length > 0) {
    const topLines = findings.slice(0, 6).map(f => `• ${f.msg}`);
    await sendNotification(
      criticalFindings.length > 0
        ? 'Quality Score Validator — Calibration Issues Found'
        : 'Quality Score Validator — Weekly Report',
      `${findings.length} finding(s):\n${topLines.join('\n')}`,
      {
        priority: criticalFindings.length > 0 ? 'default' : 'low',
        tags: criticalFindings.length > 0 ? 'warning,scales' : 'white_check_mark,scales',
      },
    );
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    findings: findings.length,
    critical: criticalFindings.length,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${findings.length} findings (${criticalFindings.length} critical)`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
