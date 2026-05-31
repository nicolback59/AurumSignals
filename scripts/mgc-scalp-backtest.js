#!/usr/bin/env node
'use strict';

/**
 * MGC Scalp Strategy Backtest Runner
 *
 * Loads historical 5m bars from the AurumSignals SQLite DB, aggregates
 * 15m/30m/45m/1h HTF context, then runs the full MGC scalp simulation
 * bar-by-bar using the live evaluate() function.
 *
 * Usage:
 *   node scripts/mgc-scalp-backtest.js              # 90-day lookback, v6.0 (default)
 *   node scripts/mgc-scalp-backtest.js --v1         # run v5.4 (old strategy)
 *   node scripts/mgc-scalp-backtest.js --compare    # side-by-side v5.4 vs v6.0
 *   node scripts/mgc-scalp-backtest.js --days 180   # custom lookback
 *   node scripts/mgc-scalp-backtest.js --json       # raw JSON output
 *   node scripts/mgc-scalp-backtest.js --verbose    # per-trade log
 *   node scripts/mgc-scalp-backtest.js --audit      # rejection reason breakdown
 *   node scripts/mgc-scalp-backtest.js --symbol MGC1!  # override symbol
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const v1       = require('../strategies/mgc-scalp');
const v2       = require('../strategies/mgc-scalp-v2');
const {
  aggregate5mTo15m,
  aggregate5mTo30m,
  aggregate5mTo45m,
  aggregate5mTo1h,
} = require('../strategies/shared-indicators');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv      = process.argv.slice(2);
const AS_JSON   = argv.includes('--json');
const VERBOSE   = argv.includes('--verbose');
const AUDIT     = argv.includes('--audit');
const USE_V1    = argv.includes('--v1');
const COMPARE   = argv.includes('--compare');
const daysIdx   = argv.indexOf('--days');
const DAYS      = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) || 90 : 90;
const symIdx    = argv.indexOf('--symbol');
const SYMBOL    = symIdx >= 0 ? argv[symIdx + 1] : null;

// Default to v6.0; --v1 forces v5.4; --compare runs both
const { evaluate, reset: resetMgc } = USE_V1 ? v1 : v2;

// Rolling execution window passed to evaluate() — enough for EMA/VWAP context
// without blending 90 days of VWAP into a single level
const EXEC_WINDOW  = 120; // ~10 h of 5m bars
const MAX_HOLD_BARS = 24; // 2-hour max hold before time stop

// ── Locate DB ─────────────────────────────────────────────────────────────────
function findDb() {
  const envPath = process.env.DATABASE_URL?.replace('sqlite://', '') || process.env.DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of [
    path.join(__dirname, '..', 'aurum.db'),
    path.join(__dirname, '..', 'aurumsignals.db'),
    path.join(__dirname, '..', 'signals.db'),
    '/root/AurumSignals/aurum.db',
    '/root/AurumSignals/signals.db',
  ]) { if (fs.existsSync(p)) return p; }
  throw new Error('Cannot find SQLite DB. Set DATABASE_URL=sqlite://path/to/aurum.db');
}

// ── Load bars ─────────────────────────────────────────────────────────────────
function loadBars(db, interval, daysBack, symbolOverride) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const candidates = symbolOverride
    ? [symbolOverride]
    : ['MGC1!', 'MGC', 'GC=F', '/MGC', 'MGC/USD'];
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
  if (!AS_JSON) console.log(`  [${interval}] no DB rows — will aggregate from 5m`);
  return [];
}

// ── Trade simulation — 4-tranche (25% each at TP1/2/3/4) ─────────────────────
// TPs are read from the signal (ATR-scaled in v6.0, fixed 10/14/20/25 in v5.4).
// After TP1, stop moves to breakeven. Time stop exits remaining at last close
// (respecting current stop level so the sim never exceeds the structural risk).
function simulateTrade(sig, futureBars) {
  const isBull  = sig.direction === 'LONG';
  const entry   = sig.entry;
  const sl      = sig.sl;
  const rawRisk = +Math.abs(isBull ? entry - sl : sl - entry).toFixed(2);

  // Use ATR-scaled TPs from signal when available (v6.0), else hardcoded (v5.4)
  const tp1 = sig.tp1 ?? (isBull ? entry + 10 : entry - 10);
  const tp2 = sig.tp2 ?? (isBull ? entry + 14 : entry - 14);
  const tp3 = sig.tp3 ?? (isBull ? entry + 20 : entry - 20);
  const tp4 = sig.tp4 ?? (isBull ? entry + 25 : entry - 25);

  let pnlPts = 0, stopLvl = sl, openFrac = 1.0;
  let t1Done = false, t2Done = false, t3Done = false, t4Done = false;
  let barsHeld = 0, mfe = 0, mae = 0;

  for (const bar of futureBars) {
    barsHeld++;
    mfe = Math.max(mfe, isBull ? bar.high - entry : entry - bar.low);
    mae = Math.max(mae, isBull ? entry - bar.low  : bar.high - entry);

    if (isBull) {
      if (openFrac > 0 && bar.low <= stopLvl) { pnlPts += openFrac * (stopLvl - entry); break; }
      if (!t1Done && bar.high >= tp1) { t1Done = true; pnlPts += 0.25 * (tp1 - entry); openFrac = 0.75; stopLvl = entry; }
      if (t1Done  && !t2Done && bar.high >= tp2) { t2Done = true; pnlPts += 0.25 * (tp2 - entry); openFrac = 0.50; }
      if (t2Done  && !t3Done && bar.high >= tp3) { t3Done = true; pnlPts += 0.25 * (tp3 - entry); openFrac = 0.25; }
      if (t3Done  && !t4Done && bar.high >= tp4) { t4Done = true; pnlPts += 0.25 * (tp4 - entry); openFrac = 0; break; }
    } else {
      if (openFrac > 0 && bar.high >= stopLvl) { pnlPts += openFrac * (entry - stopLvl); break; }
      if (!t1Done && bar.low <= tp1) { t1Done = true; pnlPts += 0.25 * (entry - tp1); openFrac = 0.75; stopLvl = entry; }
      if (t1Done  && !t2Done && bar.low <= tp2) { t2Done = true; pnlPts += 0.25 * (entry - tp2); openFrac = 0.50; }
      if (t2Done  && !t3Done && bar.low <= tp3) { t3Done = true; pnlPts += 0.25 * (entry - tp3); openFrac = 0.25; }
      if (t3Done  && !t4Done && bar.low <= tp4) { t4Done = true; pnlPts += 0.25 * (entry - tp4); openFrac = 0; break; }
    }
  }

  // Time stop: exit remaining at last bar's close, never worse than current stop
  if (openFrac > 0 && futureBars.length > 0) {
    const last   = futureBars[futureBars.length - 1];
    const exitPx = isBull ? Math.max(last.close, stopLvl) : Math.min(last.close, stopLvl);
    pnlPts += openFrac * (isBull ? exitPx - entry : entry - exitPx);
  }

  pnlPts = Math.max(pnlPts, -rawRisk); // hard floor
  pnlPts = +pnlPts.toFixed(2);

  return {
    pnlPts, rawRisk,
    outcome:  t1Done ? 'WIN' : 'LOSS',
    t1Done, t2Done, t3Done, t4Done,
    barsHeld,
    mfe: +mfe.toFixed(2),
    mae: +mae.toFixed(2),
  };
}

// ── ET date helper ────────────────────────────────────────────────────────────
function getDateKey(ts) {
  try {
    const d  = new Date(ts);
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
  } catch { return new Date(ts).toISOString().slice(0, 10); }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function pct(n, total) { return !total ? '—' : ((n / total) * 100).toFixed(1) + '%'; }
function fmt(n, d = 2)  { return (n == null || isNaN(n)) ? '—' : (+n).toFixed(d); }
function pad(s, w)       { return String(s ?? '').padEnd(w); }
function sep(w = 70)     { return '─'.repeat(w); }

function printTable(title, rows, cols) {
  console.log(`\n${sep()}`);
  console.log(`  ${title}`);
  console.log(sep());
  console.log(cols.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const row of rows) console.log(cols.map(c => pad(row[c.key] ?? '—', c.w)).join('  '));
}

function groupBy(tradeLog, key) {
  const map = {};
  for (const t of tradeLog) {
    const k = t[key] || 'UNKNOWN';
    if (!map[k]) map[k] = { wins: 0, losses: 0, pnl: 0 };
    map[k][t.outcome === 'WIN' ? 'wins' : 'losses']++;
    map[k].pnl += t.pnlPts;
  }
  return Object.entries(map)
    .sort(([, a], [, b]) => (b.wins + b.losses) - (a.wins + a.losses))
    .map(([label, g]) => ({
      label,
      trades:    g.wins + g.losses,
      wins:      g.wins,
      losses:    g.losses,
      wr:        pct(g.wins, g.wins + g.losses),
      total_pnl: fmt(g.pnl, 1),
    }));
}

function monthlyBreakdown(tradeLog) {
  const map = {};
  for (const t of tradeLog) {
    const m = t.date.slice(0, 7);
    if (!map[m]) map[m] = { wins: 0, losses: 0, pnl: 0 };
    map[m][t.outcome === 'WIN' ? 'wins' : 'losses']++;
    map[m].pnl += t.pnlPts;
  }
  return Object.entries(map).sort().map(([month, g]) => ({
    month, trades: g.wins + g.losses, wins: g.wins, losses: g.losses,
    wr: pct(g.wins, g.wins + g.losses), pnl_pts: +g.pnl.toFixed(1),
  }));
}

// ── Bar-by-bar simulation engine ──────────────────────────────────────────────
function runSimulation(bars5mRaw, bars15m, bars30m, bars45m, bars1h, evalFn, resetFn, collectAudit) {
  const tradeLog     = [];
  const auditReasons = [];
  let pnlRunning = 0, peak = 0, maxDrawdown = 0;
  let skipUntil = -1, barsSkipped = 0, barsEligible = 0;

  resetFn();
  let idx15 = 0, idx30 = 0, idx45 = 0, idx1h = 0;

  for (let i = EXEC_WINDOW; i < bars5mRaw.length; i++) {
    if (i < skipUntil) {
      barsSkipped++;
      const ts = bars5mRaw[i].timestamp;
      while (idx15 < bars15m.length - 1 && bars15m[idx15 + 1].timestamp <= ts) idx15++;
      while (idx30 < bars30m.length - 1 && bars30m[idx30 + 1].timestamp <= ts) idx30++;
      while (idx45 < bars45m.length - 1 && bars45m[idx45 + 1].timestamp <= ts) idx45++;
      while (idx1h  < bars1h.length  - 1 && bars1h [idx1h  + 1].timestamp <= ts) idx1h++;
      continue;
    }
    barsEligible++;

    const ts = bars5mRaw[i].timestamp;
    while (idx15 < bars15m.length - 1 && bars15m[idx15 + 1].timestamp <= ts) idx15++;
    while (idx30 < bars30m.length - 1 && bars30m[idx30 + 1].timestamp <= ts) idx30++;
    while (idx45 < bars45m.length - 1 && bars45m[idx45 + 1].timestamp <= ts) idx45++;
    while (idx1h  < bars1h.length  - 1 && bars1h [idx1h  + 1].timestamp <= ts) idx1h++;

    const exec5m = bars5mRaw.slice(i - EXEC_WINDOW + 1, i + 1);
    const b15    = bars15m.slice(0, idx15 + 1);
    const b30    = bars30m.slice(0, idx30 + 1);
    const b45    = bars45m.slice(0, idx45 + 1);
    const b1h    = bars1h.slice(0, idx1h + 1);

    const barAudit = collectAudit ? [] : undefined;
    const sig = evalFn([], exec5m, b15, b1h, b30, b45, { auditLog: barAudit }, i);
    if (barAudit?.length) auditReasons.push(...barAudit);
    if (!sig) continue;

    const futureBars = bars5mRaw.slice(i + 1, i + 1 + MAX_HOLD_BARS);
    if (futureBars.length === 0) continue;

    const result = simulateTrade(sig, futureBars);

    tradeLog.push({
      date:       getDateKey(ts),
      timestamp:  ts,
      direction:  sig.direction,
      archetype:  sig.indicators?.archetype ?? 'unknown',
      regime:     sig.indicators?.regime    ?? 'UNKNOWN',
      session:    sig.session               ?? 'UNKNOWN',
      confidence: sig.confidence,
      entry:      +sig.entry.toFixed(2),
      sl:         +sig.sl.toFixed(2),
      ...result,
    });

    pnlRunning += result.pnlPts;
    peak        = Math.max(peak, pnlRunning);
    maxDrawdown = Math.max(maxDrawdown, peak - pnlRunning);
    skipUntil   = i + 1 + result.barsHeld;
    resetFn();
  }

  return { tradeLog, auditReasons, maxDrawdown, barsSkipped, barsEligible };
}

function computeMetrics(tradeLog, maxDrawdown) {
  const wins         = tradeLog.filter(t => t.outcome === 'WIN').length;
  const losses       = tradeLog.filter(t => t.outcome === 'LOSS').length;
  const tradeCount   = wins + losses;
  const winRate      = tradeCount > 0 ? wins / tradeCount : 0;
  const totalPnl     = +tradeLog.reduce((s, t) => s + t.pnlPts, 0).toFixed(2);
  const wTrades      = tradeLog.filter(t => t.outcome === 'WIN');
  const lTrades      = tradeLog.filter(t => t.outcome === 'LOSS');
  const avgWin       = wTrades.length ? wTrades.reduce((s, t) => s + t.pnlPts, 0) / wTrades.length : 0;
  const avgLoss      = lTrades.length ? Math.abs(lTrades.reduce((s, t) => s + t.pnlPts, 0) / lTrades.length) : 0;
  const profitFactor = avgLoss > 0 && losses > 0 ? (wins * avgWin) / (losses * avgLoss) : null;
  const expectancy   = tradeCount > 0 ? totalPnl / tradeCount : 0;
  const returns      = tradeLog.map(t => t.pnlPts);
  const mean         = returns.reduce((s, v) => s + v, 0) / (returns.length || 1);
  const variance     = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const sharpe       = variance > 0 ? +(mean / Math.sqrt(variance) * Math.sqrt(252)).toFixed(3) : null;
  const avgMfe       = tradeLog.length ? +(tradeLog.reduce((s, t) => s + t.mfe, 0) / tradeLog.length).toFixed(2) : 0;
  const avgMae       = tradeLog.length ? +(tradeLog.reduce((s, t) => s + t.mae, 0) / tradeLog.length).toFixed(2) : 0;
  const t1Count = tradeLog.filter(t => t.t1Done).length;
  const t2Count = tradeLog.filter(t => t.t2Done).length;
  const t3Count = tradeLog.filter(t => t.t3Done).length;
  const t4Count = tradeLog.filter(t => t.t4Done).length;
  return {
    wins, losses, tradeCount, winRate, totalPnl, avgWin, avgLoss,
    profitFactor, expectancy, sharpe, avgMfe, avgMae, maxDrawdown,
    t1Count, t2Count, t3Count, t4Count,
    t1Rate: tradeCount ? (t1Count / tradeCount * 100).toFixed(1) : '—',
    t2Rate: t1Count ? (t2Count / t1Count * 100).toFixed(1) : '—',
    t3Rate: t2Count ? (t3Count / t2Count * 100).toFixed(1) : '—',
    t4Rate: t3Count ? (t4Count / t3Count * 100).toFixed(1) : '—',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const dbPath = findDb();
if (!AS_JSON) {
  console.log(`\n[backtest] Opening DB: ${dbPath}`);
  console.log(`[backtest] Lookback: ${DAYS} days  |  Strategy: ${COMPARE ? 'v5.4 vs v6.0' : USE_V1 ? 'v5.4' : 'v6.0'}\n`);
}

const db = new Database(dbPath, { readonly: true });

if (!AS_JSON) console.log('[backtest] Loading bars...');
const bars5mRaw = loadBars(db, '5m',  DAYS,      SYMBOL);
const bars1hRaw = loadBars(db, '1h',  DAYS + 7,  SYMBOL);
db.close();

if (bars5mRaw.length < 40) {
  const err = { error: 'insufficient_bars', count: bars5mRaw.length };
  if (AS_JSON) { process.stdout.write(JSON.stringify(err) + '\n'); }
  else { console.error('[backtest] ERROR: insufficient 5m bars — cannot run backtest'); }
  process.exit(1);
}

if (!AS_JSON) console.log('[backtest] Aggregating HTF bars...');
const bars15m = aggregate5mTo15m(bars5mRaw);
const bars30m = aggregate5mTo30m(bars5mRaw);
const bars45m = aggregate5mTo45m(bars5mRaw);
const bars1h  = bars1hRaw.length >= 10 ? bars1hRaw : aggregate5mTo1h(bars5mRaw);

if (!AS_JSON) {
  console.log(`  [15m] ${bars15m.length}  [30m] ${bars30m.length}  [45m] ${bars45m.length}  [1h] ${bars1h.length} bars`);
  console.log('\n[backtest] Running simulation...\n');
}

// ── Run one or both strategies ────────────────────────────────────────────────
const r1 = COMPARE
  ? runSimulation(bars5mRaw, bars15m, bars30m, bars45m, bars1h, v1.evaluate, v1.reset, AUDIT)
  : null;
const r2 = runSimulation(bars5mRaw, bars15m, bars30m, bars45m, bars1h, evaluate, resetMgc, AUDIT);

const { tradeLog, auditReasons, maxDrawdown, barsSkipped, barsEligible } = r2;
const m = computeMetrics(tradeLog, maxDrawdown);
const { wins, losses, tradeCount, winRate, totalPnl, avgWin, avgLoss,
        profitFactor, expectancy, sharpe, avgMfe, avgMae,
        t1Rate, t2Rate, t3Rate, t4Rate } = m;

// ── JSON output ───────────────────────────────────────────────────────────────
if (AS_JSON) {
  const out = {
    metrics: {
      tradeCount, winRate, wins, losses,
      totalPnl, expectancy: +expectancy.toFixed(2),
      profitFactor: profitFactor != null ? +profitFactor.toFixed(3) : null,
      maxDrawdown: +maxDrawdown.toFixed(2),
      sharpe, avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
      avgMfe, avgMae,
    },
    tradeLog,
  };
  if (r1) {
    const m1 = computeMetrics(r1.tradeLog, r1.maxDrawdown);
    out.v1_metrics = {
      tradeCount: m1.tradeCount, winRate: m1.winRate, wins: m1.wins, losses: m1.losses,
      totalPnl: m1.totalPnl, expectancy: +m1.expectancy.toFixed(2),
      profitFactor: m1.profitFactor != null ? +m1.profitFactor.toFixed(3) : null,
      maxDrawdown: +m1.maxDrawdown.toFixed(2),
    };
    out.v1_tradeLog = r1.tradeLog;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

// ── Human-readable report ─────────────────────────────────────────────────────
const label = USE_V1 ? 'v5.4' : 'v6.0';
console.log(`\n${'═'.repeat(70)}`);
console.log(`  MGC SCALP ${label} — Backtest Report  (${DAYS} days, ${tradeCount} trades)`);
console.log(`${'═'.repeat(70)}`);

console.log(`\n  Win Rate:         ${(winRate * 100).toFixed(1)}%   (${wins}W / ${losses}L)`);
console.log(`  Expectancy:       ${fmt(expectancy)} pts/trade`);
console.log(`  Profit Factor:    ${fmt(profitFactor, 3)}`);
console.log(`  Sharpe (ann.):    ${fmt(sharpe, 3)}`);
console.log(`  Total P&L:        ${fmt(totalPnl)} pts`);
console.log(`  Max Drawdown:     ${fmt(maxDrawdown)} pts`);
console.log(`  Avg Win:          ${fmt(avgWin)} pts   |   Avg Loss: ${fmt(avgLoss)} pts`);
console.log(`  Avg MFE:          ${fmt(avgMfe)} pts   |   Avg MAE:  ${fmt(avgMae)} pts`);
console.log(`\n  Scale-out rates:`);
console.log(`    T1 hit (ATR-scaled):           ${t1Rate}%`);
console.log(`    T2 hit (after T1):             ${t2Rate}%`);
console.log(`    T3 hit (after T2):             ${t3Rate}%`);
console.log(`    T4 hit (after T3):             ${t4Rate}%`);

// By archetype
printTable('Win Rate by Archetype', groupBy(tradeLog, 'archetype').map(r => ({ ...r, archetype: r.label })), [
  { label: 'Archetype',   key: 'archetype', w: 24 },
  { label: 'Trades',      key: 'trades',    w: 7  },
  { label: 'W',           key: 'wins',      w: 5  },
  { label: 'L',           key: 'losses',    w: 5  },
  { label: 'WR%',         key: 'wr',        w: 7  },
  { label: 'Total P&L',   key: 'total_pnl', w: 10 },
]);

// By session
printTable('Win Rate by Session', groupBy(tradeLog, 'session').map(r => ({ ...r, session: r.label })), [
  { label: 'Session',     key: 'session',   w: 16 },
  { label: 'Trades',      key: 'trades',    w: 7  },
  { label: 'W',           key: 'wins',      w: 5  },
  { label: 'L',           key: 'losses',    w: 5  },
  { label: 'WR%',         key: 'wr',        w: 7  },
  { label: 'Total P&L',   key: 'total_pnl', w: 10 },
]);

// By regime
printTable('Win Rate by Regime', groupBy(tradeLog, 'regime').map(r => ({ ...r, regime: r.label })), [
  { label: 'Regime',      key: 'regime',    w: 14 },
  { label: 'Trades',      key: 'trades',    w: 7  },
  { label: 'W',           key: 'wins',      w: 5  },
  { label: 'L',           key: 'losses',    w: 5  },
  { label: 'WR%',         key: 'wr',        w: 7  },
  { label: 'Total P&L',   key: 'total_pnl', w: 10 },
]);

// By direction
printTable('Win Rate by Direction', groupBy(tradeLog, 'direction').map(r => ({ ...r, direction: r.label })), [
  { label: 'Direction',   key: 'direction', w: 9  },
  { label: 'Trades',      key: 'trades',    w: 7  },
  { label: 'W',           key: 'wins',      w: 5  },
  { label: 'L',           key: 'losses',    w: 5  },
  { label: 'WR%',         key: 'wr',        w: 7  },
  { label: 'Total P&L',   key: 'total_pnl', w: 10 },
]);

// Monthly
printTable('Monthly P&L Summary', monthlyBreakdown(tradeLog), [
  { label: 'Month',   key: 'month',    w: 9  },
  { label: 'Trades',  key: 'trades',   w: 7  },
  { label: 'W',       key: 'wins',     w: 5  },
  { label: 'L',       key: 'losses',   w: 5  },
  { label: 'WR%',     key: 'wr',       w: 7  },
  { label: 'P&L pts', key: 'pnl_pts',  w: 10 },
]);

// ── Compare delta table ───────────────────────────────────────────────────────
if (COMPARE && r1) {
  const m1 = computeMetrics(r1.tradeLog, r1.maxDrawdown);
  const daysPerMonth = DAYS / 30;
  const tpm1 = (m1.tradeCount / daysPerMonth).toFixed(1);
  const tpm2 = (m.tradeCount  / daysPerMonth).toFixed(1);
  const delta = (n, v1v, v2v) => {
    const d = v2v - v1v;
    return (d >= 0 ? '+' : '') + (typeof v1v === 'number' && !Number.isInteger(v1v) ? d.toFixed(2) : Math.round(d));
  };
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  v5.4 vs v6.0 Comparison  (${DAYS} days)`);
  console.log('═'.repeat(70));
  const cCols = [
    { label: 'Metric',        key: 'metric', w: 22 },
    { label: 'v5.4',          key: 'v1',     w: 12 },
    { label: 'v6.0',          key: 'v2',     w: 12 },
    { label: 'Delta',         key: 'delta',  w: 10 },
  ];
  const cRows = [
    { metric: 'Trades/month',  v1: tpm1, v2: tpm2, delta: ((m.tradeCount - m1.tradeCount) / daysPerMonth).toFixed(1) },
    { metric: 'Total trades',  v1: m1.tradeCount, v2: m.tradeCount, delta: delta('t', m1.tradeCount, m.tradeCount) },
    { metric: 'Win Rate',      v1: (m1.winRate*100).toFixed(1)+'%', v2: (m.winRate*100).toFixed(1)+'%', delta: ((m.winRate - m1.winRate)*100).toFixed(1)+'%' },
    { metric: 'Expectancy',    v1: fmt(m1.expectancy), v2: fmt(expectancy), delta: fmt(expectancy - m1.expectancy) },
    { metric: 'Profit Factor', v1: fmt(m1.profitFactor, 3), v2: fmt(profitFactor, 3), delta: m1.profitFactor && profitFactor ? fmt(profitFactor - m1.profitFactor, 3) : '—' },
    { metric: 'Total P&L',     v1: fmt(m1.totalPnl), v2: fmt(totalPnl), delta: fmt(totalPnl - m1.totalPnl) },
    { metric: 'Max Drawdown',  v1: fmt(m1.maxDrawdown), v2: fmt(maxDrawdown), delta: fmt(maxDrawdown - m1.maxDrawdown) },
    { metric: 'Avg Win',       v1: fmt(m1.avgWin), v2: fmt(avgWin), delta: fmt(avgWin - m1.avgWin) },
    { metric: 'Avg Loss',      v1: fmt(m1.avgLoss), v2: fmt(avgLoss), delta: fmt(avgLoss - m1.avgLoss) },
    { metric: 'Sharpe',        v1: fmt(m1.sharpe, 3), v2: fmt(sharpe, 3), delta: m1.sharpe && sharpe ? fmt(sharpe - m1.sharpe, 3) : '—' },
  ];
  console.log(cCols.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const row of cRows) console.log(cCols.map(c => pad(row[c.key], c.w)).join('  '));
}

// Audit rejection breakdown
if (AUDIT) {
  const totalBarsWalked = bars5mRaw.length - EXEC_WINDOW;
  console.log(`\n${sep()}`);
  console.log(`  Rejection Audit  (bars walked: ${totalBarsWalked}  |  in-trade skipped: ${barsSkipped}  |  eligible: ${barsEligible})`);
  console.log(sep());
  const reasonCounts = {};
  for (const r of auditReasons) reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  const sorted = Object.entries(reasonCounts).sort(([, a], [, b]) => b - a);
  const totalRejected = sorted.reduce((s, [, c]) => s + c, 0);
  console.log(`  Total eligible bars: ${barsEligible}   Signals fired: ${tradeCount}   Rejected: ${totalRejected}`);
  console.log(`  Fire rate: ${barsEligible > 0 ? ((tradeCount / barsEligible) * 100).toFixed(2) : '—'}%\n`);
  const rCols = [
    { label: 'Rejection Reason',    key: 'reason', w: 30 },
    { label: 'Count',               key: 'count',  w: 8  },
    { label: '% of Rejected',       key: 'pctRej', w: 14 },
    { label: '% of Eligible',       key: 'pctElig',w: 14 },
  ];
  console.log(rCols.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const [reason, count] of sorted) {
    const row = {
      reason,
      count,
      pctRej:  totalRejected ? ((count / totalRejected) * 100).toFixed(1) + '%' : '—',
      pctElig: barsEligible  ? ((count / barsEligible)  * 100).toFixed(1) + '%' : '—',
    };
    console.log(rCols.map(c => pad(row[c.key], c.w)).join('  '));
  }
}

// Per-trade log
if (VERBOSE && tradeLog.length) {
  console.log(`\n${sep()}`);
  console.log(`  Per-Trade Log`);
  console.log(sep());
  const cols = [
    { label: 'Date',      key: 'date',       w: 12 },
    { label: 'Dir',       key: 'direction',  w: 6  },
    { label: 'Archetype', key: 'archetype',  w: 22 },
    { label: 'Session',   key: 'session',    w: 12 },
    { label: 'Conf',      key: 'confidence', w: 5  },
    { label: 'T1',        key: 't1s',        w: 4  },
    { label: 'T2',        key: 't2s',        w: 4  },
    { label: 'T3',        key: 't3s',        w: 4  },
    { label: 'T4',        key: 't4s',        w: 4  },
    { label: 'Outcome',   key: 'outcome',    w: 7  },
    { label: 'P&L',       key: 'pnl',        w: 8  },
  ];
  console.log(cols.map(c => pad(c.label, c.w)).join('  '));
  console.log(sep());
  for (const t of tradeLog) {
    const row = {
      ...t, pnl: t.pnlPts,
      t1s: t.t1Done ? 'Y' : '.', t2s: t.t2Done ? 'Y' : '.',
      t3s: t.t3Done ? 'Y' : '.', t4s: t.t4Done ? 'Y' : '.',
    };
    console.log(cols.map(c => pad(row[c.key], c.w)).join('  '));
  }
}

console.log(`\n${sep()}\n`);
process.exit(0);
