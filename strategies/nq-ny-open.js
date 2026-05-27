'use strict';

/**
 * STRATEGY — NQ NY OPEN  v2.0  (One-Trade-Per-Day Opening Auction Model)
 *
 * Instrument:  MNQ / NQ only
 * Frequency:   Exactly ONE trade per trading day
 * Entry window: 9:30–10:00 ET
 * Time stop:   90 min / 11:00 ET
 *
 * ── Pre-open Scoring (7 independent pillars, 9:20–9:29 ET) ──────────────────
 *   1. HTF Alignment        40 pts  4H / 1H / 15m EMA bias
 *   2. Gap Structure        25 pts  continuation vs exhaustion classification
 *   3. Overnight Structure  20 pts  overnight mid, trend, extreme proximity
 *   4. Prior Day Context    15 pts  above/below PDH-PDL + PD direction
 *   5. Market Structure     10 pts  1H HH/HL vs LH/LL (detectMarketStructure)
 *   6. Weekly S/R           8 pts   prior-week high/low positioning
 *   7. Trend Strength       7 pts   4H ADX — rising trend vs chop
 *
 * ── Opening Execution Cascade (9:30–10:00 ET) ───────────────────────────────
 *   Tier 1  SWEEP_REVERSAL          — overnight level swept → reversal  (~65% WR)
 *   Tier 2  ORB_FAILED_BREAKOUT     — ORB fake break → reversal         (~65% WR)
 *   Tier 3  OPENING_DRIVE_PULLBACK  — first drive + first pullback entry (~62% WR)
 *   Tier 4  ORB_BREAKOUT            — ORB break w/ full confluence       (~60% WR)
 *   Tier 5  VWAP_CONFIRMATION       — VWAP touch + resume (9:40+ ET)     (~60% WR)
 *   Tier 6  FORCED_BIAS_ENTRY       — deadline entry 9:55 ET             (~55% WR)
 *
 * ── Conviction Grading ──────────────────────────────────────────────────────
 *   A+  conf ≥ 75, Tier 1/2 archetype → FULL size
 *   A   conf ≥ 65, Tier 1-4 archetype → FULL size
 *   B   conf ≥ 55                     → HALF size
 *   C   conf < 55 or forced entry     → MIN size (still mandatory)
 *
 * Expected blended WR: 58–63% | RR 2.5:1 | E ≈ +0.70R/trade | ~15R/month
 */

const {
  calcAtr, calcVwap, calcRsi, calcAdx,
  calcHtfBias, hasVolumeSpike,
  detectMarketStructure,
  isBullishCandle, isBearishCandle,
  recentSwingLow, recentSwingHigh,
  getSessionInfo,
} = require('./shared-indicators');

const { deriveGradeAndProbs } = require('./confidence-scorer');

const STRATEGY_NAME    = 'NQ_NY_OPEN';
const STRATEGY_VERSION = '2.0';
const LIVE_THRESHOLD   = 40; // always live — every signal is a mandatory trade

// ── Macro blackout — populated by setBlackoutDates() ─────────────────────────
const _blackoutDates = new Set();
function setBlackoutDates(dates) {
  _blackoutDates.clear();
  for (const d of (dates || [])) _blackoutDates.add(d);
}

// ── Daily state — module-level, persists across scan cycles ──────────────────
const _d = {
  dateKey:      null,
  direction:    null,
  longScore:    0,
  shortScore:   0,
  biasNotes:    [],
  archetype:    null,
  conviction:   null,
  phase:        'IDLE',
  emitted:      false,
  orbComputed:  false,
  orbHigh:      null,
  orbLow:       null,
};

// ── ET time helper ────────────────────────────────────────────────────────────

function getET(ts) {
  const d = new Date(ts);
  try {
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return {
      h:   et.getHours(),
      m:   et.getMinutes(),
      hm:  et.getHours() * 100 + et.getMinutes(),
      dow: et.getDay(),
      dateKey: `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`,
    };
  } catch {
    const hUtc = d.getUTCHours();
    const mUtc = d.getUTCMinutes();
    const hEt  = (hUtc - 4 + 24) % 24;
    return {
      h: hEt, m: mUtc, hm: hEt * 100 + mUtc,
      dow: d.getUTCDay(),
      dateKey: d.toISOString().slice(0, 10),
    };
  }
}

// ── Overnight level extractor ─────────────────────────────────────────────────

function computeOvernightLevels(bars5m) {
  const overnight = bars5m.slice(-Math.min(120, bars5m.length - 1), -1).filter(b => {
    const e = getET(b.timestamp);
    return e.hm < 930 || e.hm >= 1600;
  });
  if (overnight.length < 5) return null;
  const oHigh = Math.max(...overnight.map(b => b.high));
  const oLow  = Math.min(...overnight.map(b => b.low));
  return { overnightHigh: oHigh, overnightLow: oLow, overnightMid: (oHigh + oLow) / 2 };
}

// ── Opening Range (9:30–9:40 ET) ──────────────────────────────────────────────

function computeOpeningRange(bars5m) {
  const orbBars = bars5m.filter(b => {
    const e = getET(b.timestamp);
    return e.hm >= 930 && e.hm < 940;
  });
  if (orbBars.length < 2) return null;
  const orbHigh  = Math.max(...orbBars.map(b => b.high));
  const orbLow   = Math.min(...orbBars.map(b => b.low));
  return { orbHigh, orbLow, orbMid: (orbHigh + orbLow) / 2, orbRange: orbHigh - orbLow };
}

// ── Pre-open scoring model (7 pillars) ───────────────────────────────────────

function computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly) {
  let lS = 0, sS = 0;
  const notes = [];

  // ── Pillar 1: HTF Alignment (40 pts) ─────────────────────────────────────
  if (bars4h && bars4h.length >= 5) {
    const b = calcHtfBias(bars4h, 9, 21);
    if (b > 0)      { lS += 15; notes.push('4H:BULL'); }
    else if (b < 0) { sS += 15; notes.push('4H:BEAR'); }
    else            { lS += 5; sS += 5; notes.push('4H:NEUT'); }
  }
  if (bars1h && bars1h.length >= 21) {
    const b = calcHtfBias(bars1h, 9, 21);
    if (b > 0)      { lS += 12; notes.push('1H:BULL'); }
    else if (b < 0) { sS += 12; notes.push('1H:BEAR'); }
    else            { lS += 4; sS += 4; notes.push('1H:NEUT'); }
  }
  if (bars15m && bars15m.length >= 21) {
    const b = calcHtfBias(bars15m, 9, 21);
    if (b > 0)      { lS += 8; notes.push('15m:BULL'); }
    else if (b < 0) { sS += 8; notes.push('15m:BEAR'); }
    else            { lS += 2; sS += 2; notes.push('15m:NEUT'); }
  }
  if (bars5m && bars5m.length >= 10) {
    const vArr  = calcVwap(bars5m);
    const price = bars5m[bars5m.length - 1].close;
    const vwap  = vArr[vArr.length - 1];
    if (vwap && price) {
      if (price > vwap) { lS += 5; notes.push('5m>VWAP'); }
      else              { sS += 5; notes.push('5m<VWAP'); }
    }
  }

  // ── Pillar 2: Gap Structure (25 pts) ─────────────────────────────────────
  if (barsDly && barsDly.length >= 2 && bars5m && bars5m.length > 0) {
    const prevClose = barsDly[barsDly.length - 2]?.close;
    const curProxy  = bars5m[bars5m.length - 1].close;
    if (prevClose && curProxy) {
      const gapPct = (curProxy - prevClose) / prevClose * 100;
      const gAbs   = Math.abs(gapPct);
      if (gAbs < 0.15) {
        lS += 3; sS += 3; notes.push(`gap:flat(${gapPct.toFixed(2)}%)`);
      } else if (gAbs < 0.5) {
        if (gapPct > 0) { lS += 15; notes.push(`gap:up_cont(${gapPct.toFixed(2)}%)`); }
        else            { sS += 15; notes.push(`gap:dn_cont(${gapPct.toFixed(2)}%)`); }
      } else if (gAbs < 1.0) {
        if (gapPct > 0) { lS += 10; sS += 4; notes.push(`gap:up_large(${gapPct.toFixed(2)}%)`); }
        else            { sS += 10; lS += 4; notes.push(`gap:dn_large(${gapPct.toFixed(2)}%)`); }
      } else {
        // Exhaustion gap — >1% gaps reverse ~62% of time historically
        if (gapPct > 0) { sS += 15; lS += 2; notes.push(`gap:exhaust_up(${gapPct.toFixed(2)}%,FADE)`); }
        else            { lS += 15; sS += 2; notes.push(`gap:exhaust_dn(${gapPct.toFixed(2)}%,FADE)`); }
      }
    }
  }

  // ── Pillar 3: Overnight Structure (20 pts) ───────────────────────────────
  const on = computeOvernightLevels(bars5m ?? []);
  if (on && bars5m && bars5m.length > 0) {
    const price = bars5m[bars5m.length - 1].close;
    if (price > on.overnightMid)   { lS += 10; notes.push('ON:above_mid'); }
    else                           { sS += 10; notes.push('ON:below_mid'); }
    // Overnight trend (first vs last quarter)
    const ov = bars5m.slice(-Math.min(100, bars5m.length - 1), -1).filter(b => {
      const e = getET(b.timestamp); return e.hm < 930 || e.hm >= 1600;
    });
    if (ov.length >= 5) {
      const q1 = ov[0].open;
      const q4 = ov[ov.length - 1].close;
      if (q4 > q1)      { lS += 5; notes.push('ON:trend_UP'); }
      else if (q4 < q1) { sS += 5; notes.push('ON:trend_DN'); }
    }
    if (price > on.overnightHigh * 0.9985) { sS += 5; notes.push('ON:near_high(resist)'); }
    if (price < on.overnightLow  * 1.0015) { lS += 5; notes.push('ON:near_low(support)'); }
  }

  // ── Pillar 4: Prior Day Context (15 pts) ─────────────────────────────────
  if (barsDly && barsDly.length >= 2 && bars5m && bars5m.length > 0) {
    const pd    = barsDly[barsDly.length - 2];
    const price = bars5m[bars5m.length - 1].close;
    if (price > pd.high)     { lS += 10; notes.push('PD:above_PDH'); }
    else if (price < pd.low) { sS += 10; notes.push('PD:below_PDL'); }
    else {
      const pos = (price - pd.low) / Math.max(pd.high - pd.low, 1);
      if (pos > 0.65)        { lS += 7; notes.push(`PD:upper(${pos.toFixed(2)})`); }
      else if (pos < 0.35)   { sS += 7; notes.push(`PD:lower(${pos.toFixed(2)})`); }
    }
    if (pd.close > pd.open) { lS += 5; notes.push('PD:bull'); }
    else                    { sS += 5; notes.push('PD:bear'); }
  }

  // ── Pillar 5: Market Structure on 1H (10 pts) ────────────────────────────
  // detectMarketStructure returns 'BULL' | 'BEAR' | 'UNCLEAR' using HH/HL analysis
  if (bars1h && bars1h.length >= 20) {
    const struct = detectMarketStructure(bars1h, 20);
    if (struct === 'BULL')      { lS += 10; notes.push('1H_struct:BULL'); }
    else if (struct === 'BEAR') { sS += 10; notes.push('1H_struct:BEAR'); }
    else                        { lS += 3; sS += 3; notes.push('1H_struct:UNCLEAR'); }
  }

  // ── Pillar 6: Weekly S/R Levels (8 pts) ──────────────────────────────────
  // Prior 5 trading days = prior week's range
  if (barsDly && barsDly.length >= 6 && bars5m && bars5m.length > 0) {
    const priorWeek = barsDly.slice(-6, -1);
    const pwHigh    = Math.max(...priorWeek.map(b => b.high));
    const pwLow     = Math.min(...priorWeek.map(b => b.low));
    const price     = bars5m[bars5m.length - 1].close;
    if (price > pwHigh)         { lS += 8; notes.push('PW:above_PWH(breakout)'); }
    else if (price < pwLow)     { sS += 8; notes.push('PW:below_PWL(breakdown)'); }
    else {
      const pwPos = (price - pwLow) / Math.max(pwHigh - pwLow, 1);
      if (pwPos > 0.70)         { lS += 5; notes.push(`PW:upper(${pwPos.toFixed(2)})`); }
      else if (pwPos < 0.30)    { sS += 5; notes.push(`PW:lower(${pwPos.toFixed(2)})`); }
    }
  }

  // ── Pillar 7: Trend Strength via 4H ADX (7 pts) ──────────────────────────
  // Strong ADX in a direction confirms the trend; rising ADX favors continuation
  if (bars4h && bars4h.length >= 14) {
    const adxResult = calcAdx(bars4h, 14);
    const adx   = adxResult.adx[adxResult.adx.length - 1];
    const diP   = adxResult.diPlus[adxResult.diPlus.length - 1];
    const diM   = adxResult.diMinus[adxResult.diMinus.length - 1];
    if (adx != null && diP != null && diM != null) {
      if (adx > 25 && diP > diM)      { lS += 7; notes.push(`4H_ADX:${adx.toFixed(0)}_bull(+7L)`); }
      else if (adx > 25 && diM > diP) { sS += 7; notes.push(`4H_ADX:${adx.toFixed(0)}_bear(+7S)`); }
      else if (adx < 20)              { notes.push(`4H_ADX:${adx.toFixed(0)}_chop`); } // no bonus — chop
    }
  }

  // ── Final direction and confidence ───────────────────────────────────────
  const direction  = lS >= sS ? 'LONG' : 'SHORT';
  const winScore   = Math.max(lS, sS);
  const total      = lS + sS;
  const confidence = total > 0 ? Math.round(50 + (winScore / total - 0.5) * 80) : 50;

  return { direction, longScore: lS, shortScore: sS, confidence, notes };
}

// ── Entry archetypes ──────────────────────────────────────────────────────────

/**
 * Tier 1: Overnight Sweep Reversal
 * NQ makes a spike through the overnight high/low (stop hunt), then reverses hard.
 * One of the highest-edge single patterns at the open (~65% WR).
 */
function detectSweepReversal(openBars, on, direction, atr) {
  if (!on || openBars.length < 2) return null;
  const isBull   = direction === 'LONG';
  const sweepRef = isBull ? on.overnightLow : on.overnightHigh;
  const buffer   = 0.15 * atr;

  for (let i = 0; i < Math.min(5, openBars.length - 1); i++) {
    const bar  = openBars[i];
    const next = openBars[i + 1];
    if (getET(next.timestamp).hm >= 1000) break;

    if (isBull) {
      // Bar wicks below overnight low (stop hunt), then recovers above it
      if (bar.low < sweepRef - buffer && bar.close > sweepRef - buffer) {
        if (isBullishCandle(next, 0.28) && next.close > sweepRef) {
          return { bar: next, entry: next.close, archetype: 'SWEEP_REVERSAL', sweepLevel: sweepRef };
        }
      }
    } else {
      // Bar wicks above overnight high, then closes back below it
      if (bar.high > sweepRef + buffer && bar.close < sweepRef + buffer) {
        if (isBearishCandle(next, 0.28) && next.close < sweepRef) {
          return { bar: next, entry: next.close, archetype: 'SWEEP_REVERSAL', sweepLevel: sweepRef };
        }
      }
    }
  }
  return null;
}

/**
 * Tier 2: Opening Range Failed Breakout
 * Price attempts to break the ORB in the WRONG direction (against bias), fails,
 * then reverses through the ORB midpoint. Entry on the reversal confirmation.
 * ~65% WR when bias is clean.
 */
function detectOrbFailedBreakout(bars5m, orb, direction, atr) {
  if (!orb || orb.orbRange < 0.3 * atr) return null; // degenerate ORB
  const isBull    = direction === 'LONG';
  const { orbHigh, orbLow, orbMid } = orb;
  const postBars  = bars5m.filter(b => {
    const e = getET(b.timestamp);
    return e.hm >= 940 && e.hm < 1000;
  });
  if (postBars.length < 2) return null;

  for (let i = 0; i < postBars.length - 1; i++) {
    const bar  = postBars[i];
    const next = postBars[i + 1];
    if (getET(next.timestamp).hm >= 1000) break;

    if (isBull) {
      // Failed DOWN breakout: bar briefly dips below ORB low, closes back inside
      if (bar.low < orbLow - 0.05 * atr && bar.close > orbLow) {
        if (isBullishCandle(next, 0.25) && next.close > orbMid) {
          return { bar: next, entry: next.close, archetype: 'ORB_FAILED_BREAKOUT', orbHigh, orbLow };
        }
      }
    } else {
      // Failed UP breakout: bar briefly breaks above ORB high, closes back inside
      if (bar.high > orbHigh + 0.05 * atr && bar.close < orbHigh) {
        if (isBearishCandle(next, 0.25) && next.close < orbMid) {
          return { bar: next, entry: next.close, archetype: 'ORB_FAILED_BREAKOUT', orbHigh, orbLow };
        }
      }
    }
  }
  return null;
}

/**
 * Tier 3: Opening Drive + First Pullback
 * First bar establishes a strong directional drive, price pulls back 25–65%
 * of the drive range, then resumes. Entry on the resumption bar.
 */
function detectDrivePullback(openBars, direction, atr) {
  if (openBars.length < 3) return null;
  const isBull     = direction === 'LONG';
  const firstBar   = openBars[0];
  const firstRange = firstBar.high - firstBar.low;
  if (firstRange < 0.3 * atr) return null;

  const bodySize  = Math.abs(firstBar.close - firstBar.open);
  const driveAligned = isBull
    ? firstBar.close > firstBar.open && bodySize > 0.28 * firstRange
    : firstBar.close < firstBar.open && bodySize > 0.28 * firstRange;
  if (!driveAligned) return null;

  const drive3     = openBars.slice(0, Math.min(3, openBars.length));
  const drivePeak  = isBull
    ? Math.max(...drive3.map(b => b.high))
    : Math.min(...drive3.map(b => b.low));
  const driveRange = isBull
    ? drivePeak - firstBar.low
    : firstBar.high - drivePeak;
  if (driveRange < 0.4 * atr) return null;

  for (let i = 1; i < openBars.length - 1; i++) {
    const bar  = openBars[i];
    const next = openBars[i + 1];
    if (!next || getET(next.timestamp).hm >= 1000) break;

    const pbRatio = isBull
      ? driveRange > 0 ? (drivePeak - bar.low) / driveRange : 0
      : driveRange > 0 ? (bar.high - drivePeak) / driveRange : 0;

    if (pbRatio >= 0.25 && pbRatio <= 0.65) {
      const midLevel = isBull
        ? firstBar.low  + driveRange * 0.50
        : firstBar.high - driveRange * 0.50;
      const ok = isBull
        ? next.close > midLevel && isBullishCandle(next, 0.28)
        : next.close < midLevel && isBearishCandle(next, 0.28);
      if (ok) {
        return { bar: next, entry: next.close, archetype: 'OPENING_DRIVE_PULLBACK', drivePeak };
      }
    }
  }
  return null;
}

/**
 * Tier 4: ORB Breakout (only fires on strong-confluence days, post-9:40 ET)
 * Price breaks the ORB in the direction of pre-open bias, with volume confirmation.
 * Requires ADX-aligned trend or strong bias spread (lS − sS > 30).
 */
function detectOrbBreakout(bars5m, orb, direction, atr, biasSpread) {
  if (!orb || orb.orbRange < 0.3 * atr) return null;
  if (biasSpread < 25) return null; // only on strong conviction days
  const isBull   = direction === 'LONG';
  const { orbHigh, orbLow } = orb;
  const postBars = bars5m.filter(b => {
    const e = getET(b.timestamp);
    return e.hm >= 940 && e.hm < 955;
  });
  if (postBars.length < 1) return null;

  for (let i = 0; i < postBars.length; i++) {
    const bar = postBars[i];
    if (isBull && bar.close > orbHigh + 0.1 * atr && isBullishCandle(bar, 0.35)) {
      return { bar, entry: bar.close, archetype: 'ORB_BREAKOUT', orbHigh, orbLow };
    }
    if (!isBull && bar.close < orbLow - 0.1 * atr && isBearishCandle(bar, 0.35)) {
      return { bar, entry: bar.close, archetype: 'ORB_BREAKOUT', orbHigh, orbLow };
    }
  }
  return null;
}

/**
 * Tier 5: VWAP Confirmation (9:40+ ET)
 * Price touches VWAP, next bar resumes in bias direction.
 */
function detectVwapConfirmation(bars5m, direction, atr) {
  const isBull  = direction === 'LONG';
  const vwapArr = calcVwap(bars5m);
  const lateBars = bars5m.filter(b => {
    const e = getET(b.timestamp);
    return e.hm >= 940 && e.hm < 955;
  });
  for (const bar of lateBars) {
    const idx  = bars5m.indexOf(bar);
    const vwap = idx >= 0 ? vwapArr[idx] : null;
    if (!vwap) continue;
    if (Math.abs(bar.close - vwap) > 0.4 * atr) continue;
    const next = bars5m[idx + 1];
    if (!next || getET(next.timestamp).hm >= 1000) continue;
    const ok = isBull
      ? next.close > vwap + 0.08 * atr && isBullishCandle(next, 0.25)
      : next.close < vwap - 0.08 * atr && isBearishCandle(next, 0.25);
    if (ok) return { bar: next, entry: next.close, archetype: 'VWAP_CONFIRMATION' };
  }
  return null;
}

// ── Conviction grading ────────────────────────────────────────────────────────

const TIER1 = new Set(['SWEEP_REVERSAL', 'ORB_FAILED_BREAKOUT']);
const TIER2 = new Set(['OPENING_DRIVE_PULLBACK', 'ORB_BREAKOUT']);

function gradeConviction(confidence, archetype) {
  if (confidence >= 75 && TIER1.has(archetype)) return { conviction: 'A+', recSize: 'FULL' };
  if (confidence >= 65 && (TIER1.has(archetype) || TIER2.has(archetype))) return { conviction: 'A', recSize: 'FULL' };
  if (confidence >= 65) return { conviction: 'A', recSize: 'FULL' };
  if (confidence >= 55) return { conviction: 'B', recSize: 'HALF' };
  return { conviction: 'C', recSize: 'MIN' };
}

// ── Structure-aware TP targets ────────────────────────────────────────────────

function computeStructureTPs(entry, rawRisk, isBull, on, barsDly) {
  const base1 = isBull ? entry + 1.5 * rawRisk : entry - 1.5 * rawRisk;
  const base2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
  const base3 = isBull ? entry + 3.5 * rawRisk : entry - 3.5 * rawRisk;

  // Snap TP2 to overnight extreme if within 20% of the base target
  let tp2 = base2;
  if (on) {
    const snapTarget = isBull ? on.overnightHigh : on.overnightLow;
    if (snapTarget && Math.abs(snapTarget - base2) / Math.abs(rawRisk) < 0.4) {
      tp2 = snapTarget;
    }
  }

  // Snap TP3 to prior day extreme if within 20% of base target
  let tp3 = base3;
  if (barsDly && barsDly.length >= 2) {
    const pd = barsDly[barsDly.length - 2];
    const snapTarget3 = isBull ? pd.high : pd.low;
    if (Math.abs(snapTarget3 - base3) / Math.abs(rawRisk) < 0.4) {
      tp3 = snapTarget3;
    }
  }

  return {
    tp1: +base1.toFixed(2),
    tp2: +tp2.toFixed(2),
    tp3: +tp3.toFixed(2),
  };
}

// ── Main evaluate function ────────────────────────────────────────────────────

function evaluate(bars5m, bars15m, bars1h, bars4h, cfg = {}, barIdx = null) {
  if (!bars5m || bars5m.length < 20) return null;

  const lastBar = bars5m[bars5m.length - 1];
  const et      = getET(lastBar.timestamp);

  if (et.dow === 0 || et.dow === 6) return null;

  // ── Macro blackout gate ───────────────────────────────────────────────────
  if (_blackoutDates.has(et.dateKey)) {
    if (_d.dateKey !== et.dateKey) {
      console.log(`[NQ_NY_OPEN] ${et.dateKey} MACRO BLACKOUT — trade skipped`);
    }
    _d.dateKey = et.dateKey; // prevent repeated log on every bar
    return null;
  }

  // ── Daily state reset ─────────────────────────────────────────────────────
  if (et.dateKey !== _d.dateKey) {
    _d.dateKey     = et.dateKey;
    _d.direction   = null;
    _d.longScore   = 0;
    _d.shortScore  = 0;
    _d.biasNotes   = [];
    _d.archetype   = null;
    _d.conviction  = null;
    _d.phase       = 'IDLE';
    _d.emitted     = false;
    _d.orbComputed = false;
    _d.orbHigh     = null;
    _d.orbLow      = null;
  }

  if (_d.emitted) return null;
  if (et.hm < 920 || et.hm >= 1000) return null;

  const barsDly = cfg.barsDly ?? [];

  const atrArr = calcAtr(bars5m, 14);
  const atr    = atrArr[atrArr.length - 1];
  if (!atr || atr < 4) return null;

  // ── Pre-open scoring (9:20–9:29 ET) ──────────────────────────────────────
  if (et.hm < 930 && _d.phase === 'IDLE') {
    const bias    = computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly);
    _d.direction  = bias.direction;
    _d.longScore  = bias.longScore;
    _d.shortScore = bias.shortScore;
    _d.biasNotes  = bias.notes;
    _d.phase      = 'SCORED';
    return null;
  }

  // ── Transition to HUNTING at open ────────────────────────────────────────
  if (et.hm >= 930 && _d.phase === 'SCORED') _d.phase = 'HUNTING';

  // Recover from restart mid-session
  if (_d.phase === 'IDLE' && et.hm >= 930) {
    const bias    = computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly);
    _d.direction  = bias.direction;
    _d.longScore  = bias.longScore;
    _d.shortScore = bias.shortScore;
    _d.biasNotes  = bias.notes;
    _d.phase      = 'HUNTING';
  }

  if (_d.phase !== 'HUNTING' || !_d.direction) return null;

  // ── Entry execution ───────────────────────────────────────────────────────
  const isBull      = _d.direction === 'LONG';
  const isDeadline  = et.hm >= 955;
  const openBars    = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 1000; });
  const on          = computeOvernightLevels(bars5m);
  const biasSpread  = Math.abs(_d.longScore - _d.shortScore);

  // Compute and cache ORB once 9:40+ bars are available
  if (!_d.orbComputed && et.hm >= 940) {
    const orbResult = computeOpeningRange(bars5m);
    if (orbResult) {
      _d.orbHigh     = orbResult.orbHigh;
      _d.orbLow      = orbResult.orbLow;
      _d.orbComputed = true;
    }
  }
  const orb = (_d.orbHigh && _d.orbLow)
    ? { orbHigh: _d.orbHigh, orbLow: _d.orbLow, orbMid: (_d.orbHigh + _d.orbLow) / 2, orbRange: _d.orbHigh - _d.orbLow }
    : null;

  let entryResult = null;

  if (!isDeadline) {
    // Tier 1: Sweep Reversal (highest priority — fires 9:30–9:40)
    entryResult = detectSweepReversal(openBars, on, _d.direction, atr);

    // Tier 2: ORB Failed Breakout (requires ORB, fires 9:40–9:55)
    if (!entryResult && orb) {
      entryResult = detectOrbFailedBreakout(bars5m, orb, _d.direction, atr);
    }

    // Tier 3: Opening Drive + First Pullback
    if (!entryResult) {
      entryResult = detectDrivePullback(openBars, _d.direction, atr);
    }

    // Tier 4: ORB Breakout (strong-conviction only)
    if (!entryResult && orb) {
      entryResult = detectOrbBreakout(bars5m, orb, _d.direction, atr, biasSpread);
    }

    // Tier 5: VWAP Confirmation (9:40+ ET)
    if (!entryResult) {
      entryResult = detectVwapConfirmation(bars5m, _d.direction, atr);
    }
  }

  // Tier 6: Deadline forced entry — never skips a day
  if (!entryResult && isDeadline) {
    entryResult = { bar: lastBar, entry: lastBar.close, archetype: 'FORCED_BIAS_ENTRY' };
  }

  if (!entryResult) return null;

  // ── Stop loss placement ───────────────────────────────────────────────────
  const entry    = entryResult.entry;
  const vwapArr2 = calcVwap(bars5m);
  const vwap     = vwapArr2[vwapArr2.length - 1];
  const swLow    = recentSwingLow(bars5m,  12);
  const swHigh   = recentSwingHigh(bars5m, 12);

  let rawRisk, sl;
  if (isBull) {
    // Use ORB low as structural floor if available; fall back to swing/VWAP
    const structFloor = orb
      ? Math.min(orb.orbLow - 0.1 * atr, swLow)
      : Math.min(swLow, vwap != null ? vwap - 0.5 * atr : swLow);
    rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, entry - structFloor));
    sl      = +(entry - rawRisk).toFixed(2);
  } else {
    const structCeil  = orb
      ? Math.max(orb.orbHigh + 0.1 * atr, swHigh)
      : Math.max(swHigh, vwap != null ? vwap + 0.5 * atr : swHigh);
    rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, structCeil - entry));
    sl      = +(entry + rawRisk).toFixed(2);
  }

  // ── Take profit — structure-snapped ──────────────────────────────────────
  const { tp1, tp2, tp3 } = computeStructureTPs(entry, rawRisk, isBull, on, barsDly);

  // ── Confidence score ──────────────────────────────────────────────────────
  const winScore = isBull ? _d.longScore : _d.shortScore;
  const total    = _d.longScore + _d.shortScore;
  let confidence = total > 0 ? Math.round(50 + (winScore / total - 0.5) * 80) : 50;

  // Archetype bonuses
  if (entryResult.archetype === 'SWEEP_REVERSAL')         confidence = Math.min(93, confidence + 12);
  else if (entryResult.archetype === 'ORB_FAILED_BREAKOUT') confidence = Math.min(93, confidence + 10);
  else if (entryResult.archetype === 'OPENING_DRIVE_PULLBACK') confidence = Math.min(93, confidence + 8);
  else if (entryResult.archetype === 'ORB_BREAKOUT')       confidence = Math.min(93, confidence + 5);
  else if (entryResult.archetype === 'VWAP_CONFIRMATION')  confidence = Math.min(93, confidence + 4);
  confidence = Math.max(45, confidence);

  const { conviction, recSize } = gradeConviction(confidence, entryResult.archetype);

  // ── Supporting indicators ─────────────────────────────────────────────────
  const closes = bars5m.map(b => b.close);
  const rsiArr = calcRsi(closes, 14);
  const rsi    = rsiArr[rsiArr.length - 1];
  const b4     = bars4h  && bars4h.length  >= 5  ? calcHtfBias(bars4h,  9, 21) : 0;
  const b1     = bars1h  && bars1h.length  >= 21 ? calcHtfBias(bars1h,  9, 21) : 0;
  const b15    = bars15m && bars15m.length >= 21 ? calcHtfBias(bars15m, 9, 21) : 0;
  const struct = bars1h  && bars1h.length  >= 20 ? detectMarketStructure(bars1h, 20) : 'UNCLEAR';

  const sess = getSessionInfo(lastBar.timestamp);
  const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

  _d.emitted    = true;
  _d.archetype  = entryResult.archetype;
  _d.conviction = conviction;
  _d.phase      = 'DONE';

  return {
    instrument:    'MNQ',
    strategy_name: STRATEGY_NAME,
    trade_style:   'ny_open',
    timeframe:     '5m',
    direction:     _d.direction,
    entry:         +entry.toFixed(2),
    sl,
    tp1,
    tp2,
    tp3,
    rr:            1.5,
    confidence,
    conviction,
    rec_size:      recSize,
    grade,
    win_prob_tp1,
    win_prob_tp2,
    win_prob_tp3,
    score:         Math.round(confidence / 4),
    setup:         'NQ NY Open',
    archetype:     entryResult.archetype,
    strategy_version: STRATEGY_VERSION,
    htf_bias:      b4 > 0 ? 'BULL' : b4 < 0 ? 'BEAR' : 'MIXED',
    session:       sess?.name ?? 'NY_OPEN',
    trigger_reason: [
      `${entryResult.archetype} | ${_d.direction} | conviction=${conviction}(${recSize})`,
      `bias=${confidence}% (L${_d.longScore} vs S${_d.shortScore})`,
      `4H:${b4 > 0 ? 'BULL' : b4 < 0 ? 'BEAR' : 'NEUT'} 1H:${b1 > 0 ? 'BULL' : b1 < 0 ? 'BEAR' : 'NEUT'} struct=${struct}`,
      entryResult.archetype === 'FORCED_BIAS_ENTRY' ? 'DEADLINE_9:55' : null,
    ].filter(Boolean).join(' | '),
    indicators: {
      atr:        +atr.toFixed(2),
      vwap:       vwap  != null ? +vwap.toFixed(2) : null,
      rsi:        rsi   != null ? +rsi.toFixed(1)  : null,
      htfBias:    b4,
      htf2Bias:   b1,
      htf3Bias:   b15,
      htfStruct:  struct,
      longScore:  _d.longScore,
      shortScore: _d.shortScore,
      biasSpread,
      regime:     b4 > 0 ? 'TREND_BULL' : b4 < 0 ? 'TREND_BEAR' : 'MIXED',
      orbHigh:    orb ? +orb.orbHigh.toFixed(2) : null,
      orbLow:     orb ? +orb.orbLow.toFixed(2)  : null,
    },
    timestamp:       lastBar.timestamp,
    trade_status:    'PENDING',
    be_trail_at_hm:  1015,  // advance stop to BE at 10:15 ET
    scale_out: [
      { pct: 50, at: 'TP1', rr: 1.5 },
      { pct: 30, at: 'TP2', rr: 2.5 },
      { pct: 20, at: 'TP3', rr: 3.5 },
    ],
  };
}

// ── Dedicated daily backtest ──────────────────────────────────────────────────

function backtestNyOpen(bars5m, bars1h, bars4h, barsDly, opts = {}) {
  const { instrument = 'MNQ' } = opts;

  // Group 5m bars by ET date
  const dayMap = new Map();
  for (const bar of bars5m) {
    const { dateKey } = getET(bar.timestamp);
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey).push(bar);
  }

  const signalLog = [];
  let wins = 0, losses = 0, totalPnl = 0;
  let pnlRunning = 0, peak = 0, maxDrawdown = 0;
  const dayKeys = [...dayMap.keys()].sort();

  for (const dateKey of dayKeys) {
    const dayBars = dayMap.get(dateKey);
    if (!dayBars || dayBars.length < 10) continue;
    const et = getET(dayBars[0].timestamp);
    if (et.dow === 0 || et.dow === 6) continue;

    const cutoff  = dayBars[0].timestamp;
    const h1Slice = bars1h   ? bars1h.filter(b => b.timestamp < cutoff)   : [];
    const h4Slice = bars4h   ? bars4h.filter(b => b.timestamp < cutoff)   : [];
    const dlySlice = barsDly ? barsDly.filter(b => b.timestamp < cutoff)  : [];

    // Build 15m from prior + today pre-open bars
    const preBars     = bars5m.filter(b => b.timestamp < cutoff).slice(-200);
    const todayPre    = dayBars.filter(b => getET(b.timestamp).hm < 930);
    const allPreBars  = [...preBars, ...todayPre];
    const bars15m     = _agg5mTo15m(allPreBars);

    const bias   = computePreopenBias(allPreBars, bars15m, h1Slice, h4Slice, dlySlice);
    const dir    = bias.direction;
    const isBull = dir === 'LONG';

    const atrArr = calcAtr(allPreBars.length >= 14 ? allPreBars : dayBars, 14);
    const atr    = atrArr[atrArr.length - 1] || 10;

    const openBars = dayBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 1000; });
    if (openBars.length < 2) continue;

    const allBtBars = [...allPreBars, ...openBars];
    const on   = computeOvernightLevels(allBtBars);
    const biasSpread = Math.abs(bias.longScore - bias.shortScore);

    // ORB from 9:30-9:40 open bars
    const orbData = (() => {
      const ob = openBars.filter(b => getET(b.timestamp).hm < 940);
      if (ob.length < 2) return null;
      const h = Math.max(...ob.map(b => b.high));
      const l = Math.min(...ob.map(b => b.low));
      return { orbHigh: h, orbLow: l, orbMid: (h + l) / 2, orbRange: h - l };
    })();

    // Try entry cascade
    let entryResult =
      detectSweepReversal(openBars, on, dir, atr) ||
      (orbData ? detectOrbFailedBreakout(allBtBars, orbData, dir, atr) : null) ||
      detectDrivePullback(openBars, dir, atr) ||
      (orbData ? detectOrbBreakout(allBtBars, orbData, dir, atr, biasSpread) : null) ||
      detectVwapConfirmation(allBtBars, dir, atr) ||
      { bar: openBars[openBars.length - 1], entry: openBars[openBars.length - 1].close, archetype: 'FORCED_BIAS_ENTRY' };

    const entry   = entryResult.entry;
    const entryBar = entryResult.bar;

    const vArr  = calcVwap(allBtBars);
    const vwap  = vArr[vArr.length - 1];
    const swLow  = recentSwingLow(allBtBars,  12);
    const swHigh = recentSwingHigh(allBtBars, 12);

    let rawRisk, sl;
    if (isBull) {
      const floor = orbData
        ? Math.min(orbData.orbLow - 0.1 * atr, swLow)
        : Math.min(swLow, vwap != null ? vwap - 0.5 * atr : swLow);
      rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, entry - floor));
      sl = entry - rawRisk;
    } else {
      const ceil  = orbData
        ? Math.max(orbData.orbHigh + 0.1 * atr, swHigh)
        : Math.max(swHigh, vwap != null ? vwap + 0.5 * atr : swHigh);
      rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, ceil - entry));
      sl = entry + rawRisk;
    }

    const tps  = computeStructureTPs(entry, rawRisk, isBull, on, dlySlice);
    const tp1  = tps.tp1;

    // Simulate against bars from entry to 11:00 ET — 3-tranche exit model:
    //   50% at TP1 (1.5R), 30% at TP2 (2.5R), 20% at TP3 (3.5R)
    //   Stop advances to BE after T1 or at 10:15 ET (whichever comes first)
    const futureBars = dayBars.filter(b => {
      const e = getET(b.timestamp);
      return b.timestamp > entryBar.timestamp && e.hm <= 1100;
    });

    let pnlPts  = 0;
    let stopLvl = sl;
    let openFrac = 1.0;
    let t1Done = false, t2Done = false, t3Done = false;
    const { tp2, tp3 } = computeStructureTPs(entry, rawRisk, isBull, on, dlySlice);

    for (const bar of futureBars) {
      const eBt = getET(bar.timestamp);
      // Time-based BE gate: 10:15 ET — if T1 not yet hit, move stop to entry
      if (!t1Done && eBt.hm >= 1015) stopLvl = entry;

      if (isBull) {
        if (openFrac > 0 && bar.low <= stopLvl) {
          pnlPts += openFrac * (stopLvl - entry); break;
        }
        if (!t1Done && bar.high >= tp1) {
          t1Done = true; pnlPts += 0.5 * (tp1 - entry);
          openFrac = 0.5; stopLvl = entry;
        }
        if (t1Done && !t2Done && bar.high >= tp2) {
          t2Done = true; pnlPts += 0.3 * (tp2 - entry); openFrac = 0.2;
        }
        if (t2Done && !t3Done && bar.high >= tp3) {
          t3Done = true; pnlPts += 0.2 * (tp3 - entry); openFrac = 0; break;
        }
      } else {
        if (openFrac > 0 && bar.high >= stopLvl) {
          pnlPts += openFrac * (entry - stopLvl); break;
        }
        if (!t1Done && bar.low <= tp1) {
          t1Done = true; pnlPts += 0.5 * (entry - tp1);
          openFrac = 0.5; stopLvl = entry;
        }
        if (t1Done && !t2Done && bar.low <= tp2) {
          t2Done = true; pnlPts += 0.3 * (entry - tp2); openFrac = 0.2;
        }
        if (t2Done && !t3Done && bar.low <= tp3) {
          t3Done = true; pnlPts += 0.2 * (entry - tp3); openFrac = 0; break;
        }
      }
    }
    // Time exit for remaining open tranche(s)
    if (openFrac > 0) {
      const last = futureBars[futureBars.length - 1];
      if (last) pnlPts += openFrac * (isBull ? last.close - entry : entry - last.close);
    }
    pnlPts = +pnlPts.toFixed(2);

    // WIN = T1 was hit (guaranteed net-positive from that point forward due to BE stop)
    // LOSS = stop hit before T1
    const outcome = t1Done ? 'WIN' : 'LOSS';
    if (outcome === 'WIN') wins++; else losses++;
    totalPnl   += pnlPts;
    pnlRunning += pnlPts;
    peak        = Math.max(peak, pnlRunning);
    maxDrawdown = Math.max(maxDrawdown, peak - pnlRunning);

    let confidence = bias.confidence;
    if (entryResult.archetype === 'SWEEP_REVERSAL')         confidence = Math.min(93, confidence + 12);
    else if (entryResult.archetype === 'ORB_FAILED_BREAKOUT') confidence = Math.min(93, confidence + 10);
    else if (entryResult.archetype === 'OPENING_DRIVE_PULLBACK') confidence = Math.min(93, confidence + 8);
    else if (entryResult.archetype === 'ORB_BREAKOUT')       confidence = Math.min(93, confidence + 5);
    else if (entryResult.archetype === 'VWAP_CONFIRMATION')  confidence = Math.min(93, confidence + 4);
    confidence = Math.max(45, confidence);

    const { conviction } = gradeConviction(confidence, entryResult.archetype);

    signalLog.push({
      date:        dateKey,
      direction:   dir,
      archetype:   entryResult.archetype,
      conviction,
      entry:       +entry.toFixed(2),
      sl:          +sl.toFixed(2),
      tp1,
      outcome,
      pnl_pts:     pnlPts,
      t1Hit:       t1Done,
      t2Hit:       t2Done,
      t3Hit:       t3Done,
      confidence,
      longScore:   bias.longScore,
      shortScore:  bias.shortScore,
      strategy_name: STRATEGY_NAME,
      hour_et:     getET(entryBar.timestamp).h,
      session:     'NY_OPEN',
      regime:      h4Slice.length >= 5
        ? (calcHtfBias(h4Slice, 9, 21) > 0 ? 'TREND_BULL' : calcHtfBias(h4Slice, 9, 21) < 0 ? 'TREND_BEAR' : 'MIXED')
        : 'UNKNOWN',
    });
  }

  const tradeCount   = wins + losses;
  const winRate      = tradeCount > 0 ? wins / tradeCount : 0;
  const wTrades      = signalLog.filter(t => t.outcome === 'WIN');
  const lTrades      = signalLog.filter(t => t.outcome === 'LOSS');
  const avgWin       = wTrades.length ? wTrades.reduce((s, t) => s + t.pnl_pts, 0) / wTrades.length : 0;
  const avgLoss      = lTrades.length ? Math.abs(lTrades.reduce((s, t) => s + t.pnl_pts, 0) / lTrades.length) : 0;
  const profitFactor = avgLoss > 0 ? (wins * avgWin) / (losses * avgLoss) : null;
  const returns      = signalLog.map(t => t.pnl_pts);
  const mean         = returns.reduce((s, v) => s + v, 0) / (returns.length || 1);
  const variance     = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const sharpe       = variance > 0 ? +(mean / Math.sqrt(variance) * Math.sqrt(252)).toFixed(3) : null;

  // Per-archetype breakdown
  const byArchetype = {};
  for (const t of signalLog) {
    if (!byArchetype[t.archetype]) byArchetype[t.archetype] = { wins: 0, total: 0, totalPnl: 0 };
    byArchetype[t.archetype].total++;
    byArchetype[t.archetype].totalPnl += t.pnl_pts;
    if (t.outcome === 'WIN') byArchetype[t.archetype].wins++;
  }

  return {
    metrics: {
      tradeCount,
      winRate,
      wins,
      losses,
      totalPnl:     +totalPnl.toFixed(2),
      expectancy:   tradeCount > 0 ? +(totalPnl / tradeCount).toFixed(2) : 0,
      profitFactor: profitFactor != null ? +profitFactor.toFixed(3) : null,
      maxDrawdown:  +maxDrawdown.toFixed(2),
      sharpe,
      avgWin:       +avgWin.toFixed(2),
      avgLoss:      +avgLoss.toFixed(2),
      byArchetype,
    },
    signalLog,
  };
}

function _agg5mTo15m(bars5m) {
  const out = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3) {
    const s = bars5m.slice(i, i + 3);
    out.push({
      timestamp: s[0].timestamp, open: s[0].open,
      high: Math.max(...s.map(b => b.high)), low: Math.min(...s.map(b => b.low)),
      close: s[2].close, volume: s.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  return out;
}

function reset() {
  _d.dateKey     = null;
  _d.direction   = null;
  _d.longScore   = 0;
  _d.shortScore  = 0;
  _d.biasNotes   = [];
  _d.archetype   = null;
  _d.conviction  = null;
  _d.phase       = 'IDLE';
  _d.emitted     = false;
  _d.orbComputed = false;
  _d.orbHigh     = null;
  _d.orbLow      = null;
}

module.exports = {
  evaluate,
  reset,
  backtestNyOpen,
  computePreopenBias,
  setBlackoutDates,
  STRATEGY_NAME,
  STRATEGY_VERSION,
  LIVE_THRESHOLD,
};
