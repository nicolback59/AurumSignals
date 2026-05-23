#!/usr/bin/env node
'use strict';

/**
 * Standalone backtest data miner.
 *
 * Usage:
 *   node scripts/mine-backtest-data.js             # report only (no changes)
 *   node scripts/mine-backtest-data.js --apply     # apply best config to live system
 *   node scripts/mine-backtest-data.js --json      # output raw JSON (for piping)
 *
 * The script reads the AurumSignals SQLite database directly.
 * DB path is resolved from DATABASE_URL env var or defaults to ./aurum.db / ./aurumsignals.db.
 */

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

// ── Locate DB ──────────────────────────────────────────────────────────────────
function findDb() {
  const envPath = process.env.DATABASE_URL?.replace('sqlite://', '');
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = [
    path.join(__dirname, '..', 'aurum.db'),
    path.join(__dirname, '..', 'aurumsignals.db'),
    path.join('/root/AurumSignals', 'aurum.db'),
    path.join('/root/AurumSignals', 'aurumsignals.db'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Cannot find SQLite DB. Set DATABASE_URL=sqlite://path/to/aurum.db or run from AurumSignals root.'
  );
}

const args  = process.argv.slice(2);
const APPLY  = args.includes('--apply');
const AS_JSON = args.includes('--json');

const dbPath = findDb();
if (!AS_JSON) console.log(`\n[miner] Opening DB: ${dbPath}`);
if (!AS_JSON && APPLY) console.log('[miner] --apply flag set: winning config will be applied to live system\n');
if (!AS_JSON && !APPLY) console.log('[miner] Dry run (report only). Pass --apply to promote winning config.\n');

const db = new Database(dbPath, { readonly: !APPLY });

const { mine } = require('../backtest-data-miner');
const report   = mine(db, { apply: APPLY });

if (AS_JSON) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  db.close();
  process.exit(0);
}

// ── Human-readable report ─────────────────────────────────────────────────────

const line = '─'.repeat(70);
const bold = s => `\x1b[1m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;

console.log(bold('\n╔══════════════════════════════════════════════════════════════════════╗'));
console.log(bold('║         AURUM SIGNALS — BACKTEST DATA MINING REPORT                 ║'));
console.log(bold('╚══════════════════════════════════════════════════════════════════════╝\n'));
console.log(`Generated: ${report.generated_at}   Elapsed: ${report.elapsed_ms}ms`);

console.log(`\n${bold('DATA SOURCES')}`);
console.log(line);
const ds = report.dataSources;
console.log(`Valid backtest runs analyzed:       ${ds.totalValidRuns}`);
console.log(`Zero-trade runs excluded:           ${ds.zeroTradeRunsExcluded}`);
console.log(`Total backtest trades analyzed:     ${ds.totalBacktestTrades}`);
console.log(`Optimization (genetic) runs:        ${ds.optimizerRunsAnalyzed}`);

for (const [name, strat] of Object.entries(report.strategies)) {
  console.log(`\n${bold(`━━ ${name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)}`);
  console.log(line);

  const d = strat.data;
  console.log(`Backtest trades:  ${d.totalBacktestTrades}   Valid runs: ${d.validRuns}   Optimizer runs: ${d.optimizerRuns}   Live trades: ${d.liveTrades}`);

  // Top setups
  if (strat.segments.bestSetups.length > 0) {
    console.log(`\n${bold('Best setup × regime combinations:')}`);
    for (const s of strat.segments.bestSetups.slice(0, 5)) {
      const wr   = (s.win_rate * 100).toFixed(1);
      const pf   = s.profit_factor ?? 'N/A';
      console.log(`  ${green('✓')} ${(s.setup ?? 'unknown').padEnd(25)} regime=${s.regime?.padEnd(12) ?? '?'} WR=${wr}%  PF=${pf}  n=${s.trades}  avgConf=${s.avg_confidence}`);
    }
  }

  // Worst combos
  if (strat.segments.worstSetups.length > 0) {
    console.log(`\n${bold('Worst conditions to avoid:')}`);
    for (const s of strat.segments.worstSetups.slice(0, 3)) {
      const wr = (s.win_rate * 100).toFixed(1);
      console.log(`  ${red('✗')} ${(s.setup ?? 'unknown').padEnd(25)} regime=${s.regime?.padEnd(12) ?? '?'} WR=${wr}%  n=${s.trades}`);
    }
  }

  // Confidence buckets
  const validBuckets = strat.segments.byConfidence.filter(b => b.trades > 0);
  if (validBuckets.length > 0) {
    console.log(`\n${bold('Confidence bucket analysis (backtest):')} `);
    for (const b of validBuckets) {
      const wr = b.win_rate != null ? `${(b.win_rate * 100).toFixed(1)}%` : 'N/A';
      const pf = b.profit_factor != null ? `${b.profit_factor}` : 'N/A';
      const marker = b.win_rate >= 0.65 ? green('★') : b.win_rate >= 0.55 ? '·' : red('·');
      console.log(`  ${marker} Conf ${b.label.padEnd(6)} WR=${wr.padEnd(7)} PF=${pf.padEnd(6)} avgPnl=${b.avg_pnl ?? 'N/A'}  n=${b.trades}`);
    }
  }

  // Top runs
  if (strat.topRuns.length > 0) {
    console.log(`\n${bold('Top recency-weighted backtest runs:')}`);
    for (const r of strat.topRuns.slice(0, 3)) {
      const wr = r.win_rate != null ? `${(r.win_rate * 100).toFixed(1)}%` : 'N/A';
      console.log(`  Run #${r.id} (${r.run_at})  WR=${wr}  PF=${r.profit_factor ?? 'N/A'}  Sharpe=${r.sharpe ?? 'N/A'}  DD=${r.max_drawdown ?? 'N/A'}  n=${r.trades_found}  recency=${r.recency}`);
    }
  }

  // Live performance
  const lp = strat.livePerformance;
  if ((lp.total ?? 0) > 0) {
    console.log(`\n${bold('Live signal performance:')}`);
    const wr = lp.win_rate != null ? `${(lp.win_rate * 100).toFixed(1)}%` : 'N/A';
    console.log(`  Total: ${lp.total}  Wins: ${lp.wins}  Losses: ${lp.losses}  WR=${wr}  PF=${lp.profit_factor ?? 'N/A'}  avgPnl=${lp.avg_pnl ?? 'N/A'}  avgConf=${lp.avg_confidence ?? 'N/A'}`);
    for (const s of (lp.bySession ?? []).slice(0, 4)) {
      const swr = s.win_rate != null ? `${(s.win_rate * 100).toFixed(1)}%` : 'N/A';
      console.log(`  Session: ${(s.session ?? 'unknown').padEnd(16)} WR=${swr}  n=${s.trades}  avgPnl=${s.avg_pnl}`);
    }
  } else {
    console.log('\n  Live performance: no resolved signals yet');
  }

  // Current vs optimized config
  console.log(`\n${bold('Current vs Optimized Config:')}`);
  const cc = strat.currentConfig;
  const oc = strat.optimizedConfig;
  const tDelta = (oc.liveThreshold ?? cc.liveThreshold) - cc.liveThreshold;
  const sDelta = (oc.slPts ?? cc.slPts) - cc.slPts;
  console.log(`  Live threshold: ${cc.liveThreshold} → ${oc.liveThreshold ?? cc.liveThreshold} (${tDelta >= 0 ? '+' : ''}${tDelta})  [${oc.liveThresholdNote ?? 'no change'}]`);
  console.log(`  slPts:          ${cc.slPts} → ${oc.slPts ?? cc.slPts} (${sDelta >= 0 ? '+' : ''}${sDelta})  [${oc.slPtsSource}]`);

  // Validation
  const v = strat.validation;
  if (v.valid) {
    console.log(`\n  ${green('✓ VALIDATION PASSED')} — config eligible for application`);
  } else {
    console.log(`\n  ${yellow('⚠ VALIDATION ISSUES')} — not applying:`);
    for (const issue of v.issues) {
      console.log(`    • ${issue}`);
    }
  }

  console.log(`\n  Expected benefit: ${strat.improvement.expectedBenefit}`);
}

// Applied results
if (report.applied) {
  console.log(`\n${bold('APPLIED CHANGES')}`);
  console.log(line);
  for (const [strat, result] of Object.entries(report.appliedResults ?? {})) {
    if (result.skipped) {
      console.log(`  ${yellow('SKIPPED')} ${strat}: ${result.reason?.join(', ')}`);
    } else {
      console.log(`  ${green('APPLIED')} ${strat}:`);
      for (const r of (result.results ?? [])) {
        if (r.type === 'threshold') {
          console.log(`    • Threshold ${r.key} → ${r.value} (${JSON.stringify(r.result)})`);
        } else if (r.type === 'style_params') {
          console.log(`    • Params ${r.key}: slPts ${r.oldSlPts}→${r.newSlPts}  minScore ${r.oldMinScore}→${r.newMinScore}`);
        } else if (r.type === 'revision_logged') {
          console.log(`    • strategy_revisions entry created for ${r.instrument}`);
        }
      }
    }
  }
} else {
  console.log(`\n${yellow('DRY RUN — no changes made.')} Pass --apply to promote the winning config.`);
}

// Rollback plan
console.log(`\n${bold('ROLLBACK PLAN')}`);
console.log(line);
console.log(report.summary.rollbackPlan);

// Risks
console.log(`\n${bold('REMAINING RISKS')}`);
for (const risk of report.summary.remainingRisks) {
  console.log(`  • ${risk}`);
}

console.log('\n');
db.close();
