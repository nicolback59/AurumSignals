'use strict';

/**
 * EDGE DISCOVERY WORKER  (Prompt #12 — Phase 6, 7, 8, 10, 11)
 *
 * Runs weekly (Saturday 07:00 UTC). Does a broader systematic grid search than
 * the hypothesis engine — looks for patterns the hypothesis engine doesn't cover.
 *
 * Grid dimensions tested:
 *   ATR percentile tier × regime
 *   Direction (LONG/SHORT) × session
 *   Direction × regime
 *   Confidence tier × session
 *   HTF bias alignment (aligned vs counter-trend)
 *   Hold time bucket (< 15m, 15-60m, 60-240m, 240m+)
 *   Exit type (TP1_HIT, STOP_OUT, MANUAL, EXPIRED)
 *   Hour × session
 *
 * Phase 7 — Loss Research: catalogues top loss conditions
 * Phase 8 — Win Research: catalogues top win amplifiers
 * Phase 10 — Frequency Research: analyses signal_rejections for overfiltering
 * Phase 11 — Expectancy Research: analyses hold time vs PnL efficiency
 *
 * Overfitting protection (Phase 14):
 *   n ≥ 20 per bucket
 *   z ≥ 1.65 (p < 0.05) for new discoveries
 *   Cohen's h ≥ 0.20 (small-medium effect size minimum)
 *   Flags < 30 samples as exploratory
 *
 * Writes to edge_discoveries (INSERT OR REPLACE).
 * Posts agent_messages for impact_score ≥ 2.0 (high-ROI discoveries).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME   = 'edge-discovery';
const STRATEGIES    = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const MIN_N         = 20;
const Z_DISCOVERY   = 1.65;   // p < 0.05 one-tailed
const MIN_COHENS_H  = 0.20;   // minimum effect size

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

// Cohen's h for two proportions
function cohensH(p1, p2) {
  return 2 * (Math.asin(Math.sqrt(Math.max(0, Math.min(1, p1)))) -
              Math.asin(Math.sqrt(Math.max(0, Math.min(1, p2)))));
}

// Impact score: how much this pattern moves the P&L needle
function impactScore(wrDelta, n, baselineWr, weeklyFreq) {
  const h      = Math.abs(cohensH(baselineWr + wrDelta, baselineWr));
  const relFreq = Math.min(2.0, weeklyFreq / 5);
  return Math.abs(wrDelta) * Math.sqrt(n) * h * relFreq;
}

// ── Generic 2D grid scan ──────────────────────────────────────────────────────

function scanGrid(db, strategy, dimA, exprA, dimB, exprB, baselineWr, baseN) {
  const weeklyFreq = baseN / 52;
  try {
    const rows = db.prepare(`
      SELECT ${exprA} AS val_a, ${exprB} AS val_b,
             COUNT(*) AS n,
             SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
             AVG(pnl_pts) AS exp,
             AVG(CASE WHEN outcome='WIN' THEN pnl_pts ELSE NULL END) AS avg_win,
             AVG(CASE WHEN outcome='LOSS' THEN ABS(pnl_pts) ELSE NULL END) AS avg_loss
      FROM trade_dna
      WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
        AND ${exprA} IS NOT NULL AND ${exprA} != ''
        AND ${exprB} IS NOT NULL AND ${exprB} != ''
      GROUP BY val_a, val_b
      HAVING n >= ${MIN_N}
    `).all(strategy);

    const discoveries = [];
    for (const r of rows) {
      const obsWr  = r.wins / r.n;
      const z      = zTestProp(obsWr, baselineWr, r.n);
      const h      = Math.abs(cohensH(obsWr, baselineWr));
      if (Math.abs(z) < Z_DISCOVERY || h < MIN_COHENS_H) continue;

      const wrDelta = obsWr - baselineWr;
      const impact  = impactScore(wrDelta, r.n, baselineWr, weeklyFreq);
      const expDelta = r.exp != null ? r.exp : null;

      discoveries.push({
        dimensionA:   dimA,
        valueA:       String(r.val_a),
        dimensionB:   dimB,
        valueB:       String(r.val_b),
        n:            r.n,
        observedWr:   +obsWr.toFixed(4),
        baselineWr:   +baselineWr.toFixed(4),
        wrDelta:      +wrDelta.toFixed(4),
        zScore:       +z.toFixed(3),
        cohensH:      +h.toFixed(3),
        expectancyDelta: expDelta != null ? +expDelta.toFixed(2) : null,
        impactScore:  +impact.toFixed(3),
        notes:        r.n < 30 ? 'exploratory' : null,
      });
    }
    return discoveries;
  } catch (_) { return []; }
}

// ── Phase 7: Loss Research ────────────────────────────────────────────────────

function lossResearch(db, strategy) {
  const output = [];

  // Top loss conditions by frequency and WR
  const conditions = db.prepare(`
    SELECT session, regime, entry_type, archetype,
           COUNT(*) AS n,
           SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) AS losses,
           AVG(pnl_pts) AS avg_pnl
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
    GROUP BY session, regime, entry_type, archetype
    HAVING n >= 10 AND (losses * 1.0 / n) > 0.55
    ORDER BY (losses * 1.0 / n) DESC
    LIMIT 10
  `).all(strategy);

  for (const c of conditions) {
    const lossRate = c.losses / c.n;
    output.push({
      type:    'LOSS_CLUSTER',
      dimA:    'session', valA: c.session,
      dimB:    'regime',  valB: c.regime,
      n: c.n, lossRate: +lossRate.toFixed(3),
      avgPnl: c.avg_pnl != null ? +c.avg_pnl.toFixed(2) : null,
      note: `${c.entry_type}/${c.archetype} — loss rate ${(lossRate*100).toFixed(0)}%`,
    });
  }
  return output;
}

// ── Phase 8: Win Research ─────────────────────────────────────────────────────

function winResearch(db, strategy) {
  // Best amplifier combinations: high WR + high expectancy
  return db.prepare(`
    SELECT session, regime, entry_type,
           COUNT(*) AS n,
           SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
           AVG(pnl_pts) AS avg_pnl,
           AVG(CASE WHEN outcome='WIN' THEN rr_achieved ELSE NULL END) AS avg_rr
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
    GROUP BY session, regime, entry_type
    HAVING n >= 10 AND (wins * 1.0 / n) > 0.60
    ORDER BY (wins * 1.0 / n) * AVG(pnl_pts) DESC
    LIMIT 10
  `).all(strategy).map(r => ({
    type:   'WIN_AMPLIFIER',
    dimA:   'session',    valA: r.session,
    dimB:   'regime',     valB: r.regime,
    entryType: r.entry_type,
    n:      r.n,
    winRate: +(r.wins / r.n).toFixed(3),
    avgPnl: r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
    avgRr:  r.avg_rr  != null ? +r.avg_rr.toFixed(2)  : null,
  }));
}

// ── Phase 10: Frequency / Overfiltering Research ──────────────────────────────

function frequencyResearch(db, strategy) {
  try {
    const rejRows = db.prepare(`
      SELECT reason,
             COUNT(*) AS n
      FROM signal_rejections
      WHERE strategy = ?
        AND rejected_at >= datetime('now', '-30 days')
      GROUP BY reason
      ORDER BY n DESC
      LIMIT 10
    `).all(strategy);
    return rejRows;
  } catch (_) { return []; }
}

// ── Phase 11: Expectancy / Hold Time Research ─────────────────────────────────

function expectancyResearch(db, strategy) {
  return db.prepare(`
    SELECT
      CASE
        WHEN hold_time_min < 15  THEN 'quick_<15m'
        WHEN hold_time_min < 60  THEN 'short_15-60m'
        WHEN hold_time_min < 240 THEN 'medium_60-240m'
        ELSE                          'long_240m+'
      END AS hold_bucket,
      COUNT(*) AS n,
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      AVG(pnl_pts) AS avg_pnl,
      AVG(CASE WHEN outcome='WIN' THEN rr_achieved ELSE NULL END) AS avg_rr
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND hold_time_min IS NOT NULL
    GROUP BY hold_bucket
    HAVING n >= 10
    ORDER BY AVG(pnl_pts) DESC
  `).all(strategy).map(r => ({
    type:       'HOLD_TIME_EFFICIENCY',
    bucket:     r.hold_bucket,
    n:          r.n,
    winRate:    +(r.wins / r.n).toFixed(3),
    avgPnl:     r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
    avgRr:      r.avg_rr  != null ? +r.avg_rr.toFixed(2)  : null,
  }));
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS edge_discoveries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      discovered_at    TEXT NOT NULL DEFAULT (datetime('now')),
      strategy_name    TEXT NOT NULL,
      discovery_type   TEXT NOT NULL DEFAULT 'GRID',
      dimension_a      TEXT,
      value_a          TEXT,
      dimension_b      TEXT,
      value_b          TEXT,
      sample_size      INTEGER,
      observed_wr      REAL,
      baseline_wr      REAL,
      wr_delta         REAL,
      z_score          REAL,
      cohens_h         REAL,
      expectancy_delta REAL,
      impact_score     REAL,
      status           TEXT NOT NULL DEFAULT 'NEW',
      notes            TEXT,
      UNIQUE(strategy_name, discovery_type, dimension_a, value_a, dimension_b, value_b)
    )
  `).run();

  db.prepare(`CREATE INDEX IF NOT EXISTS idx_ed_strategy ON edge_discoveries(strategy_name, discovered_at DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_ed_impact   ON edge_discoveries(impact_score DESC)`).run();

  const upsertDiscovery = db.prepare(`
    INSERT INTO edge_discoveries
      (strategy_name, discovery_type, dimension_a, value_a, dimension_b, value_b,
       sample_size, observed_wr, baseline_wr, wr_delta, z_score, cohens_h,
       expectancy_delta, impact_score, status, notes, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, datetime('now'))
    ON CONFLICT(strategy_name, discovery_type, dimension_a, value_a, dimension_b, value_b)
    DO UPDATE SET
      sample_size      = excluded.sample_size,
      observed_wr      = excluded.observed_wr,
      wr_delta         = excluded.wr_delta,
      z_score          = excluded.z_score,
      cohens_h         = excluded.cohens_h,
      impact_score     = excluded.impact_score,
      notes            = excluded.notes,
      discovered_at    = excluded.discovered_at,
      status = CASE
        WHEN edge_discoveries.status = 'REJECTED' THEN 'NEW'
        ELSE edge_discoveries.status
      END
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  let totalDiscoveries = 0;
  let highImpact       = 0;

  for (const strategy of STRATEGIES) {
    try {
      const base = db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
        FROM trade_dna WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      `).get(strategy);

      if ((base?.n ?? 0) < MIN_N) {
        console.log(`[${WORKER_NAME}] ${strategy}: insufficient data — skip`);
        continue;
      }

      const baselineWr = base.wins / base.n;
      const discoveries = [];

      // ── Grid scans ──────────────────────────────────────────────────────────
      // ATR tier × regime
      discoveries.push(...scanGrid(db, strategy,
        'atr_tier', "CASE WHEN atr IS NULL THEN NULL WHEN atr > (SELECT AVG(atr)*1.5 FROM trade_dna WHERE strategy_name=?) THEN 'HIGH' WHEN atr < (SELECT AVG(atr)*0.7 FROM trade_dna WHERE strategy_name=?) THEN 'LOW' ELSE 'MED' END",
        'regime',   'regime', baselineWr, base.n));

      // Direction × session
      discoveries.push(...scanGrid(db, strategy,
        'direction', "(SELECT direction FROM signals WHERE id = trade_dna.signal_id LIMIT 1)",
        'session',   'session', baselineWr, base.n));

      // Direction × regime
      discoveries.push(...scanGrid(db, strategy,
        'direction', "(SELECT direction FROM signals WHERE id = trade_dna.signal_id LIMIT 1)",
        'regime',    'regime', baselineWr, base.n));

      // Confidence tier × session
      discoveries.push(...scanGrid(db, strategy,
        'conf_tier', "CASE WHEN confidence >= 80 THEN 'HIGH' WHEN confidence >= 65 THEN 'MED' ELSE 'LOW' END",
        'session',   'session', baselineWr, base.n));

      // HTF bias × regime
      discoveries.push(...scanGrid(db, strategy,
        'htf_bias', 'htf_bias',
        'regime',   'regime', baselineWr, base.n));

      // Exit type × session (understanding how exits cluster)
      discoveries.push(...scanGrid(db, strategy,
        'exit_type', 'exit_type',
        'session',   'session', baselineWr, base.n));

      // Persist all GRID discoveries
      for (const d of discoveries) {
        upsertDiscovery.run(
          strategy, 'GRID',
          d.dimensionA, d.valueA, d.dimensionB, d.valueB,
          d.n, d.observedWr, d.baselineWr, d.wrDelta,
          d.zScore, d.cohensH, d.expectancyDelta, d.impactScore, d.notes,
        );
        totalDiscoveries++;

        // High-impact alert: impact_score ≥ 2.0 and |wr_delta| ≥ 0.12
        if (d.impactScore >= 2.0 && Math.abs(d.wrDelta) >= 0.12) {
          highImpact++;
          try {
            insertMsg.run(
              'edge-discovery', 'observation', strategy, 3,
              JSON.stringify({
                discovery_type: 'GRID',
                dimension_a:    d.dimensionA, value_a: d.valueA,
                dimension_b:    d.dimensionB, value_b: d.valueB,
                sample_size:    d.n,
                wr_delta:       d.wrDelta,
                z_score:        d.zScore,
                cohens_h:       d.cohensH,
                impact_score:   d.impactScore,
                note:           `High-impact edge: ${d.dimensionA}=${d.valueA} × ${d.dimensionB}=${d.valueB} → ${(d.wrDelta > 0 ? '+' : '')}${(d.wrDelta*100).toFixed(0)}pp WR`,
              }),
            );
          } catch (_) {}
        }
      }

      // ── Phase 7: Loss clusters ──────────────────────────────────────────────
      for (const lc of lossResearch(db, strategy)) {
        upsertDiscovery.run(
          strategy, 'LOSS_CLUSTER',
          lc.dimA, lc.valA, lc.dimB, lc.valB,
          lc.n, 1 - lc.lossRate, baselineWr, (1 - lc.lossRate) - baselineWr,
          null, null, lc.avgPnl, null, lc.note,
        );
      }

      // ── Phase 8: Win amplifiers ─────────────────────────────────────────────
      for (const wa of winResearch(db, strategy)) {
        upsertDiscovery.run(
          strategy, 'WIN_AMPLIFIER',
          wa.dimA, wa.valA, wa.dimB, wa.valB,
          wa.n, wa.winRate, baselineWr, wa.winRate - baselineWr,
          null, null, wa.avgPnl, null,
          wa.entryType ? `entry=${wa.entryType}` : null,
        );
      }

      // ── Phase 11: Hold time efficiency ─────────────────────────────────────
      for (const ht of expectancyResearch(db, strategy)) {
        upsertDiscovery.run(
          strategy, 'HOLD_TIME_EFFICIENCY',
          'hold_time', ht.bucket, 'win_rate', String(ht.winRate),
          ht.n, ht.winRate, baselineWr, ht.winRate - baselineWr,
          null, null, ht.avgPnl, null, null,
        );
      }

      // ── Phase 10: Frequency / rejection analysis ────────────────────────────
      const rejections = frequencyResearch(db, strategy);
      if (rejections.length > 0) {
        const topReason = rejections[0];
        upsertDiscovery.run(
          strategy, 'OVERFILTERING',
          'rejection_reason', topReason.reason, 'count_30d', String(topReason.n),
          topReason.n, null, null, null,
          null, null, null, null,
          `Top rejection: ${topReason.reason} (${topReason.n}× in 30d) — investigate if threshold can be relaxed`,
        );
      }

      console.log(
        `[${WORKER_NAME}] ${strategy}: ${discoveries.length} grid discoveries ` +
        `(baseline WR ${(baselineWr*100).toFixed(0)}%)`
      );
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, totalDiscoveries, highImpact,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${totalDiscoveries} discoveries, ${highImpact} high-impact`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
