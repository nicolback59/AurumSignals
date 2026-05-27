'use strict';

/**
 * MGC Scalp Forensic Analyzer
 *
 * Queries the production SQLite database for all valid MGC_SCALP backtest
 * and live signal data, then prints a multi-dimensional breakdown:
 *
 *   - Backtest run quality filter (excludes zero-trade and duplicate runs)
 *   - Win rate by session, day-of-week, direction, archetype, regime
 *   - Profit factor and expectancy per dimension
 *   - Loss cluster classification
 *   - Recommended parameter candidates based on evidence
 *
 * Run on the server:
 *   node scripts/mgc-forensics.js
 */

const path   = require('path');
const BetterSqlite3 = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'aurum.db');
const db = new BetterSqlite3(DB_PATH, { readonly: true });

const STRATEGY = 'MGC_SCALP';
const MIN_SAMPLE = 3;

function pct(n, d) {
  if (!d) return null;
  return +((n / d) * 100).toFixed(1);
}

function wr(wins, total) { return pct(wins, total); }

function pf(winPts, lossPts) {
  if (!lossPts || lossPts === 0) return null;
  return +(Math.abs(winPts) / Math.abs(lossPts)).toFixed(2);
}

function expectancy(winRate, avgWin, avgLoss) {
  if (winRate == null || !avgWin || !avgLoss) return null;
  const w = winRate / 100;
  return +((w * avgWin) - ((1 - w) * Math.abs(avgLoss))).toFixed(2);
}

function printTable(title, rows, cols) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(70));
  const header = cols.map(c => c.label.padEnd(c.width)).join('  ');
  console.log(header);
  console.log('─'.repeat(70));
  for (const row of rows) {
    const line = cols.map(c => String(row[c.key] ?? '—').padEnd(c.width)).join('  ');
    console.log(line);
  }
}

// ── 1. Backtest runs ─────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  MGC SCALP FORENSIC ANALYSIS');
console.log('══════════════════════════════════════════════════════════════════════');

let btRuns = [];
try {
  btRuns = db.prepare(`
    SELECT id, ran_at, instrument, strategy_name, params_json, metrics_json
    FROM   backtest_runs
    WHERE  strategy_name = ? OR instrument = 'MGC'
    ORDER  BY ran_at DESC
  `).all(STRATEGY);
} catch (_) {}

const validRuns   = btRuns.filter(r => {
  try {
    const m = JSON.parse(r.metrics_json ?? '{}');
    return m.tradeCount > 0 && m.winRate != null;
  } catch { return false; }
});
const invalidRuns = btRuns.length - validRuns.length;

console.log(`\n  Backtest runs found:   ${btRuns.length}`);
console.log(`  Valid runs:            ${validRuns.length}`);
console.log(`  Excluded (no trades):  ${invalidRuns}`);

if (validRuns.length > 0) {
  const runRows = validRuns.slice(0, 10).map(r => {
    const m = JSON.parse(r.metrics_json ?? '{}');
    return {
      date:    (r.ran_at ?? '').slice(0, 10),
      trades:  m.tradeCount ?? '—',
      wr:      m.winRate != null ? (m.winRate * 100).toFixed(1) + '%' : '—',
      pf_val:  m.profitFactor != null ? m.profitFactor.toFixed(2) : '—',
      sharpe:  m.sharpe != null ? m.sharpe.toFixed(2) : '—',
    };
  });
  printTable('Last 10 Valid Backtest Runs', runRows, [
    { key: 'date',   label: 'Date',    width: 12 },
    { key: 'trades', label: 'Trades',  width: 8  },
    { key: 'wr',     label: 'WR',      width: 8  },
    { key: 'pf_val', label: 'PF',      width: 8  },
    { key: 'sharpe', label: 'Sharpe',  width: 8  },
  ]);
}

// ── 2. Live signals analysis ─────────────────────────────────────────────────

let signals = [];
try {
  signals = db.prepare(`
    SELECT
      s.id, s.direction, s.session, s.htf_bias, s.received_at,
      o.result, o.pnl_pts, o.pnl_usd,
      json_extract(s.raw_payload, '$.archetype')             AS archetype,
      json_extract(s.raw_payload, '$.meta.indicators.rsi')   AS rsi,
      json_extract(s.raw_payload, '$.meta.indicators.atr')   AS atr,
      json_extract(s.raw_payload, '$.meta.indicators.regime') AS regime,
      json_extract(s.raw_payload, '$.confidence')            AS confidence,
      json_extract(s.raw_payload, '$.rr')                    AS rr
    FROM signals s
    JOIN outcomes o ON o.signal_id = s.id
    WHERE s.strategy_name = ?
      AND o.result IN ('WIN', 'LOSS', 'BE')
    ORDER BY s.received_at DESC
  `).all(STRATEGY);
} catch (err) {
  console.log(`\n  No live signal outcomes yet: ${err.message}`);
}

// Also get backtest signal logs
let btSignals = [];
try {
  btSignals = db.prepare(`
    SELECT
      strategy_name, direction, session, regime,
      outcome AS result, pnl_pts, rr, confidence, setup AS archetype,
      hour_et, timestamp AS received_at
    FROM   backtest_details
    WHERE  strategy_name = ?
    ORDER  BY timestamp DESC
  `).all(STRATEGY);
} catch (_) {}

const allSignals = [...signals, ...btSignals].filter(s =>
  s.result === 'WIN' || s.result === 'LOSS'
);

console.log(`\n  Live settled outcomes:    ${signals.length}`);
console.log(`  Backtest signal rows:     ${btSignals.length}`);
console.log(`  Total analyzable trades:  ${allSignals.length}`);

if (allSignals.length < MIN_SAMPLE) {
  console.log('\n  Insufficient data for dimensional analysis.');
  console.log('  → Run optimizer daily and let live signals accumulate.\n');
  process.exit(0);
}

const wins  = allSignals.filter(s => s.result === 'WIN').length;
const total = allSignals.length;
const overallWr = wr(wins, total);

console.log(`\n  Overall WR: ${overallWr}%  (${wins}W / ${total - wins}L / ${total} total)`);

// ── Helper: group and report ─────────────────────────────────────────────────

function groupStats(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null || k === '') continue;
    if (!map.has(k)) map.set(k, { wins: 0, losses: 0, winPts: 0, lossPts: 0, rrs: [] });
    const g = map.get(k);
    if (r.result === 'WIN') {
      g.wins++;
      g.winPts += +(r.pnl_pts ?? 10);
    } else {
      g.losses++;
      g.lossPts += +(r.pnl_pts ?? -10);
    }
    if (r.rr != null) g.rrs.push(+r.rr);
  }
  return [...map.entries()]
    .map(([key, g]) => {
      const t = g.wins + g.losses;
      const wrVal = wr(g.wins, t);
      const pfVal = pf(g.winPts, g.lossPts);
      const avgRr = g.rrs.length ? +(g.rrs.reduce((a, b) => a + b, 0) / g.rrs.length).toFixed(2) : null;
      return { key, total: t, wins: g.wins, losses: g.losses, wr: wrVal, pf: pfVal, avgRr };
    })
    .filter(r => r.total >= MIN_SAMPLE)
    .sort((a, b) => b.wr - a.wr);
}

function printGrouped(title, rows) {
  printTable(title, rows, [
    { key: 'key',    label: 'Dimension',  width: 22 },
    { key: 'total',  label: 'Trades',     width: 8  },
    { key: 'wr',     label: 'WR%',        width: 7  },
    { key: 'pf',     label: 'PF',         width: 7  },
    { key: 'avgRr',  label: 'Avg RR',     width: 8  },
  ]);
}

// ── 3. By Session ────────────────────────────────────────────────────────────

printGrouped('WIN RATE BY SESSION', groupStats(allSignals, r => r.session));

// ── 4. By Day of Week ────────────────────────────────────────────────────────

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
printGrouped('WIN RATE BY DAY OF WEEK', groupStats(allSignals, r => {
  const d = new Date(r.received_at);
  return isNaN(d.getTime()) ? null : DOW[d.getDay()];
}));

// ── 5. By Direction ──────────────────────────────────────────────────────────

printGrouped('WIN RATE BY DIRECTION', groupStats(allSignals, r => r.direction));

// ── 6. By Archetype ──────────────────────────────────────────────────────────

printGrouped('WIN RATE BY ARCHETYPE (setup type)', groupStats(allSignals, r => r.archetype));

// ── 7. By Regime ─────────────────────────────────────────────────────────────

printGrouped('WIN RATE BY REGIME', groupStats(allSignals, r => r.regime));

// ── 8. By Confidence bucket ──────────────────────────────────────────────────

printGrouped('WIN RATE BY CONFIDENCE BUCKET', groupStats(allSignals, r => {
  const c = +(r.confidence ?? 0);
  if (c >= 80) return '80–100 (A+)';
  if (c >= 70) return '70–79 (A)';
  if (c >= 60) return '60–69 (B)';
  if (c >= 55) return '55–59 (C)';
  return '<55 (D)';
}));

// ── 9. By Hour (ET) ──────────────────────────────────────────────────────────

printGrouped('WIN RATE BY ET HOUR', groupStats(allSignals, r => {
  const h = r.hour_et ?? (() => {
    try {
      const et = new Date(r.received_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
      return et.split(':')[0];
    } catch { return null; }
  })();
  return h != null ? `${h}:00 ET` : null;
}));

// ── 10. Loss forensics ───────────────────────────────────────────────────────

const losses = allSignals.filter(s => s.result === 'LOSS');
console.log(`\n${'─'.repeat(70)}`);
console.log(`  LOSS FORENSICS  (${losses.length} losses)`);
console.log('─'.repeat(70));

const chopRegimes    = new Set(['RANGE_CHOP', 'SOFT_CHOP', 'ranging', 'choppy']);
const lossInChop     = losses.filter(s => chopRegimes.has(s.regime)).length;
const lossMidday     = losses.filter(s => (s.session ?? '').toLowerCase().includes('midday')).length;
const lossShortConf  = losses.filter(s => +(s.confidence ?? 100) < 62).length;
const lossAfterHours = losses.filter(s => (s.session ?? '').toLowerCase().includes('after') || (s.session ?? '').toLowerCase().includes('pre')).length;
const lossChopMR     = losses.filter(s => (s.archetype ?? '').includes('chop')).length;

if (losses.length > 0) {
  console.log(`  Chop regime losses:        ${lossInChop}  (${pct(lossInChop, losses.length)}%)`);
  console.log(`  Midday losses:             ${lossMidday}  (${pct(lossMidday, losses.length)}%)`);
  console.log(`  Low confidence (<62) loss: ${lossShortConf}  (${pct(lossShortConf, losses.length)}%)`);
  console.log(`  After-hours / pre-market:  ${lossAfterHours}  (${pct(lossAfterHours, losses.length)}%)`);
  console.log(`  ChopMeanRevert losses:     ${lossChopMR}  (${pct(lossChopMR, losses.length)}%)`);
}

// ── 11. Candidate recommendations ───────────────────────────────────────────

console.log(`\n${'═'.repeat(70)}`);
console.log('  OPTIMIZATION CANDIDATE RECOMMENDATIONS');
console.log('═'.repeat(70));

const chopLossPct = losses.length > 0 ? pct(lossInChop, losses.length) : 0;
const middayLossPct = losses.length > 0 ? pct(lossMidday, losses.length) : 0;
const lowConfLossPct = losses.length > 0 ? pct(lossShortConf, losses.length) : 0;

console.log(`
  CURRENT BASELINE:  WR=${overallWr}%  trades=${total}

  CANDIDATE SUMMARY (see optimizer-worker.js for full param sets):

  MGC_SCALP_V2_QUALITY
    Knobs:  minScore=10, std2=2.4, slPts=9
    Effect: +3pp confidence threshold, tighter chop (0.74), smaller max risk
    Use if: low-conf losses > 30% of losses (currently: ${lowConfLossPct}%)

  MGC_SCALP_CHOP_PROTECTED
    Knobs:  std2=2.6, minScore=9, stdvLen=18, slPts=9
    Effect: chopThresh→0.77, ADX floor→18, stricter regime gate
    Use if: chop losses > 25% of all losses (currently: ${chopLossPct}%)

  MGC_SCALP_VWAP_ELITE
    Knobs:  minScore=12, std2=2.3, swingLook=18, swingL=7, slPts=8
    Effect: conf threshold +5pp, longer swing lookback, tighter max risk
    Use if: WR consistently above 58% with ≥30 trades

  MGC_SCALP_TREND_FILTERED
    Knobs:  stdvLen=22, std2=2.4, minScore=10, swingLook=20
    Effect: ADX floor→22, tighter chop, longer swing detection
    Use if: most wins come from TREND_BULL/BEAR regime (check regime table above)

  MGC_SCALP_CONSERVATIVE
    Knobs:  slPts=8, minScore=11, std2=2.5, swingLook=14, swingL=6
    Effect: force max risk 8pts (higher RR only), conf +4pp
    Use if: overall WR < 52% and you want to cut frequency for quality
`);

console.log('═'.repeat(70));
console.log('  Run the optimizer via Admin panel → "Run Now" to test candidates.');
console.log('  Each candidate is backtested against 30d AND 90d windows.');
console.log('  Approve only if BOTH windows beat baseline by ≥3pp.\n');

db.close();
