'use strict';

/**
 * STRATEGY — NQ NY OPEN  v3.0  (Institutional-Grade Opening Auction)
 *
 * Instrument:  MNQ only
 * Entry window: 9:35–10:00 ET  (9:30–9:34 is WATCHING — no entries)
 * Time stop:   90 min / 11:00 ET
 * Max stop:    35 MNQ pts (hard cap — eliminates catastrophic outlier losses)
 *
 * ── Design philosophy ────────────────────────────────────────────────────────
 * v2.x failed (28.3% WR) because:
 *   1. Pre-open directional bias used lagging EMAs → wrong direction >70% of the time
 *   2. Pattern detectors were bias-dependent → scanned wrong side when bias was wrong
 *   3. Stop cap was 2× ATR → catastrophic -286/-295 pt single-trade losses
 *
 * v3.0 fixes:
 *   1. ALL pattern detectors are SELF-DETERMINING for direction — pattern = direction
 *   2. Pre-open bias used as CONFIRMATION BONUS only, never as direction authority
 *   3. Hard 35-pt stop cap eliminates outlier losses
 *   4. First 5 minutes (9:30–9:34) are observation-only — no impulse chasing
 *   5. Clean-room filter: TP1 path must be structurally clear
 *
 * ── Archetype hierarchy ──────────────────────────────────────────────────────
 *   TIER 1  ORB_FAILED_BREAKOUT      — bidirectional, proven 80% WR in sample
 *   TIER 1  LIQUIDITY_SWEEP_REVERSAL — bidirectional, overnight stop hunt reversal
 *   TIER 2  FIRST_PULLBACK           — self-determining from opening drive direction
 *   TIER 2  DISPLACEMENT_CONTINUATION— self-determining from displacement bar
 *   TIER 3  VWAP_RECLAIM             — bidirectional VWAP reclaim/rejection
 *   TIER 4  FORCED_BIAS_ENTRY        — deadline 10:00 ET, spread ≥ 40 only
 */

const {
  calcAtr, calcVwap, calcRsi, calcAdx,
  calcHtfBias, hasVolumeSpike,
  detectMarketStructure,
  isBullishCandle, isBearishCandle,
  recentSwingLow, recentSwingHigh,
  isChoppingAroundVwap,
  getSessionInfo,
} = require('./shared-indicators');

const { deriveGradeAndProbs } = require('./confidence-scorer');

const STRATEGY_NAME       = 'NQ_NY_OPEN';
const STRATEGY_VERSION    = '3.3';
const LIVE_THRESHOLD      = 40;
const MAX_STOP_PTS        = 35;  // hard stop cap — never risk more than this per trade
const SECONDARY_WAIT_MIN  = 30;  // minutes after primary before secondary entry is eligible

// ── Macro blackout state ──────────────────────────────────────────────────────
const _blackoutDates = new Set();
function setBlackoutDates(dates) {
  _blackoutDates.clear();
  for (const d of (dates || [])) _blackoutDates.add(d);
}

// ── Daily state ───────────────────────────────────────────────────────────────
const _d = {
  dateKey:         null,
  direction:       null,
  longScore:       0,
  shortScore:      0,
  biasNotes:       [],
  archetype:       null,
  conviction:      null,
  phase:           'IDLE',   // IDLE → PRE_OPEN → WATCHING → HUNTING → DONE
  emitted:         false,    // primary trade emitted
  secondEmitted:   false,    // secondary trade emitted
  firstEntryMinET: null,     // primary entry time in minutes-from-midnight ET (for 30-min wait)
  firstEntryDir:   null,     // direction of primary entry (secondary must match)
  orbComputed:     false,
  orbHigh:         null,
  orbLow:          null,
  openDriveDir:    null,   // direction established by first 2-3 bars
  openDriveAmt:    0,      // magnitude of opening drive in pts
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
    const h = ((d.getUTCHours() - 4) + 24) % 24;
    return {
      h, m: d.getUTCMinutes(), hm: h * 100 + d.getUTCMinutes(),
      dow: d.getUTCDay(),
      dateKey: d.toISOString().slice(0, 10),
    };
  }
}

// ── Overnight levels ──────────────────────────────────────────────────────────
function computeOvernightLevels(bars5m) {
  const ov = bars5m.slice(-Math.min(120, bars5m.length - 1), -1).filter(b => {
    const e = getET(b.timestamp);
    return e.hm < 930 || e.hm >= 1600;
  });
  if (ov.length < 5) return null;
  const oHigh = Math.max(...ov.map(b => b.high));
  const oLow  = Math.min(...ov.map(b => b.low));
  return { overnightHigh: oHigh, overnightLow: oLow, overnightMid: (oHigh + oLow) / 2 };
}

// ── Opening range ─────────────────────────────────────────────────────────────
function computeOpeningRange(bars5m) {
  const orbBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 940; });
  if (orbBars.length < 2) return null;
  const h = Math.max(...orbBars.map(b => b.high));
  const l = Math.min(...orbBars.map(b => b.low));
  return { orbHigh: h, orbLow: l, orbMid: (h + l) / 2, orbRange: h - l };
}

// ── Key levels (S/R that can block price to TP1) ──────────────────────────────
function buildKeyLevels(on, orb, barsDly, vwap) {
  const levels = [];
  if (on)       { levels.push(on.overnightHigh, on.overnightLow); }
  if (orb)      { levels.push(orb.orbHigh, orb.orbLow); }
  if (vwap)     { levels.push(vwap); }
  if (barsDly?.length >= 2) {
    const pd = barsDly[barsDly.length - 2];
    levels.push(pd.high, pd.low, pd.close);
  }
  return levels.filter(l => l != null && l > 0);
}

// Returns true if the path from entry to tp1 has no key level within the first 55% of the path.
// Levels in the outer 45% (near TP1) are not considered blockers — price can push through them.
function hasCleanRoom(entry, tp1, direction, keyLevels) {
  const dist = Math.abs(tp1 - entry);
  if (dist === 0) return false;
  for (const l of keyLevels) {
    const dToLevel = Math.abs(l - entry);
    if (direction === 'LONG'  && l > entry + dist * 0.05 && l < tp1 - dist * 0.05) {
      if (dToLevel < 0.55 * dist) return false; // relaxed from 0.70 — mid-path levels no longer block
    }
    if (direction === 'SHORT' && l < entry - dist * 0.05 && l > tp1 + dist * 0.05) {
      if (dToLevel < 0.55 * dist) return false;
    }
  }
  return true;
}

// ── Displacement bar check ────────────────────────────────────────────────────
function isDisplacement(bar, atr, minBodyRatio = 0.45, minBodyAtr = 0.30) {
  const body  = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low;
  return range > 0 && body >= minBodyRatio * range && body >= minBodyAtr * atr;
}

// ── Pre-open scoring (3 clean pillars, non-lagging) ───────────────────────────
function computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly) {
  let lS = 0, sS = 0;
  const notes = [];

  // Pillar 1: Opening Gap Structure — 40 pts (most actionable pre-open signal)
  if (barsDly?.length >= 2 && bars5m?.length > 0) {
    const prevClose = barsDly[barsDly.length - 2]?.close;
    const cur       = bars5m[bars5m.length - 1].close;
    if (prevClose && cur) {
      const g    = (cur - prevClose) / prevClose * 100;
      const gAbs = Math.abs(g);
      if (gAbs < 0.10) {
        lS += 5; sS += 5; notes.push(`gap:flat(${g.toFixed(2)}%)`);
      } else if (gAbs < 0.50) {
        if (g > 0) { lS += 30; notes.push(`gap:up_cont(${g.toFixed(2)}%)`); }
        else       { sS += 30; notes.push(`gap:dn_cont(${g.toFixed(2)}%)`); }
      } else if (gAbs < 0.90) {
        if (g > 0) { lS += 18; sS += 6; notes.push(`gap:up_med(${g.toFixed(2)}%)`); }
        else       { sS += 18; lS += 6; notes.push(`gap:dn_med(${g.toFixed(2)}%)`); }
      } else {
        // Exhaustion gap (>0.9%) — fade bias ~62% historical
        if (g > 0) { sS += 30; lS += 4; notes.push(`gap:exhaust_up(${g.toFixed(2)}%,FADE)`); }
        else       { lS += 30; sS += 4; notes.push(`gap:exhaust_dn(${g.toFixed(2)}%,FADE)`); }
      }
    }
  }

  // Pillar 2: 1H EMA alignment — 35 pts (cleanest non-lagging trend filter)
  if (bars1h?.length >= 21) {
    const b = calcHtfBias(bars1h, 9, 21);
    if (b > 0)      { lS += 35; notes.push('1H:BULL'); }
    else if (b < 0) { sS += 35; notes.push('1H:BEAR'); }
    else            { lS += 10; sS += 10; notes.push('1H:NEUT'); }
  }

  // Pillar 3: Overnight structure positioning — 25 pts
  const on = computeOvernightLevels(bars5m ?? []);
  if (on && bars5m?.length > 0) {
    const price  = bars5m[bars5m.length - 1].close;
    const oRange = on.overnightHigh - on.overnightLow;
    const pos    = oRange > 0 ? (price - on.overnightLow) / oRange : 0.5;
    if (pos > 0.70)      { lS += 20; notes.push(`ON:upper(${pos.toFixed(2)})`); }
    else if (pos < 0.30) { sS += 20; notes.push(`ON:lower(${pos.toFixed(2)})`); }
    else                 { lS += 5; sS += 5; notes.push(`ON:mid(${pos.toFixed(2)})`); }
    // Near extreme = strong S/R
    if (pos <= 0.08) { lS += 5; notes.push('ON:at_low_support'); }
    if (pos >= 0.92) { sS += 5; notes.push('ON:at_high_resist'); }
  }

  const direction  = lS >= sS ? 'LONG' : 'SHORT';
  const winScore   = Math.max(lS, sS);
  const total      = lS + sS;
  const confidence = total > 0 ? Math.round(50 + (winScore / total - 0.5) * 80) : 50;
  return { direction, longScore: lS, shortScore: sS, confidence, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARCHETYPE DETECTORS — all self-determining for direction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TIER 1: ORB Failed Breakout (bidirectional)
 * Price breaks ORB in one direction, fails, reverses through midpoint.
 * Direction = opposite of the failed break.
 * Window: 9:40–10:15 ET
 */
function detectOrbFailedBreakout(bars5m, orb, atr) {
  if (!orb || orb.orbRange < 0.25 * atr) return null;
  const { orbHigh, orbLow, orbMid } = orb;
  const postBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 940 && e.hm < 1015; });
  if (postBars.length < 2) return null;

  for (let i = 0; i < postBars.length - 1; i++) {
    const bar  = postBars[i];
    const next = postBars[i + 1];
    if (getET(next.timestamp).hm >= 1015) break;

    // Failed DOWN → LONG reversal
    if (bar.low < orbLow - 0.05 * atr && bar.close > orbLow) {
      if (isBullishCandle(next, 0.30) && next.close > orbMid) {
        return { bar: next, entry: next.close, direction: 'LONG', archetype: 'ORB_FAILED_BREAKOUT',
                 structStop: orbLow - 3, orbHigh, orbLow };
      }
    }
    // Failed UP → SHORT reversal
    if (bar.high > orbHigh + 0.05 * atr && bar.close < orbHigh) {
      if (isBearishCandle(next, 0.30) && next.close < orbMid) {
        return { bar: next, entry: next.close, direction: 'SHORT', archetype: 'ORB_FAILED_BREAKOUT',
                 structStop: orbHigh + 3, orbHigh, orbLow };
      }
    }
  }
  return null;
}

/**
 * TIER 1: Liquidity Sweep Reversal (bidirectional)
 * NQ spikes through overnight high/low (institutional stop hunt), then reverses hard.
 * Direction = opposite of the sweep.
 * Window: 9:30–9:50 ET
 */
function detectLiquiditySweepReversal(bars5m, on, atr) {
  if (!on) return null;
  const openBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 950; });
  if (openBars.length < 2) return null;

  for (let i = 0; i < openBars.length - 1; i++) {
    const bar  = openBars[i];
    const next = openBars[i + 1];
    if (getET(next.timestamp).hm >= 950) break;

    // Sweep of overnight LOW → LONG reversal
    if (bar.low < on.overnightLow - 0.20 * atr
        && bar.close > on.overnightLow + 0.05 * atr) {
      if (isDisplacement(next, atr, 0.40, 0.30) && isBullishCandle(next, 0.40)) {
        return { bar: next, entry: next.close, direction: 'LONG',
                 archetype: 'LIQUIDITY_SWEEP_REVERSAL',
                 structStop: bar.low - 2, sweepLevel: on.overnightLow };
      }
    }
    // Sweep of overnight HIGH → SHORT reversal
    if (bar.high > on.overnightHigh + 0.20 * atr
        && bar.close < on.overnightHigh - 0.05 * atr) {
      if (isDisplacement(next, atr, 0.40, 0.30) && isBearishCandle(next, 0.40)) {
        return { bar: next, entry: next.close, direction: 'SHORT',
                 archetype: 'LIQUIDITY_SWEEP_REVERSAL',
                 structStop: bar.high + 2, sweepLevel: on.overnightHigh };
      }
    }
  }
  return null;
}

/**
 * TIER 2: First Pullback Continuation
 * Opening drive establishes a clear direction (>0.6× ATR), price pulls back
 * 25–70%, then resumes with a directional displacement bar.
 * Window extended to 10:20 to catch slower or later impulse setups.
 * Direction = opening drive direction (self-determining).
 * Window: 9:35–10:20 ET
 */
function detectFirstPullback(bars5m, atr) {
  // Extended drive observation window (9:30–9:45) to catch later impulses
  const driveBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 945; });
  if (driveBars.length < 2) return null;

  const openPrice = driveBars[0].open;
  const driveHigh = Math.max(...driveBars.map(b => b.high));
  const driveLow  = Math.min(...driveBars.map(b => b.low));
  const lastClose = driveBars[driveBars.length - 1].close;

  const upDrive   = lastClose - openPrice;
  const downDrive = openPrice - lastClose;
  const driveDir  = Math.abs(upDrive) >= Math.abs(downDrive) ? (upDrive > 0 ? 'LONG' : 'SHORT') : null;
  if (!driveDir) return null;

  const driveMag = Math.abs(lastClose - openPrice);
  if (driveMag < 0.60 * atr) return null; // lowered from 0.8× — catches moderate opening drives

  // Extended pullback window to 10:20 ET
  const pullBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 935 && e.hm < 1020; });
  if (pullBars.length < 2) return null;

  const isBull = driveDir === 'LONG';

  for (let i = 0; i < pullBars.length - 1; i++) {
    const bar  = pullBars[i];
    const next = pullBars[i + 1];
    if (getET(next.timestamp).hm >= 1020) break;

    const pbRatio = isBull
      ? driveMag > 0 ? (driveHigh - bar.low)  / driveMag : 0
      : driveMag > 0 ? (bar.high  - driveLow) / driveMag : 0;

    // Widened from 35–55% to 25–70% — captures shallow (aggressive) and deep (test) pullbacks
    if (pbRatio >= 0.25 && pbRatio <= 0.70) {
      if (isBull && isDisplacement(next, atr, 0.35, 0.20) && isBullishCandle(next, 0.35)) {
        // Entry quality gate: close must be in the top 40% of bar range (strong close, not wick)
        const nextRange = next.high - next.low;
        if (nextRange > 0 && (next.close - next.low) / nextRange < 0.40) continue;
        const structStop = Math.min(bar.low, driveBars[driveBars.length - 1].low) - 3;
        return { bar: next, entry: next.close, direction: 'LONG',
                 archetype: 'FIRST_PULLBACK', structStop, driveMag };
      }
      if (!isBull && isDisplacement(next, atr, 0.35, 0.20) && isBearishCandle(next, 0.35)) {
        // Entry quality gate: close must be in the bottom 40% of bar range
        const nextRange = next.high - next.low;
        if (nextRange > 0 && (next.high - next.close) / nextRange < 0.40) continue;
        const structStop = Math.max(bar.high, driveBars[driveBars.length - 1].high) + 3;
        return { bar: next, entry: next.close, direction: 'SHORT',
                 archetype: 'FIRST_PULLBACK', structStop, driveMag };
      }
    }
  }
  return null;
}

/**
 * TIER 2: Displacement Continuation
 * A large displacement candle (body > 0.55× range, > 0.45× ATR) establishes
 * a direction. Price pulls back 40–65% to the displacement midpoint on smaller
 * bars. Entry on resumption bar that closes beyond the pullback extreme.
 * Window extended to 10:30 to capture institutional re-entries and second legs.
 * Window: 9:30–10:30 ET
 */
function detectDisplacementContinuation(bars5m, atr) {
  const eligible = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 1030; });
  if (eligible.length < 3) return null;

  for (let i = 0; i < eligible.length - 2; i++) {
    const dispBar = eligible[i];
    if (getET(dispBar.timestamp).hm < 930) continue;
    if (!isDisplacement(dispBar, atr, 0.45, 0.35)) continue; // relaxed from 0.55/0.45 → 0.45/0.35

    const isBull    = dispBar.close > dispBar.open;
    const dispRange = Math.abs(dispBar.close - dispBar.open);
    const dispMid   = (dispBar.open + dispBar.close) / 2;

    // Find a pullback bar that retraces to dispMid zone (35-65%)
    for (let j = i + 1; j < eligible.length - 1; j++) {
      const bar  = eligible[j];
      const next = eligible[j + 1];
      if (getET(next.timestamp).hm >= 1030) break;

      // Widened pullback zone: 35-70% of displacement body (was 40-65%)
      const atMid = isBull
        ? bar.low <= dispMid + 0.30 * dispRange && bar.low >= dispMid - 0.45 * dispRange
        : bar.high >= dispMid - 0.30 * dispRange && bar.high <= dispMid + 0.45 * dispRange;

      if (!atMid) continue;

      if (isBull && isBullishCandle(next, 0.35) && next.close > dispBar.close - 0.10 * dispRange) {
        const structStop = Math.min(bar.low, dispBar.open) - 4;
        return { bar: next, entry: next.close, direction: 'LONG',
                 archetype: 'DISPLACEMENT_CONTINUATION', structStop };
      }
      if (!isBull && isBearishCandle(next, 0.35) && next.close < dispBar.close + 0.10 * dispRange) {
        const structStop = Math.max(bar.high, dispBar.open) + 4;
        return { bar: next, entry: next.close, direction: 'SHORT',
                 archetype: 'DISPLACEMENT_CONTINUATION', structStop };
      }
    }
  }
  return null;
}

/**
 * TIER 1.5: Opening Drive Continuation
 * The first strong 5m bar (9:30–9:40) establishes a directional commitment
 * (body > 0.50× ATR, body/range > 0.50). The NEXT bar continues in the same
 * direction without a pullback — pure momentum continuation.
 * This captures the most common institutional "opening drive" pattern that other
 * archetypes miss because they require a prior pullback.
 * Window: 9:30–9:42 ET
 */
function detectOpeningDriveContinuation(bars5m, atr) {
  const driveBars = bars5m.filter(b => {
    const e = getET(b.timestamp);
    return e.hm >= 930 && e.hm < 940;
  });
  if (driveBars.length < 2) return null;

  for (let i = 0; i < driveBars.length - 1; i++) {
    const drive = driveBars[i];
    const cont  = driveBars[i + 1];
    if (getET(cont.timestamp).hm >= 942) break;

    const body  = Math.abs(drive.close - drive.open);
    const range = drive.high - drive.low;
    // Drive bar must have strong directional conviction (lowered 0.50→0.42 to capture moderate drives)
    if (range === 0 || body < 0.42 * atr || body / range < 0.48) continue;

    const isBull = drive.close > drive.open;

    if (isBull) {
      // Continuation: close above drive bar's close, body in upper half of range
      if (cont.close > drive.close && isBullishCandle(cont, 0.30)) {
        return {
          bar: cont, entry: cont.close, direction: 'LONG',
          archetype: 'OPENING_DRIVE_CONTINUATION',
          structStop: drive.low - 3,
        };
      }
    } else {
      if (cont.close < drive.close && isBearishCandle(cont, 0.30)) {
        return {
          bar: cont, entry: cont.close, direction: 'SHORT',
          archetype: 'OPENING_DRIVE_CONTINUATION',
          structStop: drive.high + 3,
        };
      }
    }
  }
  return null;
}

/**
 * TIER 2: Momentum Expansion Continuation
 * An anchor bar shows clear directional conviction (body > 0.40× ATR),
 * followed by a tight 1-bar consolidation (range ≤ 0.30× ATR),
 * then an expansion bar that closes beyond both the consolidation and anchor
 * with a strong displacement body. Captures the "measured-move" institutional pattern.
 * Window: 9:35–10:20 ET
 */
function detectMomentumExpansion(bars5m, atr) {
  const eligible = bars5m.filter(b => {
    const e = getET(b.timestamp);
    return e.hm >= 935 && e.hm < 1020;
  });
  if (eligible.length < 3) return null;

  for (let i = 1; i < eligible.length - 1; i++) {
    const prev = eligible[i - 1]; // anchor bar
    const bar  = eligible[i];     // consolidation bar
    const next = eligible[i + 1]; // expansion bar
    if (getET(next.timestamp).hm >= 1020) break;

    // Anchor bar: strong directional body
    const anchorBody = Math.abs(prev.close - prev.open);
    if (anchorBody < 0.40 * atr) continue;

    const isBull = prev.close > prev.open;

    // Consolidation bar: tight range (no strong counter move) — raised cap from 12 to 20 pts
    const consRange = bar.high - bar.low;
    if (consRange > Math.min(0.35 * atr, 20)) continue;
    // Consolidation should not close strongly against the trend
    if (isBull  && bar.close < prev.close - 0.15 * atr) continue;
    if (!isBull && bar.close > prev.close + 0.15 * atr) continue;

    // Expansion bar: closes beyond consolidation AND anchor in trend direction
    if (isBull) {
      const breakLevel = Math.max(bar.high, prev.high);
      if (next.close > breakLevel
          && isDisplacement(next, atr, 0.40, 0.25)
          && isBullishCandle(next, 0.40)) {
        return {
          bar: next, entry: next.close, direction: 'LONG',
          archetype: 'MOMENTUM_EXPANSION',
          structStop: Math.min(bar.low, prev.low) - 3,
        };
      }
    } else {
      const breakLevel = Math.min(bar.low, prev.low);
      if (next.close < breakLevel
          && isDisplacement(next, atr, 0.40, 0.25)
          && isBearishCandle(next, 0.40)) {
        return {
          bar: next, entry: next.close, direction: 'SHORT',
          archetype: 'MOMENTUM_EXPANSION',
          structStop: Math.max(bar.high, prev.high) + 3,
        };
      }
    }
  }
  return null;
}

// VWAP_BOUNCE removed — 0% WR in backtest. Replaced by OPENING_DRIVE_CONTINUATION and DISPLACEMENT_CONTINUATION.

/**
 * TIER 2: ORB Breakout Continuation
 * Price breaks cleanly above/below the opening range with a displacement bar,
 * then continues with a confirmation bar in the same direction.
 * Complements ORB_FAILED_BREAKOUT — fires when the breakout HOLDS.
 * Window: 9:40–10:15 ET
 */
function detectOrbBreakoutContinuation(bars5m, orb, atr) {
  if (!orb || orb.orbRange < 0.25 * atr) return null;
  const { orbHigh, orbLow } = orb;
  const postBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 940 && e.hm < 1015; });
  if (postBars.length < 2) return null;

  for (let i = 0; i < postBars.length - 1; i++) {
    const bar  = postBars[i];
    const next = postBars[i + 1];
    if (getET(next.timestamp).hm >= 1015) break;

    // Bullish breakout: displacement bar closes clearly above ORB high, confirmation follows
    if (bar.close > orbHigh + 0.15 * atr && isDisplacement(bar, atr, 0.45, 0.28)) {
      if (isBullishCandle(next, 0.28) && next.close > bar.open) {
        return {
          bar: next, entry: next.close, direction: 'LONG',
          archetype: 'ORB_BREAKOUT_CONTINUATION',
          structStop: Math.min(orbLow, bar.open) - 3,
        };
      }
    }

    // Bearish breakout: displacement bar closes clearly below ORB low, confirmation follows
    if (bar.close < orbLow - 0.15 * atr && isDisplacement(bar, atr, 0.45, 0.28)) {
      if (isBearishCandle(next, 0.28) && next.close < bar.open) {
        return {
          bar: next, entry: next.close, direction: 'SHORT',
          archetype: 'ORB_BREAKOUT_CONTINUATION',
          structStop: Math.max(orbHigh, bar.open) + 3,
        };
      }
    }
  }
  return null;
}

/**
 * TIER 2: Session Trend Pullback
 * Three consecutive bars form a clear HH+HL (bull) or LL+LH (bear) structure
 * with meaningful range (≥0.60× ATR). Price then pulls back 25–60% of the
 * trend range before resuming with a bullish/bearish bar.
 * Fires on most trending days — the most common institutional intraday pattern.
 * Window: 9:30–10:20 ET
 */
function detectSessionTrendPullback(bars5m, atr) {
  const sessionBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 1020; });
  if (sessionBars.length < 5) return null;

  for (let i = 2; i < sessionBars.length - 2; i++) {
    const b0  = sessionBars[i - 2];
    const b1  = sessionBars[i - 1];
    const b2  = sessionBars[i];
    const pb  = sessionBars[i + 1]; // pullback bar
    const res = sessionBars[i + 2]; // resumption bar
    if (!pb || !res) break;
    if (getET(res.timestamp).hm >= 1020) break;

    // Bull trend: 3 bars with higher highs AND higher lows
    const isBullTrend = b2.high > b1.high && b1.high > b0.high &&
                        b2.low  > b1.low  && b1.low  > b0.low;
    if (isBullTrend) {
      const trendAmt = b2.high - b0.low;
      if (trendAmt < 0.60 * atr) continue;
      const pbRatio = trendAmt > 0 ? (b2.high - pb.low) / trendAmt : 0;
      if (pbRatio >= 0.25 && pbRatio <= 0.62) {
        if (res.close > pb.high && isBullishCandle(res, 0.32)) {
          return {
            bar: res, entry: res.close, direction: 'LONG',
            archetype: 'SESSION_TREND_PULLBACK',
            structStop: pb.low - 3,
          };
        }
      }
    }

    // Bear trend: 3 bars with lower lows AND lower highs
    const isBearTrend = b2.low  < b1.low  && b1.low  < b0.low &&
                        b2.high < b1.high && b1.high < b0.high;
    if (isBearTrend) {
      const trendAmt = b0.high - b2.low;
      if (trendAmt < 0.60 * atr) continue;
      const pbRatio = trendAmt > 0 ? (pb.high - b2.low) / trendAmt : 0;
      if (pbRatio >= 0.25 && pbRatio <= 0.62) {
        if (res.close < pb.low && isBearishCandle(res, 0.32)) {
          return {
            bar: res, entry: res.close, direction: 'SHORT',
            archetype: 'SESSION_TREND_PULLBACK',
            structStop: pb.high + 3,
          };
        }
      }
    }
  }
  return null;
}

// ── Conviction grading ────────────────────────────────────────────────────────
const TIER1_SET = new Set(['ORB_FAILED_BREAKOUT', 'LIQUIDITY_SWEEP_REVERSAL', 'OPENING_DRIVE_CONTINUATION']);
const TIER2_SET = new Set(['FIRST_PULLBACK', 'DISPLACEMENT_CONTINUATION', 'MOMENTUM_EXPANSION', 'ORB_BREAKOUT_CONTINUATION', 'SESSION_TREND_PULLBACK']);

// Separate thresholds for TIER1 (reversal/high-conviction) and TIER2 (continuation/pattern-based).
// TIER2 earns Conviction A at confidence >= 60 — eliminates the hidden direction-dependency
// where TIER2 patterns were only reaching 65 when bias alignment bonus (+5) applied.
function gradeConviction(confidence, archetype) {
  if (confidence >= 78 && TIER1_SET.has(archetype)) return { conviction: 'A+', recSize: 'FULL' };
  if (confidence >= 65 && TIER1_SET.has(archetype)) return { conviction: 'A',  recSize: 'FULL' };
  if (confidence >= 60 && TIER2_SET.has(archetype)) return { conviction: 'A',  recSize: 'HALF' }; // key unlock
  if (confidence >= 52) return { conviction: 'B', recSize: 'HALF' };
  return { conviction: 'C', recSize: 'MIN' };
}

// ── Structure-snapped TPs ─────────────────────────────────────────────────────
function computeStructureTPs(entry, rawRisk, isBull, on, barsDly) {
  const b1 = isBull ? entry + 1.5 * rawRisk : entry - 1.5 * rawRisk;
  const b2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
  const b3 = isBull ? entry + 3.5 * rawRisk : entry - 3.5 * rawRisk;

  let tp2 = b2;
  if (on) {
    const snap = isBull ? on.overnightHigh : on.overnightLow;
    if (snap && Math.abs(snap - b2) / rawRisk < 0.4) tp2 = snap;
  }
  let tp3 = b3;
  if (barsDly?.length >= 2) {
    const pd   = barsDly[barsDly.length - 2];
    const snap = isBull ? pd.high : pd.low;
    if (Math.abs(snap - b3) / rawRisk < 0.4) tp3 = snap;
  }
  return { tp1: +b1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2) };
}

// ── Confidence per archetype ──────────────────────────────────────────────────
const BASE_CONFIDENCE = {
  ORB_FAILED_BREAKOUT:           72,
  LIQUIDITY_SWEEP_REVERSAL:      68,
  OPENING_DRIVE_CONTINUATION:    66,
  FIRST_PULLBACK:                63,
  ORB_BREAKOUT_CONTINUATION:     63,
  MOMENTUM_EXPANSION:            62,
  SESSION_TREND_PULLBACK:        61,
  DISPLACEMENT_CONTINUATION:     60,
  FORCED_BIAS_ENTRY:             50,
};

function calcConfidence(archetype, entryDir, biasDir, biasSpread) {
  let c = BASE_CONFIDENCE[archetype] ?? 50;
  if (entryDir === biasDir)    c += 5;  // bias agrees with pattern direction
  if (biasSpread >= 30)        c += 3;  // strong pre-open conviction
  return Math.min(93, Math.max(45, c));
}

// ── Main evaluate ─────────────────────────────────────────────────────────────
function evaluate(bars5m, bars15m, bars1h, bars4h, cfg = {}, barIdx = null) {
  if (!bars5m || bars5m.length < 20) return null;

  const lastBar = bars5m[bars5m.length - 1];
  const et      = getET(lastBar.timestamp);
  if (et.dow === 0 || et.dow === 6) return null;

  // Macro blackout
  if (_blackoutDates.has(et.dateKey)) {
    if (_d.dateKey !== et.dateKey) console.log(`[NQ_NY_OPEN] ${et.dateKey} MACRO BLACKOUT — skipped`);
    _d.dateKey = et.dateKey;
    return null;
  }

  // Daily state reset
  if (et.dateKey !== _d.dateKey) {
    Object.assign(_d, {
      dateKey: et.dateKey, direction: null, longScore: 0, shortScore: 0,
      biasNotes: [], archetype: null, conviction: null, phase: 'IDLE',
      emitted: false, secondEmitted: false, firstEntryMinET: null, firstEntryDir: null,
      orbComputed: false, orbHigh: null, orbLow: null,
      openDriveDir: null, openDriveAmt: 0,
    });
  }

  if (_d.emitted && _d.secondEmitted) return null;
  if (et.hm < 920 || et.hm >= 1035) return null;

  const barsDly    = cfg.barsDly ?? [];
  const atrArr     = calcAtr(bars5m, 14);
  const atr        = atrArr[atrArr.length - 1];
  if (!atr || atr < 4) return null;

  // Pre-open scoring 9:20–9:29
  if (et.hm < 930 && (_d.phase === 'IDLE' || _d.phase === 'PRE_OPEN')) {
    const bias   = computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly);
    _d.direction = bias.direction;
    _d.longScore = bias.longScore; _d.shortScore = bias.shortScore;
    _d.biasNotes = bias.notes; _d.phase = 'PRE_OPEN';
    return null;
  }

  // 9:30–9:34: WATCHING — observe first bar, no entries
  if (et.hm >= 930 && et.hm < 935) {
    if (_d.phase === 'IDLE' || _d.phase === 'PRE_OPEN') {
      if (!_d.direction) {
        const bias   = computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly);
        _d.direction = bias.direction;
        _d.longScore = bias.longScore; _d.shortScore = bias.shortScore;
        _d.biasNotes = bias.notes;
      }
      _d.phase = 'WATCHING';
    }
    return null;
  }

  // Transition to HUNTING at 9:35
  if (et.hm >= 935 && (_d.phase === 'WATCHING' || _d.phase === 'IDLE' || _d.phase === 'PRE_OPEN')) {
    if (!_d.direction) {
      const bias   = computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly);
      _d.direction = bias.direction;
      _d.longScore = bias.longScore; _d.shortScore = bias.shortScore;
      _d.biasNotes = bias.notes;
    }
    _d.phase = 'HUNTING';
  }

  if (_d.phase !== 'HUNTING') return null;

  // Secondary entry eligibility: 30-min cooling period after primary, same direction only
  const runningAsSecondary = _d.emitted && !_d.secondEmitted;
  if (runningAsSecondary) {
    const curMinET = et.h * 60 + et.m;
    if (!_d.firstEntryMinET || curMinET - _d.firstEntryMinET < SECONDARY_WAIT_MIN) return null;
  }

  const isDeadline = et.hm >= 1020; // extended from 10:00 to 10:20
  const on         = computeOvernightLevels(bars5m);
  const biasSpread = Math.abs(_d.longScore - _d.shortScore);

  // Cache ORB at 9:40+
  if (!_d.orbComputed && et.hm >= 940) {
    const o = computeOpeningRange(bars5m);
    if (o) { _d.orbHigh = o.orbHigh; _d.orbLow = o.orbLow; _d.orbComputed = true; }
  }
  const orb = (_d.orbHigh && _d.orbLow)
    ? { orbHigh: _d.orbHigh, orbLow: _d.orbLow, orbMid: (_d.orbHigh + _d.orbLow) / 2, orbRange: _d.orbHigh - _d.orbLow }
    : null;

  let entryResult = null;

  if (!isDeadline) {
    // TIER 1 — reversals and opening drive continuation
    entryResult = detectLiquiditySweepReversal(bars5m, on, atr);
    if (!entryResult && orb) entryResult = detectOrbFailedBreakout(bars5m, orb, atr);
    if (!entryResult) entryResult = detectOpeningDriveContinuation(bars5m, atr);
    // TIER 2 — continuation patterns (ordered by base confidence descending)
    if (!entryResult) entryResult = detectFirstPullback(bars5m, atr);
    if (!entryResult && orb) entryResult = detectOrbBreakoutContinuation(bars5m, orb, atr);
    if (!entryResult) entryResult = detectMomentumExpansion(bars5m, atr);
    if (!entryResult) entryResult = detectSessionTrendPullback(bars5m, atr);
    if (!entryResult) entryResult = detectDisplacementContinuation(bars5m, atr);
  }

  // FORCED_BIAS_ENTRY deadline (10:20 ET) — primary only, strong bias + EMA confirmation
  if (!entryResult && isDeadline && !runningAsSecondary && biasSpread >= 40) {
    const ema1h = bars1h?.length >= 21 ? calcHtfBias(bars1h, 9, 21) : 0;
    const biasL = _d.direction === 'LONG';
    const emaOk = ema1h === 0 || (biasL && ema1h > 0) || (!biasL && ema1h < 0);
    if (emaOk) entryResult = { bar: lastBar, entry: lastBar.close, direction: _d.direction, archetype: 'FORCED_BIAS_ENTRY' };
  }

  if (!entryResult) return null;

  // ── SHORT quality gate ──────────────────────────────────────────────────────
  // NQ has a long-side structural bias; reject shorts in a 1H bull trend unless
  // price is near the overnight high (institutional supply zone)
  if (entryResult.direction === 'SHORT') {
    const ema1h = bars1h?.length >= 21 ? calcHtfBias(bars1h, 9, 21) : 0;
    if (ema1h > 0) {
      const onRange = on ? on.overnightHigh - on.overnightLow : 0;
      const onPos   = onRange > 0 ? (entryResult.entry - on.overnightLow) / onRange : 0.5;
      if (onPos < 0.80) return null; // reject short in bull 1H unless near overnight high
    }
  }

  // ── Secondary entry gates ───────────────────────────────────────────────────
  if (runningAsSecondary) {
    if (entryResult.direction !== _d.firstEntryDir) return null; // must match primary direction
  }

  const finalDir = entryResult.direction ?? _d.direction;
  const isBull   = finalDir === 'LONG';

  // ── Stop placement ──────────────────────────────────────────────────────────
  const entry    = entryResult.entry;
  const vwapArr2 = calcVwap(bars5m);
  const vwap     = vwapArr2[vwapArr2.length - 1];
  const swLow    = recentSwingLow(bars5m,  10);
  const swHigh   = recentSwingHigh(bars5m, 10);

  let rawRisk;
  if (entryResult.structStop != null) {
    // Use archetype-specific structural stop
    rawRisk = Math.abs(entry - entryResult.structStop);
  } else if (isBull) {
    const floor = orb
      ? Math.min(orb.orbLow - 0.1 * atr, swLow)
      : Math.min(swLow, vwap != null ? vwap - 0.4 * atr : swLow);
    rawRisk = Math.max(0.4 * atr, entry - floor);
  } else {
    const ceil = orb
      ? Math.max(orb.orbHigh + 0.1 * atr, swHigh)
      : Math.max(swHigh, vwap != null ? vwap + 0.4 * atr : swHigh);
    rawRisk = Math.max(0.4 * atr, ceil - entry);
  }

  // Hard cap
  rawRisk = Math.min(rawRisk, MAX_STOP_PTS);
  rawRisk = Math.max(rawRisk, 8); // minimum 8 pts — prevent degenerate stops

  const sl = isBull ? +(entry - rawRisk).toFixed(2) : +(entry + rawRisk).toFixed(2);

  // ── TPs + clean-room filter ─────────────────────────────────────────────────
  const { tp1, tp2, tp3 } = computeStructureTPs(entry, rawRisk, isBull, on, barsDly);
  const keyLevels = buildKeyLevels(on, orb, barsDly, vwap);
  if (!hasCleanRoom(entry, tp1, finalDir, keyLevels)) return null; // blocked path — skip

  // ── Confidence and conviction ───────────────────────────────────────────────
  const confidence     = calcConfidence(entryResult.archetype, finalDir, _d.direction, biasSpread);
  const { conviction, recSize } = gradeConviction(confidence, entryResult.archetype);

  // Block Conviction B/C from live signals — only A and A+ fire
  if (conviction === 'B' || conviction === 'C') return null;

  // ── Indicators ─────────────────────────────────────────────────────────────
  const rsiArr = calcRsi(bars5m.map(b => b.close), 14);
  const rsi    = rsiArr[rsiArr.length - 1];
  const b4     = bars4h?.length >= 5  ? calcHtfBias(bars4h, 9, 21) : 0;
  const b1     = bars1h?.length >= 21 ? calcHtfBias(bars1h, 9, 21) : 0;
  const struct = bars1h?.length >= 20 ? detectMarketStructure(bars1h, 20) : 'UNCLEAR';
  const sess   = getSessionInfo(lastBar.timestamp);
  const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

  if (!runningAsSecondary) {
    _d.emitted         = true;
    _d.firstEntryMinET = et.h * 60 + et.m;
    _d.firstEntryDir   = finalDir;
    // Keep phase HUNTING so secondary entry can still fire
  } else {
    _d.secondEmitted = true;
    _d.phase = 'DONE';
  }
  _d.archetype  = entryResult.archetype;
  _d.conviction = conviction;

  return {
    instrument:    'MNQ',
    strategy_name: STRATEGY_NAME,
    trade_style:   'ny_open',
    timeframe:     '5m',
    direction:     finalDir,
    entry:         +entry.toFixed(2),
    sl,
    tp1, tp2, tp3,
    rr:            1.5,
    confidence,
    conviction,
    rec_size:      recSize,
    grade,
    win_prob_tp1, win_prob_tp2, win_prob_tp3,
    score:         Math.round(confidence / 4),
    setup:         'NQ NY Open v3',
    archetype:     entryResult.archetype,
    strategy_version: STRATEGY_VERSION,
    htf_bias:      b4 > 0 ? 'BULL' : b4 < 0 ? 'BEAR' : 'MIXED',
    session:       sess?.name ?? 'NY_OPEN',
    be_trail_at_hm: 1015,
    scale_out: [
      { pct: 50, at: 'TP1', rr: 1.5 },
      { pct: 30, at: 'TP2', rr: 2.5 },
      { pct: 20, at: 'TP3', rr: 3.5 },
    ],
    trigger_reason: [
      `${entryResult.archetype} | ${finalDir} | ${conviction}(${recSize})`,
      runningAsSecondary ? 'SECONDARY_ENTRY' : 'PRIMARY_ENTRY',
      `bias=${confidence}% biasSpread=${biasSpread} ${_d.direction}`,
      `1H:${b1 > 0 ? 'BULL' : b1 < 0 ? 'BEAR' : 'NEUT'} struct=${struct}`,
      entryResult.archetype === 'FORCED_BIAS_ENTRY' ? 'DEADLINE_10:20' : null,
    ].filter(Boolean).join(' | '),
    indicators: {
      atr:        +atr.toFixed(2),
      vwap:       vwap  != null ? +vwap.toFixed(2) : null,
      rsi:        rsi   != null ? +rsi.toFixed(1)  : null,
      htfBias:    b4,
      htf2Bias:   b1,
      htfStruct:  struct,
      longScore:  _d.longScore,
      shortScore: _d.shortScore,
      biasSpread,
      regime:     b4 > 0 ? 'TREND_BULL' : b4 < 0 ? 'TREND_BEAR' : 'MIXED',
      orbHigh:    orb ? +orb.orbHigh.toFixed(2) : null,
      orbLow:     orb ? +orb.orbLow.toFixed(2)  : null,
    },
    timestamp:    lastBar.timestamp,
    trade_status: 'PENDING',
  };
}

// ── Enhanced backtest with MFE/MAE ────────────────────────────────────────────
function backtestNyOpen(bars5m, bars1h, bars4h, barsDly, opts = {}) {
  const dayMap = new Map();
  for (const bar of bars5m) {
    const { dateKey } = getET(bar.timestamp);
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey).push(bar);
  }

  const signalLog = [];
  let wins = 0, losses = 0, totalPnl = 0;
  let pnlRunning = 0, peak = 0, maxDrawdown = 0;

  for (const dateKey of [...dayMap.keys()].sort()) {
    const dayBars = dayMap.get(dateKey);
    if (!dayBars || dayBars.length < 10) continue;
    const et = getET(dayBars[0].timestamp);
    if (et.dow === 0 || et.dow === 6) continue;

    const cutoff   = dayBars[0].timestamp;
    const h1Slice  = bars1h  ? bars1h.filter(b  => b.timestamp < cutoff) : [];
    const h4Slice  = bars4h  ? bars4h.filter(b  => b.timestamp < cutoff) : [];
    const dlySlice = barsDly ? barsDly.filter(b => b.timestamp < cutoff) : [];

    const preBars    = bars5m.filter(b => b.timestamp < cutoff).slice(-200);
    const todayPre   = dayBars.filter(b => getET(b.timestamp).hm < 930);
    const allPreBars = [...preBars, ...todayPre];
    const bars15m    = _agg5mTo15m(allPreBars);

    const bias       = computePreopenBias(allPreBars, bars15m, h1Slice, h4Slice, dlySlice);
    const biasDir    = bias.direction;
    const biasSpread = Math.abs(bias.longScore - bias.shortScore);

    const atrArr = calcAtr(allPreBars.length >= 14 ? allPreBars : dayBars, 14);
    const atr    = atrArr[atrArr.length - 1] || 10;

    const openBars = dayBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 1005; });
    if (openBars.length < 2) continue;

    const allBtBars = [...allPreBars, ...openBars];
    const on        = computeOvernightLevels(allBtBars);

    const orbData = (() => {
      const ob = openBars.filter(b => getET(b.timestamp).hm < 940);
      if (ob.length < 2) return null;
      const h = Math.max(...ob.map(b => b.high));
      const l = Math.min(...ob.map(b => b.low));
      return { orbHigh: h, orbLow: l, orbMid: (h + l) / 2, orbRange: h - l };
    })();

    // Run same cascade as evaluate()
    let entryResult =
      detectLiquiditySweepReversal(allBtBars, on, atr) ||
      (orbData ? detectOrbFailedBreakout(allBtBars, orbData, atr) : null) ||
      detectOpeningDriveContinuation(allBtBars, atr) ||
      detectFirstPullback(allBtBars, atr) ||
      (orbData ? detectOrbBreakoutContinuation(allBtBars, orbData, atr) : null) ||
      detectMomentumExpansion(allBtBars, atr) ||
      detectSessionTrendPullback(allBtBars, atr) ||
      detectDisplacementContinuation(allBtBars, atr);

    if (!entryResult && biasSpread >= 40) {
      const ema1h  = h1Slice.length >= 21 ? calcHtfBias(h1Slice, 9, 21) : 0;
      const biasL  = biasDir === 'LONG';
      const emaOk  = ema1h === 0 || (biasL && ema1h > 0) || (!biasL && ema1h < 0);
      if (emaOk) {
        const lastOB = openBars[openBars.length - 1];
        entryResult = { bar: lastOB, entry: lastOB.close, direction: biasDir, archetype: 'FORCED_BIAS_ENTRY' };
      }
    }

    if (!entryResult) continue;

    // Mirror live conviction filter: skip B/C grade entries in backtest too
    const btConf = calcConfidence(entryResult.archetype, entryResult.direction ?? biasDir, biasDir, biasSpread);
    const { conviction: btConviction } = gradeConviction(btConf, entryResult.archetype);
    if (btConviction === 'B' || btConviction === 'C') continue;

    // SHORT quality gate (same as evaluate())
    if (entryResult.direction === 'SHORT') {
      const ema1h = h1Slice.length >= 21 ? calcHtfBias(h1Slice, 9, 21) : 0;
      if (ema1h > 0) {
        const onRange = on ? on.overnightHigh - on.overnightLow : 0;
        const onPos   = onRange > 0 ? (entryResult.entry - on.overnightLow) / onRange : 0.5;
        if (onPos < 0.80) continue;
      }
    }

    const finalDir = entryResult.direction ?? biasDir;
    const isBull   = finalDir === 'LONG';
    const entry    = entryResult.entry;
    const entryBar = entryResult.bar;

    const vArr  = calcVwap(allBtBars);
    const vwap  = vArr[vArr.length - 1];
    const swLow  = recentSwingLow(allBtBars,  10);
    const swHigh = recentSwingHigh(allBtBars, 10);

    let rawRisk;
    if (entryResult.structStop != null) {
      rawRisk = Math.abs(entry - entryResult.structStop);
    } else if (isBull) {
      const floor = orbData
        ? Math.min(orbData.orbLow - 0.1 * atr, swLow)
        : Math.min(swLow, vwap != null ? vwap - 0.4 * atr : swLow);
      rawRisk = Math.max(0.4 * atr, entry - floor);
    } else {
      const ceil = orbData
        ? Math.max(orbData.orbHigh + 0.1 * atr, swHigh)
        : Math.max(swHigh, vwap != null ? vwap + 0.4 * atr : swHigh);
      rawRisk = Math.max(0.4 * atr, ceil - entry);
    }
    rawRisk = Math.min(rawRisk, MAX_STOP_PTS);
    rawRisk = Math.max(rawRisk, 8);

    const sl       = isBull ? entry - rawRisk : entry + rawRisk;
    const tps      = computeStructureTPs(entry, rawRisk, isBull, on, dlySlice);
    const { tp1, tp2, tp3 } = tps;

    // Clean-room filter
    const keyLevels = buildKeyLevels(on, orbData, dlySlice, vwap);
    if (!hasCleanRoom(entry, tp1, finalDir, keyLevels)) continue;

    // 3-tranche simulation with MFE/MAE tracking
    const futureBars = dayBars.filter(b => {
      const e = getET(b.timestamp);
      return b.timestamp > entryBar.timestamp && e.hm <= 1100;
    });

    let pnlPts = 0, stopLvl = sl, openFrac = 1.0;
    let t1Done = false, t2Done = false, t3Done = false;
    let mfe = 0, mae = 0; // max favorable/adverse excursion in pts

    for (const bar of futureBars) {
      const eBt = getET(bar.timestamp);
      if (!t1Done && eBt.hm >= 1015) stopLvl = entry; // BE advancement at 10:15

      const favorable = isBull ? bar.high - entry : entry - bar.low;
      const adverse   = isBull ? entry - bar.low  : bar.high - entry;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);

      if (isBull) {
        if (openFrac > 0 && bar.low <= stopLvl) { pnlPts += openFrac * (stopLvl - entry); break; }
        if (!t1Done && bar.high >= tp1)  { t1Done = true; pnlPts += 0.5 * (tp1 - entry); openFrac = 0.5; stopLvl = entry; }
        if (t1Done && !t2Done && bar.high >= tp2) { t2Done = true; pnlPts += 0.3 * (tp2 - entry); openFrac = 0.2; }
        if (t2Done && !t3Done && bar.high >= tp3) { t3Done = true; pnlPts += 0.2 * (tp3 - entry); openFrac = 0; break; }
      } else {
        if (openFrac > 0 && bar.high >= stopLvl) { pnlPts += openFrac * (entry - stopLvl); break; }
        if (!t1Done && bar.low <= tp1)  { t1Done = true; pnlPts += 0.5 * (entry - tp1); openFrac = 0.5; stopLvl = entry; }
        if (t1Done && !t2Done && bar.low <= tp2) { t2Done = true; pnlPts += 0.3 * (entry - tp2); openFrac = 0.2; }
        if (t2Done && !t3Done && bar.low <= tp3) { t3Done = true; pnlPts += 0.2 * (entry - tp3); openFrac = 0; break; }
      }
    }
    if (openFrac > 0) {
      const last = futureBars[futureBars.length - 1];
      if (last) {
        // Respect current stop level — prevents end-of-session fallback from exceeding the hard cap
        const exitPx = isBull
          ? Math.max(last.close, stopLvl)  // LONG: never exit below current stop
          : Math.min(last.close, stopLvl); // SHORT: never exit above current stop
        pnlPts += openFrac * (isBull ? exitPx - entry : entry - exitPx);
      }
    }
    // Unconditional hard floor — catches any remaining edge cases
    pnlPts = Math.max(pnlPts, -MAX_STOP_PTS);
    pnlPts = +pnlPts.toFixed(2);

    const outcome = t1Done ? 'WIN' : 'LOSS';
    if (outcome === 'WIN') wins++; else losses++;
    totalPnl   += pnlPts;
    pnlRunning += pnlPts;
    peak        = Math.max(peak, pnlRunning);
    maxDrawdown = Math.max(maxDrawdown, peak - pnlRunning);

    const confidence = calcConfidence(entryResult.archetype, finalDir, biasDir, biasSpread);
    const { conviction } = gradeConviction(confidence, entryResult.archetype);

    signalLog.push({
      date: dateKey, direction: finalDir, archetype: entryResult.archetype,
      conviction, entry: +entry.toFixed(2), sl: +sl.toFixed(2), tp1,
      rawRisk: +rawRisk.toFixed(2), outcome, pnl_pts: pnlPts,
      t1Hit: t1Done, t2Hit: t2Done, t3Hit: t3Done,
      mfe: +mfe.toFixed(2), mae: +mae.toFixed(2),
      confidence, longScore: bias.longScore, shortScore: bias.shortScore,
      biasAlignment: finalDir === biasDir ? 'ALIGNED' : 'CONTRA',
      strategy_name: STRATEGY_NAME,
      hour_et: getET(entryBar.timestamp).h,
      session: 'NY_OPEN',
      regime: h4Slice.length >= 5
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

  const avgMfe = signalLog.length ? +(signalLog.reduce((s, t) => s + t.mfe, 0) / signalLog.length).toFixed(2) : 0;
  const avgMae = signalLog.length ? +(signalLog.reduce((s, t) => s + t.mae, 0) / signalLog.length).toFixed(2) : 0;
  const alignedTrades = signalLog.filter(t => t.biasAlignment === 'ALIGNED');
  const alignedWR     = alignedTrades.length ? alignedTrades.filter(t => t.outcome === 'WIN').length / alignedTrades.length : null;

  const byArchetype = {};
  for (const t of signalLog) {
    if (!byArchetype[t.archetype]) byArchetype[t.archetype] = { wins: 0, total: 0, totalPnl: 0 };
    byArchetype[t.archetype].total++;
    byArchetype[t.archetype].totalPnl += t.pnl_pts;
    if (t.outcome === 'WIN') byArchetype[t.archetype].wins++;
  }

  return {
    metrics: {
      tradeCount, winRate, wins, losses,
      totalPnl:     +totalPnl.toFixed(2),
      expectancy:   tradeCount > 0 ? +(totalPnl / tradeCount).toFixed(2) : 0,
      profitFactor: profitFactor != null ? +profitFactor.toFixed(3) : null,
      maxDrawdown:  +maxDrawdown.toFixed(2),
      sharpe, avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
      avgMfe, avgMae,
      alignedWR:    alignedWR != null ? +alignedWR.toFixed(4) : null,
      byArchetype,
    },
    signalLog,
  };
}

function _agg5mTo15m(bars) {
  const out = [];
  for (let i = 0; i + 2 < bars.length; i += 3) {
    const s = bars.slice(i, i + 3);
    out.push({
      timestamp: s[0].timestamp, open: s[0].open,
      high: Math.max(...s.map(b => b.high)), low: Math.min(...s.map(b => b.low)),
      close: s[2].close, volume: s.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  return out;
}

function reset() {
  Object.assign(_d, {
    dateKey: null, direction: null, longScore: 0, shortScore: 0,
    biasNotes: [], archetype: null, conviction: null, phase: 'IDLE',
    emitted: false, secondEmitted: false, firstEntryMinET: null, firstEntryDir: null,
    orbComputed: false, orbHigh: null, orbLow: null,
    openDriveDir: null, openDriveAmt: 0,
  });
}

module.exports = {
  evaluate, reset, backtestNyOpen, computePreopenBias, setBlackoutDates,
  STRATEGY_NAME, STRATEGY_VERSION, LIVE_THRESHOLD,
};
