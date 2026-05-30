#!/usr/bin/env node
'use strict';

/**
 * MNQ FIRE — Forensic Rejection Analysis
 *
 * Instruments every candidate setup and logs exactly which filter killed it.
 * Run this to understand WHY the strategy isn't participating more.
 *
 * Usage:
 *   node scripts/mnq-fire-forensic.js --days 90
 *   node scripts/mnq-fire-forensic.js --days 180 --variant CORE
 *   node scripts/mnq-fire-forensic.js --verbose   # show per-rejection detail
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const {
  computeAllPools, checkSweep, findFVG, isDisplacement, detectChoCH, scoreChecklist,
  VARIANT_CFG,
} = require('../strategies/mnq-fire');

// ── Re-import private helpers we need ────────────────────────────────────────
// (These are identical to the ones in mnq-fire.js — forensic script needs direct access)
const { calcAtr, calcVwap, calcHtfBias, detectMarketStructure } = require('../strategies/shared-indicators');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const daysIdx = argv.indexOf('--days');
const DAYS    = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) || 90 : 90;
const varIdx  = argv.indexOf('--variant');
const VARIANT = varIdx >= 0 ? argv[varIdx + 1].toUpperCase() : 'CORE';
const symIdx  = argv.indexOf('--symbol');
const SYMBOL  = symIdx >= 0 ? argv[symIdx + 1] : null;

// ── DB + bar loader ───────────────────────────────────────────────────────────
function findDb() {
  const envPath = process.env.DATABASE_URL?.replace('sqlite://', '') || process.env.DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of [
    path.join(__dirname, '..', 'aurum.db'),
    path.join(__dirname, '..', 'aurumsignals.db'),
    '/root/AurumSignals/aurum.db',
    '/root/AurumSignals/signals.db',
  ]) { if (fs.existsSync(p)) return p; }
  throw new Error('Cannot find SQLite DB. Set DATABASE_URL=sqlite://path/to/aurum.db');
}

function loadBars(db, interval, daysBack) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const candidates = SYMBOL ? [SYMBOL] : ['MNQ1!', 'MNQ', 'NQ=F', '@MNQ'];
  for (const sym of candidates) {
    const rows = db.prepare(
      'SELECT timestamp, open, high, low, close, volume FROM historical_bars WHERE symbol=? AND interval=? AND timestamp>=? ORDER BY timestamp ASC'
    ).all(sym, interval, cutoff);
    if (rows.length >= 10) { console.log(`  [${interval}] ${sym}: ${rows.length} bars`); return rows; }
  }
  console.log(`  [${interval}] no bars found`); return [];
}

// ── ET helper ─────────────────────────────────────────────────────────────────
function getET(ts) {
  const d = new Date(ts);
  try {
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = et.getHours(), m = et.getMinutes();
    return { h, m, hm: h * 100 + m, dow: et.getDay(),
             dateKey: `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}` };
  } catch {
    const h = ((d.getUTCHours() - 4) + 24) % 24;
    return { h, m: d.getUTCMinutes(), hm: h*100+d.getUTCMinutes(), dow: d.getUTCDay(), dateKey: d.toISOString().slice(0,10) };
  }
}

// ── Rejection reason codes ────────────────────────────────────────────────────
const REASONS = {
  NO_SWEEP:              'No valid liquidity sweep in scan window',
  WICK_DOMINANCE:        'Sweep wick < 35% of bar range (noise wick)',
  NO_DISPLACEMENT:       'Sweep found but no displacement candle in next 3 bars',
  DISP_CLOSE_WEAK:       'Displacement body OK but close not in bottom/top 30% of range',
  NO_FVG:                'Displacement OK but no FVG created',
  NO_CHOCH:              'Displacement OK, no CHoCH on current bar or prior 3 bars',
  NO_FVG_TOUCH:          'CHoCH confirmed but price did not reach FVG zone',
  MARKET_WEAK_CHOCH:     'Weak CHoCH (disp-as-CHoCH) — market entry blocked by strongChochOnly',
  SCORE_TOO_LOW:         'All conditions met but checklist score < minScore',
  NO_CLEAN_ROOM:         'TP1 path blocked by opposing liquidity pool',
  SHORT_SKIP_MODE:       'Short skipped — LONG_ONLY variant',
  SHORT_4H_BULL:         'Short blocked — 4H bias is bullish (main short killer)',
  SHORT_1H_BULL_LOW_POS: 'Short blocked — 1H bullish but entry not high enough in overnight range',
  ATR_TOO_LOW:           'ATR below variant minimum threshold',
  SESSION_CAP:           'Daily signal cap reached for this session',
  MIN_GAP:               'Too soon after last signal (< 15 min gap)',
};

// ── Formatting ────────────────────────────────────────────────────────────────
function pad(s, w) { return String(s ?? '').padEnd(w); }
function sep(w = 72) { return '─'.repeat(w); }
function pct(n, total) { return total ? ((n/total)*100).toFixed(1)+'%' : '—'; }

// ── Main forensic backtest ────────────────────────────────────────────────────
function runForensic(bars5m, bars1h, bars4h, barsDly, variant, variantKey) {
  const rejections = {};
  for (const k of Object.keys(REASONS)) rejections[k] = { count: 0, examples: [] };

  let totalBarChecks    = 0;
  let sweepCandidates   = 0;
  let dispCandidates    = 0;
  let chochCandidates   = 0;
  let entryCandidates   = 0;
  let scorePassed       = 0;
  let signalsEmitted    = 0;

  // Per-rejection detail log (for --verbose)
  const rejectDetail = [];

  function logReject(reason, ctx) {
    rejections[reason].count++;
    const ex = `${ctx.dateKey} ${String(ctx.hm).padStart(4,'0')} | ${ctx.direction ?? '?'} | pool=${ctx.pool ?? '?'} | score=${ctx.score ?? '?'}`;
    if (rejections[reason].examples.length < 5) rejections[reason].examples.push(ex);
    if (VERBOSE) rejectDetail.push({ reason, ...ctx });
  }

  // Group by day
  const dayMap = new Map();
  for (const bar of bars5m) {
    const { dateKey } = getET(bar.timestamp);
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey).push(bar);
  }

  for (const dateKey of [...dayMap.keys()].sort()) {
    const dayBars = dayMap.get(dateKey);
    if (!dayBars || dayBars.length < 10) continue;
    const { dow } = getET(dayBars[0].timestamp);
    if (dow === 0 || dow === 6) continue;

    const cutoff    = dayBars[0].timestamp;
    const h1Slice   = bars1h  ? bars1h.filter(b  => b.timestamp < cutoff) : [];
    const h4Slice   = bars4h  ? bars4h.filter(b  => b.timestamp < cutoff) : [];
    const dlySlice  = barsDly ? barsDly.filter(b => b.timestamp < cutoff) : [];
    const preBars5m = bars5m.filter(b => b.timestamp < cutoff).slice(-200);

    const orbBars = dayBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 940; });
    const orbHigh = orbBars.length >= 2 ? Math.max(...orbBars.map(b => b.high)) : null;
    const orbLow  = orbBars.length >= 2 ? Math.min(...orbBars.map(b => b.low))  : null;

    let dayNyCount = 0, dayPhCount = 0, dayLondonCount = 0, lastSigHm = -1;

    // All potential entry bars across all sessions this variant allows
    const entryBars = dayBars.filter(b => {
      const e = getET(b.timestamp);
      const inNYw = e.hm >= 944 && e.hm < 1030;
      const inPHw = e.hm >= 1500 && e.hm < 1610 && variant.allowPowerHour;
      const inLdw = e.hm >= 345  && e.hm < 530  && variant.allowLondon;
      return inNYw || inPHw || inLdw;
    });

    for (const bar of entryBars) {
      const et = getET(bar.timestamp);
      const isNY = et.hm >= 944 && et.hm < 1030;
      const isPH = et.hm >= 1500 && et.hm < 1610;
      const isLd = et.hm >= 345  && et.hm < 530;

      // Session cap
      if (isNY && dayNyCount     >= (variant.maxNyTrades     ?? 1)) { logReject('SESSION_CAP', { dateKey, hm: et.hm, direction: null, pool: null, score: null }); continue; }
      if (isPH && dayPhCount     >= (variant.maxPhTrades     ?? 1)) { logReject('SESSION_CAP', { dateKey, hm: et.hm, direction: null, pool: null, score: null }); continue; }
      if (isLd && dayLondonCount >= (variant.maxLondonTrades ?? 1)) { logReject('SESSION_CAP', { dateKey, hm: et.hm, direction: null, pool: null, score: null }); continue; }
      if (lastSigHm >= 0 && et.hm - lastSigHm >= 0 && et.hm - lastSigHm < 15) { logReject('MIN_GAP', { dateKey, hm: et.hm, direction: null, pool: null, score: null }); continue; }

      totalBarChecks++;

      const allBars = [...preBars5m, ...dayBars.slice(0, dayBars.indexOf(bar) + 1)];
      if (allBars.length < 30) continue;

      const atrArr = calcAtr(allBars, 14);
      const atr    = atrArr[atrArr.length - 1];
      if (!atr || atr < variant.atrMin) { logReject('ATR_TOO_LOW', { dateKey, hm: et.hm, direction: null, pool: null, score: null }); continue; }

      const pools  = computeAllPools(allBars, dlySlice, orbHigh, orbLow);
      if (!pools.length) continue;

      const scanBars  = allBars.slice(Math.max(0, allBars.length - 12));
      const curBar    = scanBars[scanBars.length - 1];

      const sweepWindowOk = (b) => {
        const e = getET(b.timestamp);
        if (isNY) return e.hm >= 930 && e.hm < 1020;
        if (isPH) return e.hm >= 1500 && e.hm < 1605;
        if (isLd) return e.hm >= 300  && e.hm < 520;
        return false;
      };

      let foundAnySweep = false;

      for (let si = 0; si < scanBars.length - 2; si++) {
        const sweepBar = scanBars[si];
        if (!sweepWindowOk(sweepBar) || sweepBar.timestamp >= curBar.timestamp) continue;

        // Raw pool proximity check — did the bar breach any pool level at all?
        const hasProximity = pools.some(p =>
          (p.side === 'BSL' && sweepBar.high > p.level && sweepBar.close < p.level) ||
          (p.side === 'SSL' && sweepBar.low  < p.level && sweepBar.close > p.level)
        );
        if (!hasProximity) continue;

        // Now apply the wick dominance gate
        const sweep = checkSweep(sweepBar, pools, atr);
        if (!sweep) {
          logReject('WICK_DOMINANCE', { dateKey, hm: et.hm, direction: null, pool: '?', score: null });
          foundAnySweep = true;
          continue;
        }

        foundAnySweep = true;
        sweepCandidates++;
        const ctx = { dateKey, hm: et.hm, direction: sweep.direction, pool: sweep.pool, score: null };

        // Displacement
        let disp = null, fvg = null;
        for (let di = si + 1; di < Math.min(si + 4, scanBars.length - 1); di++) {
          if (isDisplacement(scanBars[di], atr, sweep.direction)) {
            disp = scanBars[di];
            fvg  = findFVG(scanBars.slice(Math.max(0, di - 1), di + 3), sweep.direction, 5);
            break;
          }
        }
        if (!disp) {
          logReject('NO_DISPLACEMENT', ctx);
          continue;
        }
        dispCandidates++;

        // CHoCH (primary + delayed FVG fill)
        const isBull    = sweep.direction === 'LONG';
        const windowBars = scanBars.slice(si, scanBars.length - 1);
        let choch = detectChoCH(windowBars, curBar, sweep.direction, atr);
        let isDelayedFvg = false;

        if (!choch && fvg) {
          const nowInFvg = isBull ? curBar.low <= fvg.high + 0.20 * atr : curBar.high >= fvg.low - 0.20 * atr;
          if (nowInFvg) {
            for (let back = 1; back <= 3; back++) {
              const priorIdx = scanBars.length - 1 - back;
              if (priorIdx <= si) break;
              const pw = scanBars.slice(si, priorIdx);
              if (!pw.length) break;
              choch = detectChoCH(pw, scanBars[priorIdx], sweep.direction, atr);
              if (choch) { isDelayedFvg = true; break; }
            }
          }
        }
        if (!choch) { logReject('NO_CHOCH', ctx); continue; }
        chochCandidates++;

        // Entry
        let entry, isFvgEntry = false;
        if (fvg) {
          const inZone = isDelayedFvg || (isBull
            ? curBar.low  <= fvg.high + 0.20 * atr && curBar.close >= fvg.low
            : curBar.high >= fvg.low  - 0.20 * atr && curBar.close <= fvg.high);
          if (inZone) { entry = +fvg.mid.toFixed(2); isFvgEntry = true; }
          else { logReject('NO_FVG_TOUCH', { ...ctx, fvgPresent: true }); }
        } else {
          logReject('NO_FVG', ctx);
        }
        if (!entry) {
          if (!variant.marketEntry) continue;
          if (variant.strongChochOnly && choch.isDispChoCH) { logReject('MARKET_WEAK_CHOCH', ctx); continue; }
          entry = +curBar.close.toFixed(2);
        }
        entryCandidates++;

        // Short quality gate
        if (sweep.direction === 'SHORT') {
          if (variant.skipShorts) { logReject('SHORT_SKIP_MODE', ctx); continue; }
          const ema4h = h4Slice.length >= 5  ? calcHtfBias(h4Slice, 9, 21) : 0;
          const ema1h = h1Slice.length >= 21 ? calcHtfBias(h1Slice, 9, 21) : 0;
          if (ema4h > 0) { logReject('SHORT_4H_BULL', ctx); continue; }
          if (ema1h > 0) {
            const onBars = allBars.filter(b => { const e = getET(b.timestamp); return e.hm < 930 || e.hm >= 1600; });
            if (onBars.length >= 3) {
              const onH = Math.max(...onBars.map(b => b.high));
              const onL = Math.min(...onBars.map(b => b.low));
              const onRange = onH - onL;
              const onPos = onRange > 0 ? (entry - onL) / onRange : 0.5;
              if (onPos < 0.65) { logReject('SHORT_1H_BULL_LOW_POS', ctx); continue; }
            }
          }
        }

        // Checklist
        const vwapSrc  = allBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930; });
        const vwapArr  = calcAtr(vwapSrc.length >= 2 ? vwapSrc : allBars, 14); // placeholder — VWAP not exported
        const b1Bias   = h1Slice.length >= 21 ? calcHtfBias(h1Slice, 9, 21) : 0;
        const b4Bias   = h4Slice.length >= 5  ? calcHtfBias(h4Slice, 9, 21) : 0;
        const biasAligned = (isBull && b4Bias >= 0) || (!isBull && b4Bias <= 0);
        const htfAligned  = (isBull && b1Bias >= 0) || (!isBull && b1Bias <= 0);
        // vwapAligned approximation — treat as true if entry direction matches bias
        const vwapAligned = biasAligned;

        const rawRisk = Math.max(8, Math.min(variant.maxStop ?? 35, Math.abs(entry - (isBull ? sweep.sweepExtreme - 3 : sweep.sweepExtreme + 3))));
        const tp1 = isBull ? entry + 1.5 * rawRisk : entry - 1.5 * rawRisk;
        const cleanPath = !pools.some(p => {
          if (isBull  && p.level > entry && p.level < tp1 && Math.abs(p.level - entry) < 0.55 * Math.abs(tp1 - entry)) return true;
          if (!isBull && p.level < entry && p.level > tp1 && Math.abs(p.level - entry) < 0.55 * Math.abs(tp1 - entry)) return true;
          return false;
        });
        if (!cleanPath) { logReject('NO_CLEAN_ROOM', ctx); continue; }

        const score = scoreChecklist({
          poolTier: sweep.poolTier, sweepWick: true, displacement: true,
          choch: !choch.isDispChoCH, fvg: fvg != null, biasAligned, vwapAligned,
          htfAligned, cleanRoom: true, fvgEntry: isFvgEntry,
        });
        ctx.score = score;

        if (score < (variant.minScore ?? 7)) {
          logReject('SCORE_TOO_LOW', ctx);
          continue;
        }
        scorePassed++;

        // Signal emitted
        signalsEmitted++;
        if (isNY) dayNyCount++;
        else if (isPH) dayPhCount++;
        else dayLondonCount++;
        lastSigHm = et.hm;
        break; // only one signal per bar
      }

      if (!foundAnySweep) logReject('NO_SWEEP', { dateKey, hm: et.hm, direction: null, pool: null, score: null });
    }
  }

  return { rejections, totalBarChecks, sweepCandidates, dispCandidates,
           chochCandidates, entryCandidates, scorePassed, signalsEmitted, rejectDetail };
}

// ── Print report ──────────────────────────────────────────────────────────────
function printForensicReport(result, variantKey, days) {
  const { rejections, totalBarChecks, sweepCandidates, dispCandidates,
          chochCandidates, entryCandidates, scorePassed, signalsEmitted } = result;

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  MNQ FIRE FORENSIC — ${variantKey} — ${days} days`);
  console.log(`${'═'.repeat(72)}`);

  console.log(`\n  ── Filter Funnel ─────────────────────────────────────────────────────`);
  console.log(`  Total bar checks:          ${totalBarChecks}`);
  console.log(`  Sweeps detected:           ${sweepCandidates}  (${pct(sweepCandidates, totalBarChecks)} pass rate)`);
  console.log(`  + Displacement confirmed:  ${dispCandidates}  (${pct(dispCandidates, sweepCandidates)} of sweeps)`);
  console.log(`  + CHoCH confirmed:         ${chochCandidates}  (${pct(chochCandidates, dispCandidates)} of displacements)`);
  console.log(`  + Valid entry found:       ${entryCandidates}  (${pct(entryCandidates, chochCandidates)} of CHoCHs)`);
  console.log(`  + Score passed:            ${scorePassed}  (${pct(scorePassed, entryCandidates)} of entries)`);
  console.log(`  = Signals emitted:         ${signalsEmitted}  (${(signalsEmitted / (days/30)).toFixed(1)}/month)`);

  console.log(`\n  ── Top Rejection Reasons (ranked by frequency) ───────────────────────`);
  console.log(sep());
  console.log(`${pad('Reason Code', 30)}  ${pad('Count', 7)}  ${pad('% of checks', 12)}  Description`);
  console.log(sep());

  const sorted = Object.entries(rejections)
    .filter(([, v]) => v.count > 0)
    .sort(([, a], [, b]) => b.count - a.count);

  for (const [code, data] of sorted) {
    console.log(`${pad(code, 30)}  ${pad(data.count, 7)}  ${pad(pct(data.count, totalBarChecks), 12)}  ${REASONS[code] ?? code}`);
    if (data.examples.length && VERBOSE) {
      for (const ex of data.examples) console.log(`    └ ${ex}`);
    }
  }

  console.log(`\n  ── Key Insights ──────────────────────────────────────────────────────`);

  const topKiller = sorted[0];
  if (topKiller) {
    console.log(`  #1 KILLER: ${topKiller[0]} (${topKiller[1].count} rejections = ${pct(topKiller[1].count, totalBarChecks)} of all checks)`);
    console.log(`     → ${REASONS[topKiller[0]]}`);
  }

  // Short-specific insight
  const shortKills = (rejections.SHORT_4H_BULL?.count ?? 0) + (rejections.SHORT_1H_BULL_LOW_POS?.count ?? 0);
  if (shortKills > 0) {
    console.log(`  SHORT KILLS: ${shortKills} total (${pct(shortKills, totalBarChecks)}) — 4H bull gate alone: ${rejections.SHORT_4H_BULL?.count ?? 0}`);
  }

  // Displacement pass rate
  if (sweepCandidates > 0) {
    const dispRate = (dispCandidates / sweepCandidates * 100).toFixed(1);
    if (parseFloat(dispRate) < 30) {
      console.log(`  LOW DISP RATE (${dispRate}%): displacement close-strength filter may be too aggressive`);
    }
  }

  // CHoCH pass rate
  if (dispCandidates > 0) {
    const chochRate = (chochCandidates / dispCandidates * 100).toFixed(1);
    if (parseFloat(chochRate) < 40) {
      console.log(`  LOW CHoCH RATE (${chochRate}%): CHoCH gate is the main frequency bottleneck`);
    }
  }

  // Score distribution of near-misses
  const scoreLow = rejections.SCORE_TOO_LOW?.count ?? 0;
  if (scoreLow > 0) {
    console.log(`  SCORE NEAR-MISSES: ${scoreLow} setups had everything right but score too low`);
    const examples = rejections.SCORE_TOO_LOW?.examples ?? [];
    examples.slice(0, 3).forEach(e => console.log(`    └ ${e}`));
  }

  console.log(`\n${sep()}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
let dbPath;
try { dbPath = findDb(); } catch(e) { console.error(`\n[forensic] ERROR: ${e.message}\n`); process.exit(1); }

console.log(`\n[forensic] MNQ FIRE Rejection Analyzer`);
console.log(`[forensic] DB: ${dbPath}`);
console.log(`[forensic] Lookback: ${DAYS} days | Variant: ${VARIANT}\n`);
console.log('[forensic] Loading bars...');

const db = new Database(dbPath, { readonly: true });
const bars5m  = loadBars(db, '5m',  DAYS);
const bars1h  = loadBars(db, '1h',  DAYS + 7);
const bars4h  = loadBars(db, '4h',  DAYS + 14);
const barsDly = loadBars(db, '1d',  DAYS + 7);
db.close();

if (bars5m.length < 10) { console.error('[forensic] ERROR: insufficient 5m bars'); process.exit(1); }

const variant = VARIANT_CFG[VARIANT] ?? VARIANT_CFG.CORE;
console.log('\n[forensic] Running forensic analysis...\n');
const result = runForensic(bars5m, bars1h, bars4h, barsDly, variant, VARIANT);
printForensicReport(result, VARIANT, DAYS);

if (VERBOSE && result.rejectDetail.length) {
  console.log(`\n  ── Per-Rejection Detail (first 50) ───────────────────────────────────`);
  for (const r of result.rejectDetail.slice(0, 50)) {
    console.log(`  ${r.dateKey} ${String(r.hm).padStart(4,'0')} | ${pad(r.reason, 25)} | ${r.direction ?? '?'} | pool=${r.pool ?? '?'} | score=${r.score ?? '?'}`);
  }
}

process.exit(0);
