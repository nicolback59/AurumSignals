#!/usr/bin/env node
'use strict';

/**
 * MNQ INTRADAY Strategy Backtest Runner
 *
 * Runs a bar-by-bar simulation of MNQ_INTRADAY (v3.0) and/or the new V2 (v4.0),
 * printing a comprehensive performance report. Can compare both side-by-side.
 *
 * Usage:
 *   node scripts/mnq-intraday-backtest.js                  # v3 only, 90 days
 *   node scripts/mnq-intraday-backtest.js --v2             # run V2 only
 *   node scripts/mnq-intraday-backtest.js --compare        # run both, compare
 *   node scripts/mnq-intraday-backtest.js --days 180       # custom lookback
 *   node scripts/mnq-intraday-backtest.js --verbose        # per-trade log
 *   node scripts/mnq-intraday-backtest.js --json           # raw JSON output
 *
 * Win definition: TP1 hit before SL.
 * PnL is raw points (MNQ 1 contract × tick value = $0.50/pt).
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const { evaluate: evalV3, reset: resetV3 } = require('../strategies/mnq-intraday');
const { evaluate: evalV2, reset: resetV2 } = require('../strategies/mnq-intraday-v2');

const {
  aggregate5mTo15m, aggregate5mTo1h, aggregate1hTo4h, aggregateBars,
} = require('../strategies/shared-indicators');

// ── CLI args ───────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const VERBOSE = argv.includes('--verbose');
const RUN_V2  = argv.includes('--v2') || argv.includes('--compare');
const RUN_V3  = !argv.includes('--v2') || argv.includes('--compare');
const COMPARE = argv.includes('--compare');
const daysIdx = argv.indexOf('--days');
const DAYS    = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) || 90 : 90;
const symIdx  = argv.indexOf('--symbol');
const SYMBOL  = symIdx >= 0 ? argv[symIdx + 1] : null;

// ── DB locate ─────────────────────────────────────────────────────────────────
function findDb() {
  const envPath = process.env.DATABASE_URL?.replace('sqlite://', '') || process.env.DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of [
    path.join(__dirname, '..', 'signals.db'),
    path.join(__dirname, '..', 'aurum.db'),
    '/root/AurumSignals/signals.db',
    '/root/AurumSignals/aurum.db',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Cannot find SQLite DB. Set DB_PATH or run from project root.');
}

// ── Load bars ─────────────────────────────────────────────────────────────────
function loadBars(db, interval, daysBack) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const candidates = SYMBOL ? [SYMBOL] : ['MNQ1!', 'MNQ', 'NQ=F', '@MNQ'];
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
  if (!AS_JSON) console.log(`  [${interval}] no bars found`);
  return [];
}

// ── Derive larger TF from smaller when DB has no direct rows ─────────────────
function deriveBars(smallerBars, factor) {
  const out = [];
  const start = smallerBars.length % factor;
  for (let i = start; i + factor - 1 < smallerBars.length; i += factor) {
    const s = smallerBars.slice(i, i + factor);
    out.push({
      timestamp: s[0].timestamp,
      open:      s[0].open,
      high:      Math.max(...s.map(b => b.high)),
      low:       Math.min(...s.map(b => b.low)),
      close:     s[s.length - 1].close,
      volume:    s.reduce((sum, b) => sum + (b.volume || 0), 0),
    });
  }
  return out;
}

function deriveDaily(bars1h) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const byDate = {};
  for (const b of bars1h) {
    const date = fmt.format(new Date(b.timestamp));
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(b);
  }
  return Object.values(byDate).map(dayBars => ({
    timestamp: dayBars[0].timestamp,
    open:      dayBars[0].open,
    high:      Math.max(...dayBars.map(b => b.high)),
    low:       Math.min(...dayBars.map(b => b.low)),
    close:     dayBars[dayBars.length - 1].close,
    volume:    dayBars.reduce((s, b) => s + (b.volume || 0), 0),
  }));
}

// ── Bar-by-bar signal resolution ──────────────────────────────────────────────
// Returns { result: 'WIN'|'LOSS'|'OPEN', exitPnl, exitBar }
function resolveSignal(signal, bars, startIdx) {
  const { direction, entry, sl, tp1 } = signal;
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    if (direction === 'LONG') {
      if (b.high >= tp1) return { result: 'WIN',  pnl: +(tp1 - entry).toFixed(2), exitBar: i };
      if (b.low  <= sl)  return { result: 'LOSS', pnl: +(sl  - entry).toFixed(2), exitBar: i };
    } else {
      if (b.low  <= tp1) return { result: 'WIN',  pnl: +(entry - tp1).toFixed(2), exitBar: i };
      if (b.high >= sl)  return { result: 'LOSS', pnl: +(entry - sl ).toFixed(2), exitBar: i };
    }
  }
  return { result: 'OPEN', pnl: 0, exitBar: bars.length - 1 };
}

// ── Run single strategy ───────────────────────────────────────────────────────
function runBacktest(label, evaluateFn, resetFn, bars5m, bars15m, bars1h, bars4h) {
  resetFn();
  const trades    = [];
  const MIN_BARS  = 60;

  for (let i = MIN_BARS; i < bars5m.length; i++) {
    const slice5m  = bars5m.slice(0, i + 1);
    const slice15m = bars15m.filter(b => b.timestamp <= slice5m[i].timestamp);
    const slice1h  = bars1h.filter(b => b.timestamp  <= slice5m[i].timestamp);
    const slice4h  = bars4h.filter(b => b.timestamp  <= slice5m[i].timestamp);

    const sig = evaluateFn(slice5m, slice15m, slice1h, slice4h, {}, i);
    if (!sig) continue;

    // Resolve on subsequent bars
    const resolution = resolveSignal(sig, bars5m, i + 1);
    trades.push({
      barIdx:    i,
      timestamp: sig.timestamp,
      direction: sig.direction,
      session:   sig.session,
      confidence: sig.confidence,
      entry:     sig.entry,
      sl:        sig.sl,
      tp1:       sig.tp1,
      risk:      +(Math.abs(sig.entry - sig.sl)).toFixed(2),
      result:    resolution.result,
      pnl:       resolution.pnl,
      exitBar:   resolution.exitBar,
      htf_bias:  sig.htf_bias,
      indicators: sig.indicators,
      trigger_reason: sig.trigger_reason,
    });
  }

  return buildReport(label, trades);
}

// ── Report builder ────────────────────────────────────────────────────────────
function buildReport(label, trades) {
  const closed = trades.filter(t => t.result !== 'OPEN');
  const wins   = closed.filter(t => t.result === 'WIN');
  const losses = closed.filter(t => t.result === 'LOSS');

  const wr         = closed.length ? (wins.length / closed.length * 100) : 0;
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnl     = closed.reduce((s, t) => s + t.pnl, 0);
  const pf         = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const avgWin     = wins.length   ? grossWin  / wins.length   : 0;
  const avgLoss    = losses.length ? grossLoss / losses.length : 0;
  const avgRisk    = closed.length ? closed.reduce((s, t) => s + t.risk, 0) / closed.length : 0;
  const expectancy = closed.length ? netPnl / closed.length : 0;
  const expectancyR = avgRisk > 0  ? expectancy / avgRisk    : 0;

  // By session
  const bySess = {};
  for (const t of closed) {
    if (!bySess[t.session]) bySess[t.session] = { wins: 0, losses: 0, pnl: 0 };
    const s = bySess[t.session];
    if (t.result === 'WIN') s.wins++;
    else s.losses++;
    s.pnl += t.pnl;
  }

  // By direction
  const byDir = {};
  for (const t of closed) {
    if (!byDir[t.direction]) byDir[t.direction] = { wins: 0, losses: 0, pnl: 0 };
    const d = byDir[t.direction];
    if (t.result === 'WIN') d.wins++;
    else d.losses++;
    d.pnl += t.pnl;
  }

  // By confidence bucket
  const byConf = {};
  for (const t of closed) {
    const bucket = t.confidence >= 90 ? '90+' : t.confidence >= 85 ? '85-89'
      : t.confidence >= 80 ? '80-84' : t.confidence >= 75 ? '75-79' : '70-74';
    if (!byConf[bucket]) byConf[bucket] = { wins: 0, losses: 0, pnl: 0 };
    const c = byConf[bucket];
    if (t.result === 'WIN') c.wins++;
    else c.losses++;
    c.pnl += t.pnl;
  }

  // Max drawdown (running)
  let peak = 0, trough = 0, maxDd = 0, running = 0;
  for (const t of closed) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    label,
    total: trades.length,
    closed: closed.length,
    open: trades.filter(t => t.result === 'OPEN').length,
    wins: wins.length,
    losses: losses.length,
    wr: +wr.toFixed(1),
    pf: +pf.toFixed(2),
    net_pnl: +netPnl.toFixed(1),
    gross_win:  +grossWin.toFixed(1),
    gross_loss: +grossLoss.toFixed(1),
    avg_win:    +avgWin.toFixed(1),
    avg_loss:   +avgLoss.toFixed(1),
    avg_risk:   +avgRisk.toFixed(1),
    expectancy_pts: +expectancy.toFixed(2),
    expectancy_R:   +expectancyR.toFixed(3),
    max_drawdown: +maxDd.toFixed(1),
    by_session:   bySess,
    by_direction: byDir,
    by_confidence: byConf,
    trades: VERBOSE ? trades : undefined,
  };
}

// ── Print report ──────────────────────────────────────────────────────────────
function printReport(r) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${r.label}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Total signals:    ${r.total}  (${r.closed} closed, ${r.open} still open)`);
  console.log(`  Win rate:         ${r.wr}%   (${r.wins}W / ${r.losses}L)`);
  console.log(`  Profit factor:    ${r.pf}`);
  console.log(`  Net PnL:          ${r.net_pnl} pts`);
  console.log(`  Gross win/loss:   +${r.gross_win} / -${r.gross_loss} pts`);
  console.log(`  Avg win/loss:     +${r.avg_win} / -${r.avg_loss} pts`);
  console.log(`  Avg risk:         ${r.avg_risk} pts`);
  console.log(`  Expectancy:       ${r.expectancy_pts} pts  (${r.expectancy_R}R)`);
  console.log(`  Max drawdown:     ${r.max_drawdown} pts`);

  console.log(`\n  By Direction:`);
  for (const [d, s] of Object.entries(r.by_direction)) {
    const t = s.wins + s.losses;
    const w = t ? (s.wins / t * 100).toFixed(0) : 0;
    console.log(`    ${d.padEnd(6)}: ${w}% WR  (${s.wins}W/${s.losses}L)  pnl: ${s.pnl.toFixed(1)}`);
  }

  console.log(`\n  By Session:`);
  for (const [sess, s] of Object.entries(r.by_session).sort((a, b) => (b[1].wins+b[1].losses) - (a[1].wins+a[1].losses))) {
    const t = s.wins + s.losses;
    const w = t ? (s.wins / t * 100).toFixed(0) : 0;
    console.log(`    ${sess.padEnd(22)}: ${w}% WR  (${s.wins}W/${s.losses}L)  pnl: ${s.pnl.toFixed(1)}`);
  }

  console.log(`\n  By Confidence:`);
  for (const [bucket, s] of Object.entries(r.by_confidence).sort((a, b) => b[0].localeCompare(a[0]))) {
    const t = s.wins + s.losses;
    const w = t ? (s.wins / t * 100).toFixed(0) : 0;
    console.log(`    conf ${bucket}: ${w}% WR  (${s.wins}W/${s.losses}L)  pnl: ${s.pnl.toFixed(1)}`);
  }

  if (VERBOSE && r.trades) {
    console.log(`\n  Per-Trade Log:`);
    for (const t of r.trades) {
      if (t.result === 'OPEN') continue;
      const icon = t.result === 'WIN' ? '✓' : '✗';
      console.log(`    ${icon} ${t.timestamp?.slice(0,16)} ${t.direction.padEnd(5)} ${t.session?.padEnd(20)} conf=${t.confidence} pnl=${t.pnl>0?'+':''}${t.pnl}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!AS_JSON) {
    console.log(`\nMNQ INTRADAY BACKTEST — ${DAYS}d lookback`);
    console.log(`Strategies: ${[RUN_V3 ? 'v3.0' : null, RUN_V2 ? 'v4.0' : null].filter(Boolean).join(' vs ')}`);
  }

  const dbPath = findDb();
  const db     = new Database(dbPath, { readonly: true });

  if (!AS_JSON) console.log(`\nLoading bars from ${dbPath}...`);

  let bars5m  = loadBars(db, '5m',  DAYS);
  let bars1h  = loadBars(db, '1h',  DAYS);
  let bars15m = loadBars(db, '15m', DAYS);
  let bars4h  = loadBars(db, '4h',  DAYS);

  // Derive TFs not stored in DB
  if (!bars15m.length && bars5m.length >= 3) {
    bars15m = deriveBars(bars5m, 3);
    if (!AS_JSON) console.log(`  [15m] derived ${bars15m.length} bars from 5m`);
  }
  if (!bars4h.length && bars1h.length >= 4) {
    bars4h = deriveBars(bars1h, 4);
    if (!AS_JSON) console.log(`  [4h] derived ${bars4h.length} bars from 1h`);
  }

  db.close();

  if (bars5m.length < 60) {
    console.error('Not enough 5m bars. Need at least 60. Run mine-backtest-data.js first.');
    process.exit(1);
  }

  const results = [];

  if (RUN_V3) {
    if (!AS_JSON) console.log('\nRunning v3.0...');
    results.push(runBacktest('MNQ Intraday v3.0', evalV3, resetV3, bars5m, bars15m, bars1h, bars4h));
  }

  if (RUN_V2) {
    if (!AS_JSON) console.log('Running v4.0 (V2)...');
    results.push(runBacktest('MNQ Intraday v4.0 (V2)', evalV2, resetV2, bars5m, bars15m, bars1h, bars4h));
  }

  if (AS_JSON) {
    console.log(JSON.stringify(COMPARE ? results : results[0], null, 2));
    return;
  }

  for (const r of results) printReport(r);

  if (COMPARE && results.length === 2) {
    const [v3, v2] = results;
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  V2 vs V3 DELTA');
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Signals:     ${v3.total} → ${v2.total}  (${v2.total >= v3.total ? '+' : ''}${v2.total - v3.total})`);
    console.log(`  Win rate:    ${v3.wr}% → ${v2.wr}%  (${v2.wr >= v3.wr ? '+' : ''}${(v2.wr - v3.wr).toFixed(1)} pp)`);
    console.log(`  PF:          ${v3.pf} → ${v2.pf}`);
    console.log(`  Net PnL:     ${v3.net_pnl} → ${v2.net_pnl} pts  (${v2.net_pnl >= v3.net_pnl ? '+' : ''}${(v2.net_pnl - v3.net_pnl).toFixed(1)})`);
    console.log(`  Expectancy:  ${v3.expectancy_R}R → ${v2.expectancy_R}R`);
    console.log(`  Max DD:      ${v3.max_drawdown} → ${v2.max_drawdown} pts`);
    console.log('');
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
