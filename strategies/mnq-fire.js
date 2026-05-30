'use strict';

/**
 * STRATEGY — MNQ FIRE v1.2
 * Futures Institutional Reaction Engine
 *
 * ── Philosophy ────────────────────────────────────────────────────────────────
 * The market is an auction. It engineers liquidity sweeps — pushing price through
 * key levels to trigger stop-orders — then reverses once that liquidity is consumed.
 * FIRE attacks exactly those moments: sweep → institutional displacement → CHoCH.
 *
 * ── FIRE acronym ──────────────────────────────────────────────────────────────
 *   F — Find liquidity   (ONH/ONL/PDH/PDL/ORB/London/Equal H&L)
 *   I — Identify displacement (large body + FVG creation after sweep)
 *   R — React — Change of Character (CHoCH confirms structure flip)
 *   E — Execute at FVG limit or CHoCH bar close
 *
 * ── Sessions ──────────────────────────────────────────────────────────────────
 *   Primary:   NY Open    9:30–10:30 ET  (entry window 9:44–10:30)
 *   Secondary: Power Hour 15:00–16:15 ET (CORE + AGGRESSIVE variants)
 *
 * ── Variants ──────────────────────────────────────────────────────────────────
 *   CONSERVATIVE: minScore 9/10, maxStop 22 pts, FVG limit only
 *   CORE:         minScore 7/10, maxStop 35 pts, FVG or strong-CHoCH market entry, +Power Hour
 *   AGGRESSIVE:   minScore 6/10, maxStop 35 pts, any-CHoCH market entry, +Power Hour
 *
 * ── v1.1 improvements ─────────────────────────────────────────────────────────
 *   • Sweep wick dominance gate (upper/lower wick ≥ 35% of bar range)
 *   • Displacement close-strength: must close in bottom/top 30% of range
 *   • Tightened CHoCH: weak path now requires close beyond all prior swing lows/highs
 *   • Session-anchored VWAP (9:30 ET anchor, not rolling average)
 *   • Volume spike bonus on sweep bar (≥1.4× prior 10-bar avg → +3 confidence pts)
 *   • Multi-pool confluence bonus (2+ Tier 1 pools within 2×ATR → +2 confidence pts)
 *   • FVG entry stop uses FVG boundary (tighter RR) instead of sweep extreme
 *
 * ── v1.2 improvements (frequency + accuracy) ─────────────────────────────────
 *   • Power Hour enabled for CORE (was AGGRESSIVE-only) → +50% sessions
 *   • Delayed FVG fill: if CHoCH fires on bar X and FVG fills on bar X+1/+2/+3,
 *     look back up to 3 bars for prior CHoCH when current bar touches FVG zone
 *   • FVG touch zone widened: 0.10→0.20×ATR (catches near-misses)
 *   • Market entry gated on CHoCH strength: CORE requires strong CHoCH (not disp-as-CHoCH)
 *     to market-enter — weak CHoCH must wait for FVG fill (backtest shows 27% WR on
 *     weak-CHoCH market entries vs 100% WR on FVG_LIMIT entries)
 */

const {
  calcAtr, calcVwap, calcHtfBias,
  isBullishCandle, isBearishCandle,
  detectMarketStructure, getSessionInfo,
} = require('./shared-indicators');

const { deriveGradeAndProbs } = require('./confidence-scorer');

const STRATEGY_NAME    = 'MNQ_FIRE';
const STRATEGY_VERSION = '1.3';
const MAX_STOP_PTS     = 35;
const EQUAL_TOL        = 3;   // pts — two highs/lows within 3 pts → "equal level" (BSL/SSL)

// ── Variant configuration ─────────────────────────────────────────────────────
// maxNyTrades/maxPhTrades/maxLondonTrades: signals allowed per session per day
// strongChochOnly: true  → market entry requires real structure break (not disp-as-CHoCH)
// skipShorts: true       → long-only (shorts currently 14% WR, needs separate model)
const VARIANT_CFG = {
  CONSERVATIVE:  { minScore: 9, maxStop: 22, atrMin: 14, allowPowerHour: false, allowLondon: false, marketEntry: false, strongChochOnly: true,  skipShorts: false, maxNyTrades: 1, maxPhTrades: 0, maxLondonTrades: 0 },
  CORE:          { minScore: 7, maxStop: 35, atrMin: 12, allowPowerHour: true,  allowLondon: true,  marketEntry: true,  strongChochOnly: true,  skipShorts: false, maxNyTrades: 2, maxPhTrades: 2, maxLondonTrades: 2 },
  AGGRESSIVE:    { minScore: 6, maxStop: 35, atrMin: 10, allowPowerHour: true,  allowLondon: true,  marketEntry: true,  strongChochOnly: false, skipShorts: false, maxNyTrades: 3, maxPhTrades: 3, maxLondonTrades: 3 },
  HIGH_FREQ:     { minScore: 6, maxStop: 35, atrMin: 10, allowPowerHour: true,  allowLondon: true,  marketEntry: true,  strongChochOnly: false, skipShorts: false, maxNyTrades: 4, maxPhTrades: 4, maxLondonTrades: 4 },
  LONG_ONLY:     { minScore: 7, maxStop: 35, atrMin: 12, allowPowerHour: true,  allowLondon: true,  marketEntry: true,  strongChochOnly: true,  skipShorts: true,  maxNyTrades: 3, maxPhTrades: 3, maxLondonTrades: 3 },
  INSTITUTIONAL: { minScore: 9, maxStop: 22, atrMin: 14, allowPowerHour: true,  allowLondon: false, marketEntry: false, strongChochOnly: true,  skipShorts: false, maxNyTrades: 1, maxPhTrades: 1, maxLondonTrades: 0 },
};

// ── Macro blackout ────────────────────────────────────────────────────────────
const _blackoutDates = new Set();
function setBlackoutDates(dates) {
  _blackoutDates.clear();
  for (const d of (dates || [])) _blackoutDates.add(d);
}

// ── Daily state ───────────────────────────────────────────────────────────────
const _d = {
  dateKey:       null,
  nyCount:       0,   // signals emitted in NY Open this day
  phCount:       0,   // signals emitted in Power Hour this day
  londonCount:   0,   // signals emitted in London session this day
  lastSignalHm:  -1,  // ET hm of last signal (prevent back-to-back within 15 min)
  orbHigh:       null,
  orbLow:        null,
  orbComputed:   false,
};

// ── ET time helper ────────────────────────────────────────────────────────────
function getET(ts) {
  const d = new Date(ts);
  try {
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return {
      h:       et.getHours(),
      m:       et.getMinutes(),
      hm:      et.getHours() * 100 + et.getMinutes(),
      dow:     et.getDay(),
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

// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDITY POOL COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

function computeOvernightLevels(bars5m) {
  const ov = bars5m.slice(-Math.min(150, bars5m.length)).filter(b => {
    const e = getET(b.timestamp);
    return e.hm < 930 || e.hm >= 1600;
  });
  if (ov.length < 3) return null;
  return { high: Math.max(...ov.map(b => b.high)), low: Math.min(...ov.map(b => b.low)) };
}

function computeLondonLevels(bars5m) {
  const l = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 300 && e.hm < 830; });
  if (l.length < 3) return null;
  return { high: Math.max(...l.map(b => b.high)), low: Math.min(...l.map(b => b.low)) };
}

// Find equal highs/lows: 2+ bars whose high/low falls within EQUAL_TOL pts.
// These are buy-side (BSL) and sell-side (SSL) liquidity pools.
function findEqualLevels(bars, lookback = 60) {
  const slice  = bars.slice(-Math.min(lookback, bars.length));
  const eqH    = [];
  const eqL    = [];

  for (let i = 0; i < slice.length; i++) {
    const h = slice[i].high;
    const l = slice[i].low;
    let cntH = 0, cntL = 0;
    for (let j = 0; j < slice.length; j++) {
      if (i === j) continue;
      if (Math.abs(slice[j].high - h) <= EQUAL_TOL) cntH++;
      if (Math.abs(slice[j].low  - l) <= EQUAL_TOL) cntL++;
    }
    if (cntH >= 1 && !eqH.some(v => Math.abs(v - h) <= EQUAL_TOL)) eqH.push(+h.toFixed(2));
    if (cntL >= 1 && !eqL.some(v => Math.abs(v - l) <= EQUAL_TOL)) eqL.push(+l.toFixed(2));
  }
  return { eqH, eqL };
}

/**
 * Assemble all active liquidity pools for the current session.
 * Each pool: { name, level, side:'BSL'|'SSL', tier:1|2 }
 */
function computeAllPools(bars5m, barsDly, orbHigh, orbLow) {
  const pools = [];

  const on = computeOvernightLevels(bars5m);
  if (on) {
    pools.push({ name: 'ONH', level: on.high, side: 'BSL', tier: 1 });
    pools.push({ name: 'ONL', level: on.low,  side: 'SSL', tier: 1 });
  }

  if (barsDly?.length >= 2) {
    const pd = barsDly[barsDly.length - 2];
    if (pd) {
      pools.push({ name: 'PDH', level: pd.high, side: 'BSL', tier: 1 });
      pools.push({ name: 'PDL', level: pd.low,  side: 'SSL', tier: 1 });
    }
  }

  if (orbHigh && orbLow) {
    pools.push({ name: 'ORB_HIGH', level: orbHigh, side: 'BSL', tier: 1 });
    pools.push({ name: 'ORB_LOW',  level: orbLow,  side: 'SSL', tier: 1 });
  }

  const london = computeLondonLevels(bars5m);
  if (london) {
    pools.push({ name: 'LONDON_HIGH', level: london.high, side: 'BSL', tier: 2 });
    pools.push({ name: 'LONDON_LOW',  level: london.low,  side: 'SSL', tier: 2 });
  }

  const { eqH, eqL } = findEqualLevels(bars5m, 60);
  for (const h of eqH) pools.push({ name: 'EQUAL_HIGH', level: h, side: 'BSL', tier: 2 });
  for (const l of eqL) pools.push({ name: 'EQUAL_LOW',  level: l, side: 'SSL', tier: 2 });

  return pools;
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if `bar` is a sweep of any pool level.
 * A sweep = wick past the level + close BACK INSIDE the level.
 * Returns { pool, poolLevel, poolTier, sweepExtreme, direction } or null.
 * Prefer the highest-tier (lowest tier number) match.
 */
function checkSweep(bar, pools, atr) {
  let best = null;
  const range = bar.high - bar.low;
  for (const p of pools) {
    // BSL sweep → SHORT: wick above level, close below
    if (p.side === 'BSL'
        && bar.high > p.level + 0.08 * atr
        && bar.close < p.level) {
      // Wick dominance: upper wick must be ≥ 35% of bar range — filters noise wicks
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      if (range === 0 || upperWick / range < 0.35) continue;
      if (!best || p.tier < best.poolTier) {
        best = { pool: p.name, poolLevel: p.level, poolTier: p.tier,
                 sweepExtreme: bar.high, direction: 'SHORT' };
      }
    }
    // SSL sweep → LONG: wick below level, close above
    if (p.side === 'SSL'
        && bar.low < p.level - 0.08 * atr
        && bar.close > p.level) {
      // Wick dominance: lower wick must be ≥ 35% of bar range
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      if (range === 0 || lowerWick / range < 0.35) continue;
      if (!best || p.tier < best.poolTier) {
        best = { pool: p.name, poolLevel: p.level, poolTier: p.tier,
                 sweepExtreme: bar.low, direction: 'LONG' };
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLACEMENT + FVG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan a slice of bars for a bearish/bullish FVG (3-bar imbalance).
 * Bearish FVG: bar[i+2].high < bar[i].low  — downward gap.
 * Bullish FVG: bar[i+2].low  > bar[i].high — upward gap.
 */
function findFVG(bars, direction, lookback = 5) {
  const slice = bars.slice(-Math.min(lookback + 2, bars.length));
  for (let i = 0; i < slice.length - 2; i++) {
    const [b1, , b3] = [slice[i], slice[i + 1], slice[i + 2]];
    if (direction === 'SHORT' && b3.high < b1.low) {
      return { type: 'BEAR', high: b1.low, low: b3.high, mid: (b1.low + b3.high) / 2 };
    }
    if (direction === 'LONG' && b3.low > b1.high) {
      return { type: 'BULL', high: b3.low, low: b1.high, mid: (b3.low + b1.high) / 2 };
    }
  }
  return null;
}

/**
 * Check if `bar` is a displacement candle consistent with `direction`.
 * Displacement = strong-body, correct-direction candle that closes in the
 * bottom/top 30% of its range (institutional conviction close).
 */
function isDisplacement(bar, atr, direction) {
  const body  = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low;
  if (range === 0 || body / range < 0.45 || body < 0.35 * atr) return false;
  // Close-strength: bar must close in the bottom 30% (SHORT) or top 30% (LONG) of its range.
  // A bearish displacement closing mid-range lacks institutional conviction.
  const closeRatio = (bar.close - bar.low) / range;
  if (direction === 'SHORT') return bar.close < bar.open && closeRatio <= 0.30;
  return bar.close > bar.open && closeRatio >= 0.70;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE OF CHARACTER (CHoCH)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a sweep + displacement, confirm that market structure has shifted.
 *
 * SHORT CHoCH: Current bar closes below the lowest close in the sweep→disp window.
 * LONG  CHoCH: Current bar closes above the highest close in the sweep→disp window.
 *
 * Also accepts "displacement-as-CHoCH": the displacement bar itself breaks a prior
 * swing, common on strong institutional opens where two bars signal sweep + CHoCH.
 *
 * @param {object[]} windowBars  bars from sweep through (but not including) current
 * @param {object}   currentBar  the bar being evaluated as the CHoCH
 * @param {string}   direction   'SHORT' | 'LONG'
 * @param {number}   atr
 * @returns {{ chochLevel: number, isDispChoCH: boolean } | null}
 */
function detectChoCH(windowBars, currentBar, direction, atr) {
  if (!windowBars.length) return null;

  if (direction === 'SHORT') {
    const priorSwingLow = Math.min(...windowBars.map(b => b.low));
    // Strong CHoCH: close clearly below prior window low (cushioned break)
    if (currentBar.close < priorSwingLow - 0.05 * atr) {
      return { chochLevel: priorSwingLow, isDispChoCH: false };
    }
    // Tightened weak CHoCH: must close below ALL prior swing lows — a real structural break,
    // not just lower than some prior close (original path was too permissive).
    if (currentBar.close < priorSwingLow) {
      return { chochLevel: priorSwingLow, isDispChoCH: true };
    }
  } else {
    const priorSwingHigh = Math.max(...windowBars.map(b => b.high));
    if (currentBar.close > priorSwingHigh + 0.05 * atr) {
      return { chochLevel: priorSwingHigh, isDispChoCH: false };
    }
    // Tightened weak CHoCH: must close above ALL prior swing highs
    if (currentBar.close > priorSwingHigh) {
      return { chochLevel: priorSwingHigh, isDispChoCH: true };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEAN ROOM — path to TP1 not blocked by a key pool
// ─────────────────────────────────────────────────────────────────────────────
function hasCleanRoom(entry, tp1, direction, pools) {
  const dist = Math.abs(tp1 - entry);
  if (dist === 0) return false;
  for (const p of pools) {
    if (direction === 'SHORT' && p.level < entry && p.level > tp1) {
      if (Math.abs(p.level - entry) < 0.55 * dist) return false;
    }
    if (direction === 'LONG'  && p.level > entry && p.level < tp1) {
      if (Math.abs(p.level - entry) < 0.55 * dist) return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKLIST SCORING (0–10)
// ─────────────────────────────────────────────────────────────────────────────
function scoreChecklist({
  poolTier, sweepWick, displacement, choch, fvg,
  biasAligned, vwapAligned, htfAligned, cleanRoom, fvgEntry,
}) {
  return (
    (poolTier === 1  ? 1 : 0) +   // 1 = Tier 1 pool swept (ONH/ONL/PDH/PDL/ORB)
    (sweepWick       ? 1 : 0) +   // 2 = clear wick beyond level, closes inside
    (displacement    ? 1 : 0) +   // 3 = displacement candle confirmed
    (choch           ? 1 : 0) +   // 4 = CHoCH confirmed
    (fvg             ? 1 : 0) +   // 5 = FVG created by displacement
    (biasAligned     ? 1 : 0) +   // 6 = pre-open / HTF bias aligns
    (vwapAligned     ? 1 : 0) +   // 7 = VWAP on correct side
    (htfAligned      ? 1 : 0) +   // 8 = 1H EMA aligned with direction
    (cleanRoom       ? 1 : 0) +   // 9 = clean path to TP1
    (fvgEntry        ? 1 : 0)     // 10 = entering at FVG (sniper precision)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE FROM CHECKLIST
// ─────────────────────────────────────────────────────────────────────────────
function checklistToConfidence(score, poolTier, biasSpread, { volumeSpike = false, poolConfluence = false } = {}) {
  let c = 52 + score * 4;           // 52 base → max raw 92 at score=10
  if (poolTier === 1)    c += 4;    // Tier 1 pool adds institutional precision
  if (biasSpread >= 30)  c += 2;    // strong pre-open bias agreement
  if (volumeSpike)       c += 3;    // institutional volume on sweep bar
  if (poolConfluence)    c += 2;    // 2+ Tier 1 pools clustered at same zone
  return Math.min(93, Math.max(45, c));
}

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURE-SNAPPED TAKE PROFITS
// ─────────────────────────────────────────────────────────────────────────────
function computeTPs(entry, rawRisk, direction, pools) {
  const isBull = direction === 'LONG';
  const tp1 = isBull ? entry + 1.5 * rawRisk : entry - 1.5 * rawRisk;
  const tp2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
  let   tp3 = isBull ? entry + 3.5 * rawRisk : entry - 3.5 * rawRisk;

  // Snap TP3 to nearest opposing liquidity pool if within 0.4R
  for (const p of pools) {
    if (isBull && p.side === 'BSL' && p.level > tp2) {
      if (Math.abs(p.level - tp3) / rawRisk < 0.4) { tp3 = p.level; break; }
    }
    if (!isBull && p.side === 'SSL' && p.level < tp2) {
      if (Math.abs(p.level - tp3) / rawRisk < 0.4) { tp3 = p.level; break; }
    }
  }

  return { tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EVALUATE
// ─────────────────────────────────────────────────────────────────────────────
function evaluate(bars5m, bars15m, bars1h, bars4h, cfg = {}, barIdx = null) {
  if (!bars5m || bars5m.length < 30) return null;

  const variantKey = cfg.mnqFireVariant ?? 'CORE';
  const variant    = VARIANT_CFG[variantKey] ?? VARIANT_CFG.CORE;

  const lastBar = bars5m[bars5m.length - 1];
  const et      = getET(lastBar.timestamp);
  if (et.dow === 0 || et.dow === 6) return null;

  // Macro blackout
  if (_blackoutDates.has(et.dateKey)) return null;

  // Daily state reset
  if (et.dateKey !== _d.dateKey) {
    Object.assign(_d, { dateKey: et.dateKey, nyCount: 0, phCount: 0, londonCount: 0,
                        lastSignalHm: -1, orbHigh: null, orbLow: null, orbComputed: false });
  }

  // Session gating
  const inNY     = et.hm >= 930  && et.hm < 1030;
  const inPH     = et.hm >= 1500 && et.hm < 1615 && variant.allowPowerHour;
  const inLondon = et.hm >= 330  && et.hm < 530  && variant.allowLondon;
  if (!inNY && !inPH && !inLondon) return null;
  if (inNY     && _d.nyCount     >= (variant.maxNyTrades     ?? 1)) return null;
  if (inPH     && _d.phCount     >= (variant.maxPhTrades     ?? 1)) return null;
  if (inLondon && _d.londonCount >= (variant.maxLondonTrades ?? 1)) return null;

  // Minimum 3 bars (15 min) between signals — no back-to-back spam
  if (_d.lastSignalHm >= 0) {
    const minGap = 15;
    const elapsed = et.hm - _d.lastSignalHm;
    if (elapsed >= 0 && elapsed < minGap) return null;
  }

  // Entry window: London 3:45+, NY discovery (9:30-9:44) observation only
  const inEntryWindow = (inNY && et.hm >= 944)
    || (inPH && et.hm >= 1500 && et.hm < 1610)
    || (inLondon && et.hm >= 345);
  if (!inEntryWindow) return null;

  // ATR gate
  const atrArr = calcAtr(bars5m, 14);
  const atr    = atrArr[atrArr.length - 1];
  if (!atr || atr < variant.atrMin) return null;

  // Cache ORB at 9:40+
  if (!_d.orbComputed && inNY && et.hm >= 940) {
    const orbBars = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 940; });
    if (orbBars.length >= 2) {
      _d.orbHigh     = Math.max(...orbBars.map(b => b.high));
      _d.orbLow      = Math.min(...orbBars.map(b => b.low));
      _d.orbComputed = true;
    }
  }

  const barsDly = cfg.barsDly ?? [];
  const pools   = computeAllPools(bars5m, barsDly, _d.orbHigh, _d.orbLow);
  if (!pools.length) return null;

  // ── Core FIRE sequence scan ──────────────────────────────────────────────
  // Scan backward through recent bars for: sweep → displacement → CHoCH(currentBar)
  // The sweep must occur in the valid sweep window; the current bar IS the CHoCH.
  const SCAN_DEPTH = 10;
  const scanStart  = Math.max(0, bars5m.length - SCAN_DEPTH);
  const scanBars   = bars5m.slice(scanStart);
  const curBar     = scanBars[scanBars.length - 1]; // current (last) bar

  // Define valid sweep window per session
  const sweepWindowOk = (b) => {
    const e = getET(b.timestamp);
    if (inNY)     return e.hm >= 930  && e.hm < 1020;
    if (inPH)     return e.hm >= 1500 && e.hm < 1605;
    if (inLondon) return e.hm >= 300  && e.hm < 520;
    return false;
  };

  for (let si = 0; si < scanBars.length - 2; si++) {
    const sweepBar = scanBars[si];
    if (!sweepWindowOk(sweepBar)) continue;
    if (sweepBar.timestamp >= curBar.timestamp) continue; // sweep must precede current

    const sweep = checkSweep(sweepBar, pools, atr);
    if (!sweep) continue;

    // Volume spike on sweep bar (≥1.4× prior 10-bar average volume)
    let volumeSpike = false;
    if (sweepBar.volume != null) {
      const sweepGlobalIdx = scanStart + si;
      const priorVolBars = bars5m.slice(Math.max(0, sweepGlobalIdx - 10), sweepGlobalIdx);
      if (priorVolBars.length >= 5) {
        const avgVol = priorVolBars.reduce((s, b) => s + (b.volume || 0), 0) / priorVolBars.length;
        if (avgVol > 0) volumeSpike = sweepBar.volume >= 1.4 * avgVol;
      }
    }

    // Multi-pool confluence: 2+ Tier 1 pools clustering within 2×ATR of swept level
    const tier1Near    = pools.filter(p => p.tier === 1 && Math.abs(p.level - sweep.poolLevel) <= 2 * atr);
    const poolConfluence = tier1Near.length >= 2;

    const direction = sweep.direction;
    const isBull    = direction === 'LONG';

    // Find displacement in the 1–3 bars immediately after the sweep
    let disp     = null;
    let dispIdx  = -1;
    let fvg      = null;

    for (let di = si + 1; di < Math.min(si + 4, scanBars.length - 1); di++) {
      if (isDisplacement(scanBars[di], atr, direction)) {
        disp    = scanBars[di];
        dispIdx = di;
        // Scan for FVG in the bars immediately around the displacement
        fvg = findFVG(scanBars.slice(Math.max(0, di - 1), di + 3), direction, 5);
        break;
      }
    }
    if (!disp) continue;

    // CHoCH: current bar must confirm structure shift (primary check)
    const windowBars = scanBars.slice(si, scanBars.length - 1); // sweep through (not including) current
    let choch = detectChoCH(windowBars, curBar, direction, atr);
    let isDelayedFvgFill = false;

    // Delayed FVG fill: if primary CHoCH didn't fire on curBar but curBar is pulling
    // back into the FVG zone, look back up to 3 bars for a prior CHoCH confirmation.
    // Catches the common pattern: sweep→disp→CHoCH(bar X)→pullback to FVG(bar X+1/+2).
    if (!choch && fvg) {
      const nowInFvg = isBull
        ? curBar.low  <= fvg.high + 0.20 * atr
        : curBar.high >= fvg.low  - 0.20 * atr;
      if (nowInFvg) {
        for (let back = 1; back <= 3; back++) {
          const priorIdx    = scanBars.length - 1 - back;
          if (priorIdx <= si) break;
          const priorWindow = scanBars.slice(si, priorIdx);
          if (!priorWindow.length) break;
          choch = detectChoCH(priorWindow, scanBars[priorIdx], direction, atr);
          if (choch) { isDelayedFvgFill = true; break; }
        }
      }
    }
    if (!choch) continue;

    // ── Entry price ──────────────────────────────────────────────────────────
    let entry;
    let isFvgEntry = false;

    if (fvg) {
      // Delayed fill: CHoCH already confirmed, current bar is in FVG zone
      // Direct fill: current bar touches FVG zone (widened to 0.20×ATR from 0.10×ATR)
      const inZone = isDelayedFvgFill || (isBull
        ? curBar.low  <= fvg.high + 0.20 * atr && curBar.close >= fvg.low
        : curBar.high >= fvg.low  - 0.20 * atr && curBar.close <= fvg.high);
      if (inZone) {
        entry      = +fvg.mid.toFixed(2);
        isFvgEntry = true;
      }
    }

    if (!entry) {
      if (!variant.marketEntry) continue; // CONSERVATIVE: FVG limit only
      // CORE: only market-enter on strong CHoCH — weak CHoCH (disp-as-CHoCH) must
      // wait for FVG fill. Backtest shows 27% WR on weak-CHoCH market entries.
      if (variant.strongChochOnly && choch.isDispChoCH) continue;
      entry = +curBar.close.toFixed(2);
    }

    // ── Stop loss ────────────────────────────────────────────────────────────
    // FVG entry: stop at FVG far boundary (tighter RR vs structural sweep stop).
    // Market entry: structural stop behind sweep extreme + buffer.
    const sweepStop = isBull ? sweep.sweepExtreme - 3 : sweep.sweepExtreme + 3;
    let stopRef;
    if (isFvgEntry && fvg) {
      const fvgBoundaryStop = isBull ? fvg.low - 2 : fvg.high + 2;
      // Only use FVG boundary if genuinely tighter than structural stop
      stopRef = Math.abs(entry - fvgBoundaryStop) < Math.abs(entry - sweepStop)
        ? fvgBoundaryStop : sweepStop;
    } else {
      stopRef = sweepStop;
    }
    let rawRisk = Math.abs(entry - stopRef);
    rawRisk     = Math.min(rawRisk, variant.maxStop ?? MAX_STOP_PTS);
    rawRisk     = Math.max(rawRisk, 8);
    const sl    = isBull ? +(entry - rawRisk).toFixed(2) : +(entry + rawRisk).toFixed(2);

    // ── TPs ──────────────────────────────────────────────────────────────────
    const { tp1, tp2, tp3 } = computeTPs(entry, rawRisk, direction, pools);

    // ── SHORT quality gate (NQ structural long bias) ──────────────────────
    if (direction === 'SHORT') {
      if (variant.skipShorts) continue; // LONG_ONLY mode
      const ema4h = bars4h?.length >= 5  ? calcHtfBias(bars4h, 9, 21) : 0;
      const ema1h = bars1h?.length >= 21 ? calcHtfBias(bars1h, 9, 21) : 0;
      // Require 4H to be bearish/flat — never short into a 4H uptrend (killed 14% WR)
      if (ema4h > 0) continue;
      if (ema1h > 0) {
        // When 1H still bullish: only short if price is in upper 35% of overnight range
        const on = computeOvernightLevels(bars5m);
        if (on) {
          const onRange = on.high - on.low;
          const onPos   = onRange > 0 ? (entry - on.low) / onRange : 0.5;
          if (onPos < 0.65) continue;
        }
      }
    }

    // ── Context ──────────────────────────────────────────────────────────────
    // Session-anchored VWAP: anchor at 9:30 ET (not rolling) for NY Open precision
    const sessionBars5m = bars5m.filter(b => { const e = getET(b.timestamp); return e.hm >= 930; });
    const vwapSrc  = sessionBars5m.length >= 2 ? sessionBars5m : bars5m;
    const vwapArr  = calcVwap(vwapSrc);
    const vwap     = vwapArr[vwapArr.length - 1];
    const b1Bias   = bars1h?.length >= 21 ? calcHtfBias(bars1h, 9, 21) : 0;
    const b4Bias   = bars4h?.length >= 5  ? calcHtfBias(bars4h, 9, 21) : 0;
    const struct   = bars1h?.length >= 20 ? detectMarketStructure(bars1h, 20) : 'UNCLEAR';

    const vwapAligned  = vwap != null && (isBull ? entry > vwap : entry < vwap);
    const htfAligned   = (isBull && b1Bias >= 0) || (!isBull && b1Bias <= 0);
    const biasAligned  = (isBull && b4Bias >= 0) || (!isBull && b4Bias <= 0);
    const biasSpread   = Math.abs(b4Bias) * 25; // approximate
    const cleanPath    = hasCleanRoom(entry, tp1, direction, pools);
    if (!cleanPath) continue;

    // ── Checklist ────────────────────────────────────────────────────────────
    const checklistScore = scoreChecklist({
      poolTier:    sweep.poolTier,
      sweepWick:   true,
      displacement:true,
      choch:       !choch.isDispChoCH,  // full CHoCH = 1 pt; disp-as-choch = 0 pt (already counted as displacement)
      fvg:         fvg != null,
      biasAligned,
      vwapAligned,
      htfAligned,
      cleanRoom:   true,
      fvgEntry:    isFvgEntry,
    });

    if (checklistScore < (variant.minScore ?? 7)) continue;

    const confidence = checklistToConfidence(checklistScore, sweep.poolTier, biasSpread, { volumeSpike, poolConfluence });
    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
    const sess = getSessionInfo(lastBar.timestamp);

    // Mark daily trade emitted
    if (inNY)     _d.nyCount++;
    else if (inPH) _d.phCount++;
    else           _d.londonCount++;
    _d.lastSignalHm = et.hm;

    return {
      instrument:       'MNQ',
      strategy_name:    STRATEGY_NAME,
      trade_style:      'ny_open',
      timeframe:        '5m',
      direction,
      entry,
      sl,
      tp1, tp2, tp3,
      rr:               +(Math.abs(tp1 - entry) / rawRisk).toFixed(2),
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3,
      score:            Math.round(confidence / 4),
      setup:            `MNQ FIRE v${STRATEGY_VERSION}`,
      archetype:        `${sweep.pool}_SWEEP_REVERSAL`,
      strategy_version: STRATEGY_VERSION,
      htf_bias:         b4Bias > 0 ? 'BULL' : b4Bias < 0 ? 'BEAR' : 'MIXED',
      session:          sess?.name ?? (inNY ? 'NY_OPEN' : inPH ? 'POWER_HOUR' : 'LONDON'),
      be_trail_at_hm:   inNY ? 1015 : inLondon ? 500 : 1545,
      scale_out: [
        { pct: 50, at: 'TP1', rr: 1.5 },
        { pct: 30, at: 'TP2', rr: 2.5 },
        { pct: 20, at: 'TP3', rr: 3.5 },
      ],
      trigger_reason: [
        `${sweep.pool}_SWEEP | ${direction} | score=${checklistScore}/10`,
        `entry_type=${isFvgEntry ? (isDelayedFvgFill ? 'DELAYED_FVG_LIMIT' : 'FVG_LIMIT') : 'CHOCH_MARKET'}`,
        `sweep_extreme=${sweep.sweepExtreme.toFixed(2)} pool_level=${sweep.poolLevel.toFixed(2)}`,
        fvg ? `fvg=[${fvg.low.toFixed(2)}-${fvg.high.toFixed(2)}]` : null,
        `disp_atr=${(Math.abs(disp.close - disp.open) / atr).toFixed(2)}x`,
        choch.isDispChoCH ? 'DISP_AS_CHOCH' : `choch_level=${choch.chochLevel.toFixed(2)}`,
        volumeSpike ? 'VOL_SPIKE' : null,
        poolConfluence ? `POOL_CONFLUENCE(${tier1Near.map(p => p.name).join('+')})` : null,
        `1H:${b1Bias > 0 ? 'BULL' : b1Bias < 0 ? 'BEAR' : 'NEUT'} struct=${struct}`,
        `variant=${variantKey}`,
      ].filter(Boolean).join(' | '),
      indicators: {
        atr:                   +atr.toFixed(2),
        vwap:                  vwap != null ? +vwap.toFixed(2) : null,
        htfBias:               b4Bias,
        htf2Bias:              b1Bias,
        htfStruct:             struct,
        swept_pool:            sweep.pool,
        pool_tier:             sweep.poolTier,
        sweep_extreme:         +sweep.sweepExtreme.toFixed(2),
        pool_level:            +sweep.poolLevel.toFixed(2),
        displacement_atr_ratio:+(Math.abs(disp.close - disp.open) / atr).toFixed(2),
        fvg_high:              fvg ? +fvg.high.toFixed(2) : null,
        fvg_low:               fvg ? +fvg.low.toFixed(2)  : null,
        choch_confirmed:       !choch.isDispChoCH,
        entry_type:            isFvgEntry ? (isDelayedFvgFill ? 'DELAYED_FVG_LIMIT' : 'FVG_LIMIT') : 'CHOCH_MARKET',
        checklist_score:       checklistScore,
        volume_spike:          volumeSpike,
        pool_confluence:       poolConfluence,
        variant:               variantKey,
        orbHigh:               _d.orbHigh ? +_d.orbHigh.toFixed(2) : null,
        orbLow:                _d.orbLow  ? +_d.orbLow.toFixed(2)  : null,
      },
      timestamp:        lastBar.timestamp,
      trade_status:     'PENDING',
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST
// ─────────────────────────────────────────────────────────────────────────────
function backtestMnqFire(bars5m, bars1h, bars4h, barsDly, opts = {}) {
  const variantKey = opts.variant ?? 'CORE';
  const variant    = VARIANT_CFG[variantKey] ?? VARIANT_CFG.CORE;

  // Group bars into daily buckets
  const dayMap = new Map();
  for (const bar of bars5m) {
    const { dateKey } = getET(bar.timestamp);
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey).push(bar);
  }

  const signalLog  = [];
  let wins = 0, losses = 0, totalPnl = 0;
  let pnlRunning = 0, peak = 0, maxDrawdown = 0;

  for (const dateKey of [...dayMap.keys()].sort()) {
    const dayBars = dayMap.get(dateKey);
    if (!dayBars || dayBars.length < 10) continue;
    const { dow } = getET(dayBars[0].timestamp);
    if (dow === 0 || dow === 6) continue;

    // Blackout
    if (_blackoutDates.has(dateKey)) continue;

    const cutoff    = dayBars[0].timestamp;
    const h1Slice   = bars1h  ? bars1h.filter(b  => b.timestamp < cutoff) : [];
    const h4Slice   = bars4h  ? bars4h.filter(b  => b.timestamp < cutoff) : [];
    const dlySlice  = barsDly ? barsDly.filter(b => b.timestamp < cutoff) : [];
    const preBars5m = bars5m.filter(b => b.timestamp < cutoff).slice(-200);

    // Build ORB for the day
    const orbBars = dayBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 940; });
    const orbHigh = orbBars.length >= 2 ? Math.max(...orbBars.map(b => b.high)) : null;
    const orbLow  = orbBars.length >= 2 ? Math.min(...orbBars.map(b => b.low))  : null;

    let dayNyCount     = 0;
    let dayPhCount     = 0;
    let dayLondonCount = 0;
    let lastSigHm      = -1;

    // Walk through all entry window bars across all sessions
    const entryBars = dayBars.filter(b => {
      const e = getET(b.timestamp);
      const inNYw = e.hm >= 944 && e.hm < 1030;
      const inPHw = e.hm >= 1500 && e.hm < 1610 && variant.allowPowerHour;
      const inLdw = e.hm >= 345  && e.hm < 530   && variant.allowLondon;
      return inNYw || inPHw || inLdw;
    });

    for (let bi = 0; bi < entryBars.length; bi++) {
      const barEt   = getET(entryBars[bi].timestamp);
      const isNYBar = barEt.hm >= 944 && barEt.hm < 1030;
      const isPHBar = barEt.hm >= 1500 && barEt.hm < 1610;
      const isLdBar = barEt.hm >= 345  && barEt.hm < 530;
      if (isNYBar && dayNyCount     >= (variant.maxNyTrades     ?? 1)) continue;
      if (isPHBar && dayPhCount     >= (variant.maxPhTrades     ?? 1)) continue;
      if (isLdBar && dayLondonCount >= (variant.maxLondonTrades ?? 1)) continue;
      if (lastSigHm >= 0 && barEt.hm - lastSigHm >= 0 && barEt.hm - lastSigHm < 15) continue;

      const allBars = [...preBars5m, ...dayBars.slice(0, dayBars.indexOf(entryBars[bi]) + 1)];
      if (allBars.length < 30) continue;

      const atrArr = calcAtr(allBars, 14);
      const atr    = atrArr[atrArr.length - 1];
      if (!atr || atr < variant.atrMin) continue;

      const pools = computeAllPools(allBars, dlySlice, orbHigh, orbLow);
      if (!pools.length) continue;

      const scanStart = Math.max(0, allBars.length - 12);
      const scanBars  = allBars.slice(scanStart);
      const curBar    = scanBars[scanBars.length - 1];

      let btSignal = null;

      for (let si = 0; si < scanBars.length - 2 && !btSignal; si++) {
        const sweepBar = scanBars[si];
        const sweepET  = getET(sweepBar.timestamp);
        const sweepOk  = (isNYBar && sweepET.hm >= 930 && sweepET.hm < 1020)
                      || (isPHBar && sweepET.hm >= 1500 && sweepET.hm < 1605)
                      || (isLdBar && sweepET.hm >= 300  && sweepET.hm < 520);
        if (!sweepOk) continue;
        if (sweepBar.timestamp >= curBar.timestamp) continue;

        const sweep = checkSweep(sweepBar, pools, atr);
        if (!sweep) continue;

        // Volume spike on sweep bar
        let volumeSpike = false;
        if (sweepBar.volume != null) {
          const sweepGlobalIdx = allBars.length - (scanBars.length - si);
          const priorVolBars = allBars.slice(Math.max(0, sweepGlobalIdx - 10), sweepGlobalIdx);
          if (priorVolBars.length >= 5) {
            const avgVol = priorVolBars.reduce((s, b) => s + (b.volume || 0), 0) / priorVolBars.length;
            if (avgVol > 0) volumeSpike = sweepBar.volume >= 1.4 * avgVol;
          }
        }

        // Multi-pool confluence: 2+ Tier 1 pools within 2×ATR of swept level
        const tier1Near    = pools.filter(p => p.tier === 1 && Math.abs(p.level - sweep.poolLevel) <= 2 * atr);
        const poolConfluence = tier1Near.length >= 2;

        const direction = sweep.direction;
        const isBull    = direction === 'LONG';

        // SHORT quality gate
        if (direction === 'SHORT') {
          if (variant.skipShorts) continue;
          const ema4h = h4Slice.length >= 5  ? calcHtfBias(h4Slice, 9, 21) : 0;
          const ema1h = h1Slice.length >= 21 ? calcHtfBias(h1Slice, 9, 21) : 0;
          if (ema4h > 0) continue; // never short into 4H uptrend
          if (ema1h > 0) {
            const on = computeOvernightLevels(allBars);
            if (on) {
              const onRange = on.high - on.low;
              const onPos   = onRange > 0 ? (sweep.sweepExtreme - on.low) / onRange : 0.5;
              if (onPos < 0.65) continue;
            }
          }
        }

        let disp = null, fvg = null;
        for (let di = si + 1; di < Math.min(si + 4, scanBars.length - 1); di++) {
          if (isDisplacement(scanBars[di], atr, direction)) {
            disp = scanBars[di];
            fvg  = findFVG(scanBars.slice(Math.max(0, di - 1), di + 3), direction, 5);
            break;
          }
        }
        if (!disp) continue;

        const windowBars = scanBars.slice(si, scanBars.length - 1);
        let choch = detectChoCH(windowBars, curBar, direction, atr);
        let isDelayedFvgFill = false;

        if (!choch && fvg) {
          const nowInFvg = isBull
            ? curBar.low  <= fvg.high + 0.20 * atr
            : curBar.high >= fvg.low  - 0.20 * atr;
          if (nowInFvg) {
            for (let back = 1; back <= 3; back++) {
              const priorIdx    = scanBars.length - 1 - back;
              if (priorIdx <= si) break;
              const priorWindow = scanBars.slice(si, priorIdx);
              if (!priorWindow.length) break;
              choch = detectChoCH(priorWindow, scanBars[priorIdx], direction, atr);
              if (choch) { isDelayedFvgFill = true; break; }
            }
          }
        }
        if (!choch) continue;

        let entry, isFvgEntry = false;
        if (fvg) {
          const inZone = isDelayedFvgFill || (isBull
            ? curBar.low  <= fvg.high + 0.20 * atr && curBar.close >= fvg.low
            : curBar.high >= fvg.low  - 0.20 * atr && curBar.close <= fvg.high);
          if (inZone) { entry = +fvg.mid.toFixed(2); isFvgEntry = true; }
        }
        if (!entry) {
          if (!variant.marketEntry) continue;
          if (variant.strongChochOnly && choch.isDispChoCH) continue;
          entry = +curBar.close.toFixed(2);
        }

        const btSweepStop = isBull ? sweep.sweepExtreme - 3 : sweep.sweepExtreme + 3;
        let btStopRef;
        if (isFvgEntry && fvg) {
          const fvgBoundaryStop = isBull ? fvg.low - 2 : fvg.high + 2;
          btStopRef = Math.abs(entry - fvgBoundaryStop) < Math.abs(entry - btSweepStop)
            ? fvgBoundaryStop : btSweepStop;
        } else {
          btStopRef = btSweepStop;
        }
        let rawRisk = Math.abs(entry - btStopRef);
        rawRisk = Math.min(rawRisk, variant.maxStop ?? MAX_STOP_PTS);
        rawRisk = Math.max(rawRisk, 8);
        const sl = isBull ? entry - rawRisk : entry + rawRisk;

        const { tp1, tp2, tp3 } = computeTPs(entry, rawRisk, direction, pools);
        if (!hasCleanRoom(entry, tp1, direction, pools)) continue;

        const btSessionBars = allBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930; });
        const vwapSrcBt = btSessionBars.length >= 2 ? btSessionBars : allBars;
        const vwapArr = calcVwap(vwapSrcBt);
        const vwap    = vwapArr[vwapArr.length - 1];
        const b1Bias  = h1Slice.length >= 21 ? calcHtfBias(h1Slice, 9, 21) : 0;
        const b4Bias  = h4Slice.length >= 5  ? calcHtfBias(h4Slice, 9, 21) : 0;

        const vwapAligned = vwap != null && (isBull ? entry > vwap : entry < vwap);
        const htfAligned  = (isBull && b1Bias >= 0) || (!isBull && b1Bias <= 0);
        const biasAligned = (isBull && b4Bias >= 0) || (!isBull && b4Bias <= 0);

        const checklistScore = scoreChecklist({
          poolTier: sweep.poolTier, sweepWick: true, displacement: true,
          choch: !choch.isDispChoCH, fvg: fvg != null,
          biasAligned, vwapAligned, htfAligned, cleanRoom: true, fvgEntry: isFvgEntry,
        });
        if (checklistScore < (variant.minScore ?? 7)) continue;

        const btSession = isNYBar ? 'NY_OPEN' : isPHBar ? 'POWER_HOUR' : 'LONDON';
        btSignal = { entry, sl, tp1, tp2, tp3, rawRisk, direction, isBull, sweep, checklistScore,
                     entryBar: curBar, fvg, choch, b1Bias, b4Bias, biasAligned, isFvgEntry,
                     volumeSpike, poolConfluence, biasSpread: Math.abs(b4Bias) * 25, btSession };
      }

      if (!btSignal) continue;
      if (isNYBar) dayNyCount++;
      else if (isPHBar) dayPhCount++;
      else dayLondonCount++;
      lastSigHm = barEt.hm;

      const { entry, sl, tp1, tp2, tp3, rawRisk, direction, isBull,
              sweep, checklistScore, entryBar, b1Bias, b4Bias, biasAligned, isFvgEntry,
              volumeSpike: btVolSpike, poolConfluence: btPoolConf, biasSpread: btBiasSpread,
              btSession } = btSignal;

      // Simulate trade (11:00 ET time stop)
      const futureBars = dayBars.filter(b => {
        const e = getET(b.timestamp);
        return b.timestamp > entryBar.timestamp && e.hm <= 1100;
      });

      let pnlPts = 0, stopLvl = sl, openFrac = 1.0;
      let t1Done = false, t2Done = false, t3Done = false;
      let mfe = 0, mae = 0;

      for (const bar of futureBars) {
        const ebt = getET(bar.timestamp);
        // Breakeven at 10:15
        if (!t1Done && ebt.hm >= 1015) stopLvl = entry;

        const favorable = isBull ? bar.high - entry : entry - bar.low;
        const adverse   = isBull ? entry - bar.low  : bar.high - entry;
        mfe = Math.max(mfe, favorable);
        mae = Math.max(mae, adverse);

        if (isBull) {
          if (openFrac > 0 && bar.low  <= stopLvl) { pnlPts += openFrac * (stopLvl - entry); break; }
          if (!t1Done && bar.high >= tp1) { t1Done = true; pnlPts += 0.5 * (tp1 - entry); openFrac = 0.5; stopLvl = entry; }
          if (t1Done && !t2Done && bar.high >= tp2) { t2Done = true; pnlPts += 0.3 * (tp2 - entry); openFrac = 0.2; }
          if (t2Done && !t3Done && bar.high >= tp3) { t3Done = true; pnlPts += 0.2 * (tp3 - entry); openFrac = 0; break; }
        } else {
          if (openFrac > 0 && bar.high >= stopLvl) { pnlPts += openFrac * (entry - stopLvl); break; }
          if (!t1Done && bar.low  <= tp1) { t1Done = true; pnlPts += 0.5 * (entry - tp1); openFrac = 0.5; stopLvl = entry; }
          if (t1Done && !t2Done && bar.low  <= tp2) { t2Done = true; pnlPts += 0.3 * (entry - tp2); openFrac = 0.2; }
          if (t2Done && !t3Done && bar.low  <= tp3) { t3Done = true; pnlPts += 0.2 * (entry - tp3); openFrac = 0; break; }
        }
      }

      if (openFrac > 0 && futureBars.length) {
        const last   = futureBars[futureBars.length - 1];
        const exitPx = isBull ? Math.max(last.close, stopLvl) : Math.min(last.close, stopLvl);
        pnlPts += openFrac * (isBull ? exitPx - entry : entry - exitPx);
      }
      pnlPts = Math.max(pnlPts, -MAX_STOP_PTS);
      pnlPts = +pnlPts.toFixed(2);

      const outcome = t1Done ? 'WIN' : 'LOSS';
      if (outcome === 'WIN') wins++; else losses++;
      totalPnl   += pnlPts;
      pnlRunning += pnlPts;
      peak        = Math.max(peak, pnlRunning);
      maxDrawdown = Math.max(maxDrawdown, peak - pnlRunning);

      signalLog.push({
        date: dateKey, direction, archetype: `${sweep.pool}_SWEEP_REVERSAL`,
        pool: sweep.pool, poolTier: sweep.poolTier,
        entry: +entry.toFixed(2), sl: +sl.toFixed(2), tp1, rawRisk: +rawRisk.toFixed(2),
        outcome, pnl_pts: pnlPts, t1Hit: t1Done, t2Hit: t2Done, t3Hit: t3Done,
        mfe: +mfe.toFixed(2), mae: +mae.toFixed(2),
        checklistScore, isFvgEntry, volumeSpike: btVolSpike, poolConfluence: btPoolConf,
        biasAlignment: biasAligned ? 'ALIGNED' : 'CONTRA',
        htf1Bias: b1Bias, htf4Bias: b4Bias,
        strategy_name: STRATEGY_NAME,
        variant: variantKey,
        hour_et: getET(entryBar.timestamp).h,
        session: btSession,
        regime: h4Slice.length >= 5
          ? (calcHtfBias(h4Slice, 9, 21) > 0 ? 'TREND_BULL' : calcHtfBias(h4Slice, 9, 21) < 0 ? 'TREND_BEAR' : 'MIXED')
          : 'UNKNOWN',
      });
    }
  }

  const tradeCount   = wins + losses;
  const winRate      = tradeCount > 0 ? wins / tradeCount : 0;
  const wTrades      = signalLog.filter(t => t.outcome === 'WIN');
  const lTrades      = signalLog.filter(t => t.outcome === 'LOSS');
  const avgWin       = wTrades.length ? wTrades.reduce((s, t) => s + t.pnl_pts, 0) / wTrades.length : 0;
  const avgLoss      = lTrades.length ? Math.abs(lTrades.reduce((s, t) => s + t.pnl_pts, 0) / lTrades.length) : 0;
  const profitFactor = avgLoss > 0 ? +(wins * avgWin / (losses * avgLoss)).toFixed(3) : null;
  const returns      = signalLog.map(t => t.pnl_pts);
  const mean         = returns.reduce((s, v) => s + v, 0) / (returns.length || 1);
  const variance     = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const sharpe       = variance > 0 ? +(mean / Math.sqrt(variance) * Math.sqrt(252)).toFixed(3) : null;

  const byPool = {};
  for (const t of signalLog) {
    if (!byPool[t.pool]) byPool[t.pool] = { wins: 0, total: 0, totalPnl: 0 };
    byPool[t.pool].total++;
    byPool[t.pool].totalPnl += t.pnl_pts;
    if (t.outcome === 'WIN') byPool[t.pool].wins++;
  }

  const avgMfe = signalLog.length ? +(signalLog.reduce((s, t) => s + t.mfe, 0) / signalLog.length).toFixed(2) : 0;
  const avgMae = signalLog.length ? +(signalLog.reduce((s, t) => s + t.mae, 0) / signalLog.length).toFixed(2) : 0;

  return {
    metrics: {
      tradeCount, winRate, wins, losses,
      totalPnl:     +totalPnl.toFixed(2),
      expectancy:   tradeCount > 0 ? +(totalPnl / tradeCount).toFixed(2) : 0,
      profitFactor,
      maxDrawdown:  +maxDrawdown.toFixed(2),
      sharpe, avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
      avgMfe, avgMae,
      byPool,
      variant: variantKey,
    },
    signalLog,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
function reset() {
  Object.assign(_d, { dateKey: null, nyCount: 0, phCount: 0, londonCount: 0,
                      lastSignalHm: -1, orbHigh: null, orbLow: null, orbComputed: false });
}

module.exports = {
  evaluate, reset, backtestMnqFire, setBlackoutDates,
  STRATEGY_NAME, STRATEGY_VERSION, VARIANT_CFG,
  // Exported helpers for testing / inspector
  computeAllPools, checkSweep, findFVG, isDisplacement, detectChoCH, scoreChecklist,
};
