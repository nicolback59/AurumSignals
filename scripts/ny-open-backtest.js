#!/usr/bin/env node
'use strict';

/**
 * NQ NY Open Strategy Backtest Runner
 *
 * Loads historical bars from the AurumSignals SQLite DB and runs the full
 * backtestNyOpen() simulation, printing a comprehensive performance report.
 *
 * Usage:
 *   node scripts/ny-open-backtest.js              # 90-day lookback
 *   node scripts/ny-open-backtest.js --days 180   # custom lookback
 *   node scripts/ny-open-backtest.js --json       # raw JSON output
 *   node scripts/ny-open-backtest.js --verbose    # include per-day trade log
 *   node scripts/ny-open-backtest.js --symbol MNQ1!   # override symbol
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const { backtestNyOpen } = require('../strategies/nq-ny-open');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const VERBOSE = argv.includes('--verbose');
const daysIdx = argv.indexOf('--days');
const DAYS    = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) || 90 : 90;
const symIdx  = argv.indexOf('--symbol');
const SYMBOL  = symIdx >= 0 ? argv[symIdx + 1] : null;

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

// ── Load bars from historical_bars table ──────────────────────────────────────
function loadBars(db, interval, daysBack, symbolOverride) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const candidates = symbolOverride
    ? [symbolOverride]
    : ['MNQ1!', 'MNQ', 'NQ=F', 'MNQ/USD', '@NQ'];
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
function pad(s, w) { return String(s ?? '').padEnd(w); }
function rpad(s, w) { return String(s ?? '').padStart(w); }

function sep(w = 70) { return '─'.repeat(w); }

function printTable(title, rows, cols) {
  console.log(`\n${sep()}`);
  console.log(`  ${title}`);
  console.log(sep());
  console.log(cols.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const row of rows) {
    console.log(cols.map(c => pad(row[c.key] ?? '—', c.w)).join('  '));
  }
}

// ── Monthly P&L helper ────────────────────────────────────────────────────────
function monthlyBreakdown(signalLog) {
  const map = {};
  for (const t of signalLog) {
    const month = t.date.slice(0, 7); // YYYY-MM
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

// ── Main ──────────────────────────────────────────────────────────────────────
const dbPath = findDb();
if (!AS_JSON) console.log(`\n[backtest] Opening DB: ${dbPath}`);
if (!AS_JSON) console.log(`[backtest] Lookback: ${DAYS} days\n`);

const db = new Database(dbPath, { readonly: true });

if (!AS_JSON) console.log('[backtest] Loading bars...');
const bars5m  = loadBars(db, '5m',  DAYS,     SYMBOL);
const bars1h  = loadBars(db, '1h',  DAYS + 7, SYMBOL);
const bars4h  = loadBars(db, '4h',  DAYS + 14, SYMBOL);
const barsDly = loadBars(db, '1d',  DAYS + 7, SYMBOL);
db.close();

if (bars5m.length < 10) {
  if (AS_JSON) { process.stdout.write(JSON.stringify({ error: 'insufficient_bars' }) + '\n'); }
  else { console.error('[backtest] ERROR: insufficient 5m bars — cannot run backtest'); }
  process.exit(1);
}

if (!AS_JSON) console.log('\n[backtest] Running simulation...');
const result = backtestNyOpen(bars5m, bars1h, bars4h, barsDly, { instrument: 'MNQ' });
const { metrics, signalLog } = result;

// ── JSON output ───────────────────────────────────────────────────────────────
if (AS_JSON) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ── Human-readable report ─────────────────────────────────────────────────────
const m = metrics;
const t1Rate   = signalLog.length ? (signalLog.filter(t => t.t1Hit).length / signalLog.length * 100).toFixed(1) : '—';
const t2Rate   = signalLog.filter(t => t.t1Hit).length
  ? (signalLog.filter(t => t.t2Hit).length / signalLog.filter(t => t.t1Hit).length * 100).toFixed(1) : '—';
const t3Rate   = signalLog.filter(t => t.t2Hit).length
  ? (signalLog.filter(t => t.t3Hit).length / signalLog.filter(t => t.t2Hit).length * 100).toFixed(1) : '—';

console.log(`\n${'═'.repeat(70)}`);
console.log(`  NQ NY OPEN — Backtest Report  (${DAYS} days, ${m.tradeCount} trades)`);
console.log(`${'═'.repeat(70)}`);

console.log(`\n  Win Rate:         ${(m.winRate * 100).toFixed(1)}%   (${m.wins}W / ${m.losses}L)`);
console.log(`  Expectancy:       ${fmt(m.expectancy)} pts/trade`);
console.log(`  Profit Factor:    ${fmt(m.profitFactor, 3) ?? '—'}`);
console.log(`  Sharpe (ann.):    ${fmt(m.sharpe, 3) ?? '—'}`);
console.log(`  Total P&L:        ${fmt(m.totalPnl)} pts`);
console.log(`  Max Drawdown:     ${fmt(m.maxDrawdown)} pts`);
console.log(`  Avg Win:          ${fmt(m.avgWin)} pts   |   Avg Loss: ${fmt(m.avgLoss)} pts`);
console.log(`\n  Scale-out rates:`);
console.log(`    T1 hit (≥1.5R): ${t1Rate}%`);
console.log(`    T2 hit (≥2.5R, after T1): ${t2Rate}%`);
console.log(`    T3 hit (≥3.5R, after T2): ${t3Rate}%`);

// Per-archetype breakdown
const archetypes = Object.entries(m.byArchetype || {})
  .sort(([, a], [, b]) => b.total - a.total)
  .map(([arch, data]) => ({
    archetype: arch,
    trades:    data.total,
    wins:      data.wins,
    losses:    data.total - data.wins,
    wr:        pct(data.wins, data.total),
    avg_pnl:   fmt(data.totalPnl != null ? data.totalPnl / data.total : null),
  }));

printTable('Win Rate by Archetype', archetypes, [
  { label: 'Archetype',          key: 'archetype', w: 26 },
  { label: 'Trades',             key: 'trades',    w: 7  },
  { label: 'W',                  key: 'wins',      w: 5  },
  { label: 'L',                  key: 'losses',    w: 5  },
  { label: 'WR%',                key: 'wr',        w: 7  },
  { label: 'Avg P&L',            key: 'avg_pnl',   w: 9  },
]);

// Per-conviction breakdown
const convGroups = {};
for (const t of signalLog) {
  const k = t.conviction ?? 'C';
  if (!convGroups[k]) convGroups[k] = { wins: 0, losses: 0, pnl: 0 };
  if (t.outcome === 'WIN') convGroups[k].wins++;
  else convGroups[k].losses++;
  convGroups[k].pnl += t.pnl_pts;
}
const convRows = Object.entries(convGroups)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([grade, g]) => ({
    grade,
    trades:  g.wins + g.losses,
    wins:    g.wins,
    losses:  g.losses,
    wr:      pct(g.wins, g.wins + g.losses),
    total_pnl: fmt(g.pnl, 1),
  }));

printTable('Win Rate by Conviction Grade', convRows, [
  { label: 'Grade',    key: 'grade',     w: 8  },
  { label: 'Trades',   key: 'trades',    w: 7  },
  { label: 'W',        key: 'wins',      w: 5  },
  { label: 'L',        key: 'losses',    w: 5  },
  { label: 'WR%',      key: 'wr',        w: 7  },
  { label: 'Total P&L',key: 'total_pnl', w: 10 },
]);

// Per-direction breakdown
const dirGroups = {};
for (const t of signalLog) {
  const k = t.direction ?? 'UNKNOWN';
  if (!dirGroups[k]) dirGroups[k] = { wins: 0, losses: 0, pnl: 0 };
  if (t.outcome === 'WIN') dirGroups[k].wins++;
  else dirGroups[k].losses++;
  dirGroups[k].pnl += t.pnl_pts;
}
const dirRows = Object.entries(dirGroups).map(([dir, g]) => ({
  direction: dir,
  trades:    g.wins + g.losses,
  wins:      g.wins,
  losses:    g.losses,
  wr:        pct(g.wins, g.wins + g.losses),
  total_pnl: fmt(g.pnl, 1),
}));
printTable('Win Rate by Direction', dirRows, [
  { label: 'Direction', key: 'direction', w: 9  },
  { label: 'Trades',    key: 'trades',    w: 7  },
  { label: 'W',         key: 'wins',      w: 5  },
  { label: 'L',         key: 'losses',    w: 5  },
  { label: 'WR%',       key: 'wr',        w: 7  },
  { label: 'Total P&L', key: 'total_pnl', w: 10 },
]);

// Per-regime breakdown
const regGroups = {};
for (const t of signalLog) {
  const k = t.regime ?? 'UNKNOWN';
  if (!regGroups[k]) regGroups[k] = { wins: 0, losses: 0, pnl: 0 };
  if (t.outcome === 'WIN') regGroups[k].wins++;
  else regGroups[k].losses++;
  regGroups[k].pnl += t.pnl_pts;
}
const regRows = Object.entries(regGroups).map(([reg, g]) => ({
  regime:    reg,
  trades:    g.wins + g.losses,
  wins:      g.wins,
  losses:    g.losses,
  wr:        pct(g.wins, g.wins + g.losses),
  total_pnl: fmt(g.pnl, 1),
}));
printTable('Win Rate by 4H Regime', regRows, [
  { label: 'Regime',    key: 'regime',    w: 12 },
  { label: 'Trades',    key: 'trades',    w: 7  },
  { label: 'W',         key: 'wins',      w: 5  },
  { label: 'L',         key: 'losses',    w: 5  },
  { label: 'WR%',       key: 'wr',        w: 7  },
  { label: 'Total P&L', key: 'total_pnl', w: 10 },
]);

// Monthly P&L
const monthly = monthlyBreakdown(signalLog);
printTable('Monthly P&L Summary', monthly, [
  { label: 'Month',    key: 'month',    w: 9  },
  { label: 'Trades',   key: 'trades',   w: 7  },
  { label: 'W',        key: 'wins',     w: 5  },
  { label: 'L',        key: 'losses',   w: 5  },
  { label: 'WR%',      key: 'wr',       w: 7  },
  { label: 'P&L pts',  key: 'pnl_pts',  w: 10 },
]);

// Per-day trade log
if (VERBOSE && signalLog.length) {
  console.log(`\n${sep()}`);
  console.log(`  Per-Day Trade Log`);
  console.log(sep());
  const cols2 = [
    { label: 'Date',       key: 'date',       w: 12 },
    { label: 'Dir',        key: 'direction',  w: 6  },
    { label: 'Arch',       key: 'archetype',  w: 24 },
    { label: 'Conv',       key: 'conviction', w: 5  },
    { label: 'Conf',       key: 'confidence', w: 5  },
    { label: 'T1',         key: 't1Hit',      w: 4  },
    { label: 'T2',         key: 't2Hit',      w: 4  },
    { label: 'Outcome',    key: 'outcome',    w: 7  },
    { label: 'P&L',        key: 'pnl_pts',    w: 7  },
  ];
  console.log(cols2.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const t of signalLog) {
    const row = {
      ...t,
      t1Hit: t.t1Hit ? 'Y' : '.',
      t2Hit: t.t2Hit ? 'Y' : '.',
    };
    console.log(cols2.map(c => pad(row[c.key], c.w)).join('  '));
  }
}

console.log(`\n${sep()}\n`);
process.exit(0);
