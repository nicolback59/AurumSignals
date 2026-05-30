#!/usr/bin/env node
'use strict';

/**
 * MNQ FIRE Strategy Backtest Runner
 *
 * Loads historical bars from the AurumSignals SQLite DB and runs the full
 * backtestMnqFire() simulation, printing a comprehensive performance report
 * with tuning-specific breakdowns (pool type, entry type, checklist score,
 * volume spike, pool confluence).
 *
 * Usage:
 *   node scripts/mnq-fire-backtest.js                   # 90-day lookback, CORE variant
 *   node scripts/mnq-fire-backtest.js --days 180        # custom lookback
 *   node scripts/mnq-fire-backtest.js --variant CONSERVATIVE
 *   node scripts/mnq-fire-backtest.js --variant AGGRESSIVE
 *   node scripts/mnq-fire-backtest.js --json            # raw JSON output
 *   node scripts/mnq-fire-backtest.js --verbose         # per-day trade log
 *   node scripts/mnq-fire-backtest.js --all-variants    # run all 3 variants and compare
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const { backtestMnqFire } = require('../strategies/mnq-fire');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv      = process.argv.slice(2);
const AS_JSON   = argv.includes('--json');
const VERBOSE   = argv.includes('--verbose');
const ALL_VAR   = argv.includes('--all-variants');
const daysIdx   = argv.indexOf('--days');
const DAYS      = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) || 90 : 90;
const varIdx    = argv.indexOf('--variant');
const VARIANT   = varIdx >= 0 ? argv[varIdx + 1].toUpperCase() : 'CORE';
const symIdx    = argv.indexOf('--symbol');
const SYMBOL    = symIdx >= 0 ? argv[symIdx + 1] : null;

// ── Locate DB ─────────────────────────────────────────────────────────────────
function findDb() {
  const envPath = process.env.DATABASE_URL?.replace('sqlite://', '')
    || process.env.DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of [
    path.join(__dirname, '..', 'aurum.db'),
    path.join(__dirname, '..', 'aurumsignals.db'),
    path.join(__dirname, '..', 'signals.db'),
    '/root/AurumSignals/aurum.db',
    '/root/AurumSignals/signals.db',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Cannot find SQLite DB. Set DATABASE_URL=sqlite://path/to/aurum.db or run from project root.'
  );
}

// ── Load bars ─────────────────────────────────────────────────────────────────
function loadBars(db, interval, daysBack, symbolOverride) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const candidates = symbolOverride
    ? [symbolOverride]
    : ['MNQ1!', 'MNQ', 'NQ=F', '@MNQ'];
  for (const sym of candidates) {
    const rows = db.prepare(`
      SELECT timestamp, open, high, low, close, volume
      FROM historical_bars
      WHERE symbol = ? AND interval = ? AND timestamp >= ?
      ORDER BY timestamp ASC
    `).all(sym, interval, cutoff);
    if (rows.length >= 10) {
      if (!AS_JSON) console.log(`  [${interval}] ${sym}: ${rows.length} bars`);
      return rows;
    }
  }
  if (!AS_JSON) console.log(`  [${interval}] no bars found (tried: ${candidates.join(', ')})`);
  return [];
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function pct(n, total) {
  if (!total) return '—';
  return ((n / total) * 100).toFixed(1) + '%';
}
function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(decimals);
}
function pad(s, w)  { return String(s ?? '').padEnd(w); }
function rpad(s, w) { return String(s ?? '').padStart(w); }
function sep(w = 72) { return '─'.repeat(w); }

function printTable(title, rows, cols) {
  if (!rows.length) return;
  console.log(`\n${sep()}`);
  console.log(`  ${title}`);
  console.log(sep());
  console.log(cols.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const row of rows) {
    console.log(cols.map(c => pad(row[c.key] ?? '—', c.w)).join('  '));
  }
}

// ── Monthly breakdown ─────────────────────────────────────────────────────────
function monthlyBreakdown(signalLog) {
  const map = {};
  for (const t of signalLog) {
    const month = t.date.slice(0, 7);
    if (!map[month]) map[month] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
    map[month].trades++;
    if (t.outcome === 'WIN') map[month].wins++;
    else map[month].losses++;
    map[month].pnl += t.pnl_pts;
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({
      month,
      trades:  m.trades,
      wins:    m.wins,
      losses:  m.losses,
      wr:      pct(m.wins, m.trades),
      pnl_pts: +m.pnl.toFixed(1),
    }));
}

// ── Group breakdown helper ────────────────────────────────────────────────────
function groupBy(signalLog, keyFn, label) {
  const map = {};
  for (const t of signalLog) {
    const k = keyFn(t) ?? 'unknown';
    if (!map[k]) map[k] = { wins: 0, losses: 0, pnl: 0 };
    if (t.outcome === 'WIN') map[k].wins++;
    else map[k].losses++;
    map[k].pnl += t.pnl_pts;
  }
  return Object.entries(map)
    .sort(([a], [b]) => {
      // numeric sort if both numeric
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    })
    .map(([k, g]) => ({
      [label]:   k,
      trades:    g.wins + g.losses,
      wins:      g.wins,
      losses:    g.losses,
      wr:        pct(g.wins, g.wins + g.losses),
      total_pnl: fmt(g.pnl, 1),
      avg_pnl:   fmt(g.pnl / (g.wins + g.losses), 1),
    }));
}

// ── Checklist score distribution ──────────────────────────────────────────────
function scoreDistribution(signalLog) {
  const scores = {};
  for (const t of signalLog) {
    const s = t.checklistScore ?? '?';
    if (!scores[s]) scores[s] = { wins: 0, losses: 0, pnl: 0 };
    if (t.outcome === 'WIN') scores[s].wins++;
    else scores[s].losses++;
    scores[s].pnl += t.pnl_pts;
  }
  return Object.entries(scores)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([score, g]) => ({
      score,
      trades:    g.wins + g.losses,
      wins:      g.wins,
      losses:    g.losses,
      wr:        pct(g.wins, g.wins + g.losses),
      total_pnl: fmt(g.pnl, 1),
    }));
}

// ── MFE/MAE favourable exit analysis ─────────────────────────────────────────
function mfeMaeSummary(signalLog) {
  const wins   = signalLog.filter(t => t.outcome === 'WIN');
  const losses = signalLog.filter(t => t.outcome === 'LOSS');
  const avg = (arr, key) => arr.length
    ? (arr.reduce((s, t) => s + (t[key] || 0), 0) / arr.length).toFixed(1)
    : '—';
  return {
    wins_avg_mfe:  avg(wins,   'mfe'),
    wins_avg_mae:  avg(wins,   'mae'),
    losses_avg_mfe:avg(losses, 'mfe'),
    losses_avg_mae:avg(losses, 'mae'),
    all_avg_mfe:   avg(signalLog, 'mfe'),
    all_avg_mae:   avg(signalLog, 'mae'),
  };
}

// ── Print full report ─────────────────────────────────────────────────────────
function printReport(result, variantKey, days) {
  const { metrics: m, signalLog } = result;

  const t1Rate = signalLog.length
    ? (signalLog.filter(t => t.t1Hit).length / signalLog.length * 100).toFixed(1) : '—';
  const t1Trades = signalLog.filter(t => t.t1Hit);
  const t2Rate = t1Trades.length
    ? (signalLog.filter(t => t.t2Hit).length / t1Trades.length * 100).toFixed(1) : '—';
  const t2Trades = signalLog.filter(t => t.t2Hit);
  const t3Rate = t2Trades.length
    ? (signalLog.filter(t => t.t3Hit).length / t2Trades.length * 100).toFixed(1) : '—';

  const mfeMae = mfeMaeSummary(signalLog);
  const volSpikeCount = signalLog.filter(t => t.volumeSpike).length;
  const confCount     = signalLog.filter(t => t.poolConfluence).length;
  const fvgCount      = signalLog.filter(t => t.isFvgEntry).length;

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  MNQ FIRE [${variantKey}] — Backtest Report  (${days} days, ${m.tradeCount} trades)`);
  console.log(`${'═'.repeat(72)}`);

  console.log(`\n  ── Core Metrics ──────────────────────────────────────────────────────`);
  console.log(`  Win Rate:         ${(m.winRate * 100).toFixed(1)}%   (${m.wins}W / ${m.losses}L)`);
  console.log(`  Expectancy:       ${fmt(m.expectancy)} pts/trade`);
  console.log(`  Profit Factor:    ${m.profitFactor != null ? fmt(m.profitFactor, 3) : '—'}`);
  console.log(`  Sharpe (ann.):    ${m.sharpe != null ? fmt(m.sharpe, 3) : '—'}`);
  console.log(`  Total P&L:        ${fmt(m.totalPnl)} pts`);
  console.log(`  Max Drawdown:     ${fmt(m.maxDrawdown)} pts`);
  console.log(`  Avg Win:          ${fmt(m.avgWin)} pts   |   Avg Loss: ${fmt(m.avgLoss)} pts`);

  console.log(`\n  ── Scale-out Rates ───────────────────────────────────────────────────`);
  console.log(`  T1 hit (1.5R):    ${t1Rate}%`);
  console.log(`  T2 hit (2.5R, conditional on T1): ${t2Rate}%`);
  console.log(`  T3 hit (3.5R, conditional on T2): ${t3Rate}%`);

  console.log(`\n  ── MFE / MAE Analysis ────────────────────────────────────────────────`);
  console.log(`  All trades — avg MFE: ${mfeMae.all_avg_mfe} pts,  avg MAE: ${mfeMae.all_avg_mae} pts`);
  console.log(`  Winners   — avg MFE: ${mfeMae.wins_avg_mfe} pts,  avg MAE: ${mfeMae.wins_avg_mae} pts`);
  console.log(`  Losers    — avg MFE: ${mfeMae.losses_avg_mfe} pts,  avg MAE: ${mfeMae.losses_avg_mae} pts`);

  console.log(`\n  ── v1.1 Signal Quality Flags ─────────────────────────────────────────`);
  console.log(`  Volume spike present:    ${volSpikeCount}/${m.tradeCount} trades (${pct(volSpikeCount, m.tradeCount)})`);
  console.log(`  Pool confluence present: ${confCount}/${m.tradeCount} trades (${pct(confCount, m.tradeCount)})`);
  console.log(`  FVG limit entries:       ${fvgCount}/${m.tradeCount} trades (${pct(fvgCount, m.tradeCount)})`);

  // ── Pool breakdown ──────────────────────────────────────────────────────────
  const poolRows = Object.entries(m.byPool || {})
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([pool, data]) => ({
      pool,
      trades:    data.total,
      wins:      data.wins,
      losses:    data.total - data.wins,
      wr:        pct(data.wins, data.total),
      total_pnl: fmt(data.totalPnl, 1),
      avg_pnl:   fmt(data.total ? data.totalPnl / data.total : 0, 1),
    }));
  printTable('Win Rate by Pool Type', poolRows, [
    { label: 'Pool',       key: 'pool',      w: 14 },
    { label: 'Trades',     key: 'trades',    w: 7  },
    { label: 'W',          key: 'wins',      w: 5  },
    { label: 'L',          key: 'losses',    w: 5  },
    { label: 'WR%',        key: 'wr',        w: 7  },
    { label: 'Total P&L',  key: 'total_pnl', w: 11 },
    { label: 'Avg P&L',    key: 'avg_pnl',   w: 9  },
  ]);

  // ── Entry type breakdown ────────────────────────────────────────────────────
  const entryRows = groupBy(signalLog, t => t.isFvgEntry ? 'FVG_LIMIT' : 'CHOCH_MARKET', 'entry_type');
  printTable('Win Rate by Entry Type', entryRows, [
    { label: 'Entry Type',  key: 'entry_type', w: 14 },
    { label: 'Trades',      key: 'trades',     w: 7  },
    { label: 'W',           key: 'wins',       w: 5  },
    { label: 'L',           key: 'losses',     w: 5  },
    { label: 'WR%',         key: 'wr',         w: 7  },
    { label: 'Total P&L',   key: 'total_pnl',  w: 11 },
    { label: 'Avg P&L',     key: 'avg_pnl',    w: 9  },
  ]);

  // ── Volume spike impact ─────────────────────────────────────────────────────
  const volRows = groupBy(signalLog, t => t.volumeSpike ? 'YES' : 'NO', 'vol_spike');
  printTable('Win Rate — Volume Spike on Sweep Bar', volRows, [
    { label: 'Vol Spike',   key: 'vol_spike',  w: 10 },
    { label: 'Trades',      key: 'trades',     w: 7  },
    { label: 'W',           key: 'wins',       w: 5  },
    { label: 'L',           key: 'losses',     w: 5  },
    { label: 'WR%',         key: 'wr',         w: 7  },
    { label: 'Total P&L',   key: 'total_pnl',  w: 11 },
    { label: 'Avg P&L',     key: 'avg_pnl',    w: 9  },
  ]);

  // ── Pool confluence impact ──────────────────────────────────────────────────
  const confRows = groupBy(signalLog, t => t.poolConfluence ? 'YES' : 'NO', 'confluence');
  printTable('Win Rate — Multi-Pool Tier 1 Confluence', confRows, [
    { label: 'Confluence',  key: 'confluence', w: 11 },
    { label: 'Trades',      key: 'trades',     w: 7  },
    { label: 'W',           key: 'wins',       w: 5  },
    { label: 'L',           key: 'losses',     w: 5  },
    { label: 'WR%',         key: 'wr',         w: 7  },
    { label: 'Total P&L',   key: 'total_pnl',  w: 11 },
    { label: 'Avg P&L',     key: 'avg_pnl',    w: 9  },
  ]);

  // ── Checklist score distribution ────────────────────────────────────────────
  const scoreDist = scoreDistribution(signalLog);
  printTable('Win Rate by Checklist Score (0–10)', scoreDist, [
    { label: 'Score',      key: 'score',     w: 7  },
    { label: 'Trades',     key: 'trades',    w: 7  },
    { label: 'W',          key: 'wins',      w: 5  },
    { label: 'L',          key: 'losses',    w: 5  },
    { label: 'WR%',        key: 'wr',        w: 7  },
    { label: 'Total P&L',  key: 'total_pnl', w: 11 },
  ]);

  // ── Direction breakdown ─────────────────────────────────────────────────────
  const dirRows = groupBy(signalLog, t => t.direction, 'direction');
  printTable('Win Rate by Direction', dirRows, [
    { label: 'Direction',  key: 'direction',  w: 9  },
    { label: 'Trades',     key: 'trades',     w: 7  },
    { label: 'W',          key: 'wins',       w: 5  },
    { label: 'L',          key: 'losses',     w: 5  },
    { label: 'WR%',        key: 'wr',         w: 7  },
    { label: 'Total P&L',  key: 'total_pnl',  w: 11 },
    { label: 'Avg P&L',    key: 'avg_pnl',    w: 9  },
  ]);

  // ── Bias alignment breakdown ────────────────────────────────────────────────
  const biasRows = groupBy(signalLog, t => t.biasAlignment, 'alignment');
  printTable('Win Rate — HTF Bias Alignment', biasRows, [
    { label: 'Alignment',  key: 'alignment',  w: 9  },
    { label: 'Trades',     key: 'trades',     w: 7  },
    { label: 'W',          key: 'wins',       w: 5  },
    { label: 'L',          key: 'losses',     w: 5  },
    { label: 'WR%',        key: 'wr',         w: 7  },
    { label: 'Total P&L',  key: 'total_pnl',  w: 11 },
  ]);

  // ── 4H regime breakdown ─────────────────────────────────────────────────────
  const regRows = groupBy(signalLog, t => t.regime, 'regime');
  printTable('Win Rate by 4H Market Regime', regRows, [
    { label: 'Regime',     key: 'regime',    w: 12 },
    { label: 'Trades',     key: 'trades',    w: 7  },
    { label: 'W',          key: 'wins',      w: 5  },
    { label: 'L',          key: 'losses',    w: 5  },
    { label: 'WR%',        key: 'wr',        w: 7  },
    { label: 'Total P&L',  key: 'total_pnl', w: 11 },
  ]);

  // ── Monthly P&L ─────────────────────────────────────────────────────────────
  const monthly = monthlyBreakdown(signalLog);
  printTable('Monthly P&L Summary', monthly, [
    { label: 'Month',    key: 'month',    w: 9  },
    { label: 'Trades',   key: 'trades',   w: 7  },
    { label: 'W',        key: 'wins',     w: 5  },
    { label: 'L',        key: 'losses',   w: 5  },
    { label: 'WR%',      key: 'wr',       w: 7  },
    { label: 'P&L pts',  key: 'pnl_pts',  w: 10 },
  ]);

  // ── Per-day trade log ───────────────────────────────────────────────────────
  if (VERBOSE && signalLog.length) {
    console.log(`\n${sep()}`);
    console.log(`  Per-Day Trade Log`);
    console.log(sep());
    const vcols = [
      { label: 'Date',       key: 'date',       w: 12 },
      { label: 'Dir',        key: 'direction',  w: 6  },
      { label: 'Pool',       key: 'pool',       w: 12 },
      { label: 'Tier',       key: 'poolTier',   w: 5  },
      { label: 'Score',      key: 'checklistScore', w: 6 },
      { label: 'Entry',      key: 'entry',      w: 9  },
      { label: 'FVG',        key: 'isFvgEntry', w: 5  },
      { label: 'VolSpk',     key: 'volumeSpike',w: 7  },
      { label: 'Conf',       key: 'poolConfluence', w: 5 },
      { label: 'T1',         key: 't1Hit',      w: 4  },
      { label: 'T2',         key: 't2Hit',      w: 4  },
      { label: 'P&L',        key: 'pnl_pts',    w: 7  },
      { label: 'Outcome',    key: 'outcome',    w: 7  },
    ];
    console.log(vcols.map(c => pad(c.label, c.w)).join('  '));
    console.log(sep());
    for (const t of signalLog) {
      const row = {
        ...t,
        isFvgEntry:    t.isFvgEntry    ? 'Y' : '.',
        volumeSpike:   t.volumeSpike   ? 'Y' : '.',
        poolConfluence:t.poolConfluence? 'Y' : '.',
        t1Hit:         t.t1Hit ? 'Y' : '.',
        t2Hit:         t.t2Hit ? 'Y' : '.',
      };
      console.log(vcols.map(c => pad(row[c.key], c.w)).join('  '));
    }
  }

  console.log(`\n${sep()}\n`);
}

// ── All-variants comparison ────────────────────────────────────────────────────
function printVariantComparison(results) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  MNQ FIRE — Variant Comparison Summary`);
  console.log(`${'═'.repeat(72)}`);
  const compRows = results.map(({ variant, metrics: m }) => ({
    variant,
    trades:    m.tradeCount,
    wr:        (m.winRate * 100).toFixed(1) + '%',
    expectancy:fmt(m.expectancy),
    pf:        m.profitFactor != null ? fmt(m.profitFactor, 2) : '—',
    sharpe:    m.sharpe != null ? fmt(m.sharpe, 2) : '—',
    total_pnl: fmt(m.totalPnl),
    max_dd:    fmt(m.maxDrawdown),
  }));
  printTable('Variant Comparison', compRows, [
    { label: 'Variant',      key: 'variant',    w: 14 },
    { label: 'Trades',       key: 'trades',     w: 7  },
    { label: 'WR%',          key: 'wr',         w: 7  },
    { label: 'Expect',       key: 'expectancy', w: 8  },
    { label: 'PF',           key: 'pf',         w: 6  },
    { label: 'Sharpe',       key: 'sharpe',     w: 8  },
    { label: 'Total P&L',    key: 'total_pnl',  w: 11 },
    { label: 'Max DD',       key: 'max_dd',     w: 8  },
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
let dbPath;
try {
  dbPath = findDb();
} catch (e) {
  if (AS_JSON) process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
  else console.error(`\n[backtest] ERROR: ${e.message}\n`);
  process.exit(1);
}

if (!AS_JSON) {
  console.log(`\n[backtest] MNQ FIRE v1.1 — Alert Tuning Runner`);
  console.log(`[backtest] DB:       ${dbPath}`);
  console.log(`[backtest] Lookback: ${DAYS} days`);
  console.log(`[backtest] Variant:  ${ALL_VAR ? 'ALL' : VARIANT}\n`);
  console.log('[backtest] Loading bars...');
}

const db = new Database(dbPath, { readonly: true });
const bars5m  = loadBars(db, '5m',  DAYS,      SYMBOL);
const bars15m = loadBars(db, '15m', DAYS + 7,  SYMBOL);
const bars1h  = loadBars(db, '1h',  DAYS + 7,  SYMBOL);
const bars4h  = loadBars(db, '4h',  DAYS + 14, SYMBOL);
const barsDly = loadBars(db, '1d',  DAYS + 7,  SYMBOL);
db.close();

if (bars5m.length < 10) {
  if (AS_JSON) process.stdout.write(JSON.stringify({ error: 'insufficient_bars' }) + '\n');
  else console.error('[backtest] ERROR: insufficient 5m bars — cannot run backtest');
  process.exit(1);
}

if (!AS_JSON) console.log('\n[backtest] Running simulation...');

if (ALL_VAR) {
  const variants = ['CONSERVATIVE', 'CORE', 'AGGRESSIVE'];
  const results  = [];
  for (const v of variants) {
    if (!AS_JSON) console.log(`  → ${v}...`);
    const result = backtestMnqFire(bars5m, bars1h, bars4h, barsDly, { variant: v });
    results.push({ variant: v, ...result });
    if (!AS_JSON) printReport(result, v, DAYS);
  }
  if (!AS_JSON) printVariantComparison(results);
  if (AS_JSON)  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  const result = backtestMnqFire(bars5m, bars1h, bars4h, barsDly, { variant: VARIANT });
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printReport(result, VARIANT, DAYS);
  }
}

process.exit(0);
