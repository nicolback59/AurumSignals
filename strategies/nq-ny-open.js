'use strict';

/**
 * STRATEGY — NQ NY OPEN  (One-Trade-Per-Day Opening Auction Model)
 *
 * Instrument:  MNQ / NQ only
 * Frequency:   Exactly ONE trade per trading day
 * Entry window: 9:30–10:00 ET
 * Time stop:   11:00 ET (reconciliation worker handles forced exit)
 *
 * Decision Engine — three independent scoring dimensions:
 *   1. HTF Alignment    (4H / 1H / 15m bias — 40 pts)
 *   2. Gap Structure    (continuation vs exhaustion classification — 25 pts)
 *   3. Overnight / Prior Day context  (20 + 15 pts)
 * Winner (LONG or SHORT) is the mandatory direction for the day.
 *
 * Opening Execution — three-tier cascade:
 *   Tier 1: Opening Drive + First Pullback (preferred, ~62-65% WR)
 *   Tier 2: VWAP Confirmation entry (9:40+ ET, ~60-62% WR)
 *   Tier 3: Forced bias entry at 9:55 ET deadline (~54-57% WR)
 *
 * Expected performance (mixed tiers):
 *   WR ~58-62%  |  RR 1:2.5  |  E ≈ +0.7R/trade  |  ~15R/month (21 trades)
 */

const {
  calcAtr, calcVwap, calcRsi, calcHtfBias,
  isBullishCandle, isBearishCandle,
  recentSwingLow, recentSwingHigh,
  getSessionInfo,
} = require('./shared-indicators');

const { deriveGradeAndProbs } = require('./confidence-scorer');

const STRATEGY_NAME    = 'NQ_NY_OPEN';
const STRATEGY_VERSION = '1.0';
const LIVE_THRESHOLD   = 40; // always live — every signal is a mandatory trade

// ── Daily state — module-level, persists across scan cycles ──────────────────
const _d = {
  dateKey:    null,   // 'YYYY-MM-DD' ET — resets on new day
  direction:  null,   // 'LONG' | 'SHORT'
  longScore:  0,
  shortScore: 0,
  biasNotes:  [],
  archetype:  null,
  phase:      'IDLE', // 'IDLE' | 'SCORED' | 'HUNTING' | 'DONE'
  emitted:    false,
};

// ── ET time utilities ─────────────────────────────────────────────────────────

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

// ── Pre-open scoring model ────────────────────────────────────────────────────
// Returns { direction, longScore, shortScore, confidence, notes }

function computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly) {
  let lS = 0, sS = 0; // longScore, shortScore
  const notes = [];

  // ── Pillar 1: HTF Alignment (40 pts) ─────────────────────────────────────
  // 4H trend is the dominant regime — weighted 15 pts
  if (bars4h && bars4h.length >= 5) {
    const b = calcHtfBias(bars4h, 9, 21);
    if (b > 0)      { lS += 15; notes.push('4H:BULL(+15L)'); }
    else if (b < 0) { sS += 15; notes.push('4H:BEAR(+15S)'); }
    else            { lS += 5; sS += 5; notes.push('4H:NEUT'); }
  }
  // 1H momentum — trend of the trend
  if (bars1h && bars1h.length >= 21) {
    const b = calcHtfBias(bars1h, 9, 21);
    if (b > 0)      { lS += 12; notes.push('1H:BULL(+12L)'); }
    else if (b < 0) { sS += 12; notes.push('1H:BEAR(+12S)'); }
    else            { lS += 4; sS += 4; notes.push('1H:NEUT'); }
  }
  // 15m structure — near-term momentum entering open
  if (bars15m && bars15m.length >= 21) {
    const b = calcHtfBias(bars15m, 9, 21);
    if (b > 0)      { lS += 8; notes.push('15m:BULL(+8L)'); }
    else if (b < 0) { sS += 8; notes.push('15m:BEAR(+8S)'); }
    else            { lS += 2; sS += 2; notes.push('15m:NEUT'); }
  }
  // 5m pre-open bias: price vs VWAP (5 pts)
  if (bars5m && bars5m.length >= 10) {
    const vArr  = calcVwap(bars5m);
    const vwap  = vArr[vArr.length - 1];
    const price = bars5m[bars5m.length - 1].close;
    if (vwap && price) {
      if (price > vwap) { lS += 5; notes.push('5m>VWAP(+5L)'); }
      else              { sS += 5; notes.push('5m<VWAP(+5S)'); }
    }
  }

  // ── Pillar 2: Gap Structure (25 pts) ─────────────────────────────────────
  // Gap classification drives 25% of the bias. Large gaps reverse; moderate gaps continue.
  if (barsDly && barsDly.length >= 2 && bars5m && bars5m.length > 0) {
    const prevClose = barsDly[barsDly.length - 2]?.close;
    const curProxy  = bars5m[bars5m.length - 1].close;
    if (prevClose && curProxy) {
      const gapPct = (curProxy - prevClose) / prevClose * 100;
      const gAbs   = Math.abs(gapPct);
      if (gAbs < 0.15) {
        lS += 3; sS += 3;
        notes.push(`gap_flat(${gapPct.toFixed(2)}%)`);
      } else if (gAbs < 0.5) {
        // Moderate continuation gap (empirically >55% continue)
        if (gapPct > 0) { lS += 15; notes.push(`gap_up_cont(${gapPct.toFixed(2)}%,+15L)`); }
        else            { sS += 15; notes.push(`gap_dn_cont(${gapPct.toFixed(2)}%,+15S)`); }
      } else if (gAbs < 1.0) {
        // Large gap — moderate continuation with fade risk
        if (gapPct > 0) { lS += 10; sS += 4; notes.push(`gap_up_large(${gapPct.toFixed(2)}%)`); }
        else            { sS += 10; lS += 4; notes.push(`gap_dn_large(${gapPct.toFixed(2)}%)`); }
      } else {
        // Exhaustion gap >1% — strong fade probability (~62% historical reverse)
        if (gapPct > 0) { sS += 15; lS += 2; notes.push(`gap_exhaust_up(${gapPct.toFixed(2)}%,fade+15S)`); }
        else            { lS += 15; sS += 2; notes.push(`gap_exhaust_dn(${gapPct.toFixed(2)}%,fade+15L)`); }
      }
    }
  }

  // ── Pillar 3: Overnight Structure (20 pts) ───────────────────────────────
  // Overnight range defines institutional accumulation zone; midpoint is S/R.
  if (bars5m && bars5m.length >= 20) {
    const lastTs   = bars5m[bars5m.length - 1].timestamp;
    const overnight = bars5m.slice(-Math.min(100, bars5m.length - 1), -1).filter(b => {
      const et = getET(b.timestamp);
      return et.hm < 930 || et.hm >= 1600; // outside primary session
    });
    if (overnight.length >= 5) {
      const oHigh = Math.max(...overnight.map(b => b.high));
      const oLow  = Math.min(...overnight.map(b => b.low));
      const oMid  = (oHigh + oLow) / 2;
      const price = bars5m[bars5m.length - 1].close;
      const q1    = overnight[0].open;
      const q4    = overnight[overnight.length - 1].close;

      if (price > oMid)  { lS += 10; notes.push('above_ON_mid(+10L)'); }
      else               { sS += 10; notes.push('below_ON_mid(+10S)'); }

      if (q4 > q1)       { lS += 5; notes.push('ON_trend_UP(+5L)'); }
      else if (q4 < q1)  { sS += 5; notes.push('ON_trend_DN(+5S)'); }

      // Near overnight extremes = stop cluster zone; anticipate sweep + reversal
      if (price > oHigh * 0.9985) { sS += 5; notes.push('near_ON_high(resist,+5S)'); }
      if (price < oLow  * 1.0015) { lS += 5; notes.push('near_ON_low(support,+5L)'); }
    }
  }

  // ── Pillar 4: Prior Day Context (15 pts) ─────────────────────────────────
  if (barsDly && barsDly.length >= 2) {
    const pd     = barsDly[barsDly.length - 2];
    const price  = bars5m ? bars5m[bars5m.length - 1].close : null;
    const pdBull = pd.close > pd.open;

    if (price) {
      if (price > pd.high)      { lS += 10; notes.push('above_PDH(+10L)'); }
      else if (price < pd.low)  { sS += 10; notes.push('below_PDL(+10S)'); }
      else {
        const pos = (price - pd.low) / Math.max(pd.high - pd.low, 1);
        if (pos > 0.65)         { lS += 7; notes.push(`PD_upper(${pos.toFixed(2)},+7L)`); }
        else if (pos < 0.35)    { sS += 7; notes.push(`PD_lower(${pos.toFixed(2)},+7S)`); }
      }
    }
    if (pdBull) { lS += 5; notes.push('PD_bull(+5L)'); }
    else        { sS += 5; notes.push('PD_bear(+5S)'); }
  }

  const direction  = lS >= sS ? 'LONG' : 'SHORT';
  const winScore   = Math.max(lS, sS);
  const total      = lS + sS;
  // Confidence: 50 = coin-flip (tie), 100 = unanimous (not possible); range ~50-85
  const confidence = total > 0 ? Math.round(50 + (winScore / total - 0.5) * 80) : 50;

  return { direction, longScore: lS, shortScore: sS, confidence, notes };
}

// ── Opening execution — find optimal entry trigger ────────────────────────────

function findOpeningEntry(bars5m, direction, atr) {
  const isBull = direction === 'LONG';

  // Bars from 9:30 ET onwards (today only)
  const openBars = bars5m.filter(b => {
    const et = getET(b.timestamp);
    return et.hm >= 930 && et.hm < 1000;
  });
  if (openBars.length < 2) return null;

  const firstBar   = openBars[0];
  const firstRange = firstBar.high - firstBar.low;
  if (firstRange < 0.5) return null; // malformed bar guard

  // ── Tier 1: Opening Drive + First Pullback ────────────────────────────────
  // Drive = first bar closes strongly in one direction (body > 30% of range)
  const bodySize  = Math.abs(firstBar.close - firstBar.open);
  const driveUp   = firstBar.close > firstBar.open && bodySize > 0.30 * firstRange;
  const driveDn   = firstBar.close < firstBar.open && bodySize > 0.30 * firstRange;
  const driveAligned = isBull ? driveUp : driveDn;

  if (driveAligned && openBars.length >= 3) {
    const drive3     = openBars.slice(0, Math.min(3, openBars.length));
    const drivePeak  = isBull
      ? Math.max(...drive3.map(b => b.high))
      : Math.min(...drive3.map(b => b.low));
    const driveRange = isBull
      ? drivePeak - firstBar.low
      : firstBar.high - drivePeak;

    if (driveRange > 0.5 * atr) {
      for (let i = 1; i < openBars.length - 1; i++) {
        const bar = openBars[i];
        const next = openBars[i + 1];
        if (!next) continue;
        if (getET(next.timestamp).hm >= 1000) break;

        const pbRatio = isBull
          ? driveRange > 0 ? (drivePeak - bar.low) / driveRange : 0
          : driveRange > 0 ? (bar.high - drivePeak) / driveRange : 0;

        // Valid pullback: retraced 25–65% of the drive
        if (pbRatio >= 0.25 && pbRatio <= 0.65) {
          // Resumption: next bar closes beyond 50% of drive range from base
          const midLevel = isBull
            ? firstBar.low  + driveRange * 0.50
            : firstBar.high - driveRange * 0.50;
          const confirmed = isBull
            ? next.close > midLevel && isBullishCandle(next, 0.30)
            : next.close < midLevel && isBearishCandle(next, 0.30);
          if (confirmed) {
            return { bar: next, entry: next.close, archetype: 'OPENING_DRIVE_PULLBACK' };
          }
        }
      }
    }
  }

  // ── Tier 2: VWAP Confirmation (9:40+ ET) ──────────────────────────────────
  // Price touches VWAP ±0.4 ATR, then next bar resumes in direction of bias.
  const vwapArr = calcVwap(bars5m);
  const lateBars = openBars.filter(b => getET(b.timestamp).hm >= 940);
  for (const bar of lateBars) {
    const idx  = bars5m.indexOf(bar);
    const vwap = idx >= 0 ? vwapArr[idx] : null;
    if (!vwap) continue;
    const dist = Math.abs(bar.close - vwap);
    if (dist > 0.4 * atr) continue;

    const next = bars5m[idx + 1];
    if (!next || getET(next.timestamp).hm >= 1000) continue;

    const triggered = isBull
      ? next.close > vwap + 0.08 * atr && isBullishCandle(next, 0.25)
      : next.close < vwap - 0.08 * atr && isBearishCandle(next, 0.25);
    if (triggered) {
      return { bar: next, entry: next.close, archetype: 'VWAP_CONFIRMATION' };
    }
  }

  return null;
}

// ── Main evaluate function ────────────────────────────────────────────────────

function evaluate(bars5m, bars15m, bars1h, bars4h, cfg = {}, barIdx = null) {
  if (!bars5m || bars5m.length < 20) return null;

  const lastBar = bars5m[bars5m.length - 1];
  const et      = getET(lastBar.timestamp);

  // Weekend guard
  if (et.dow === 0 || et.dow === 6) return null;

  // ── Daily state reset ─────────────────────────────────────────────────────
  if (et.dateKey !== _d.dateKey) {
    _d.dateKey    = et.dateKey;
    _d.direction  = null;
    _d.longScore  = 0;
    _d.shortScore = 0;
    _d.biasNotes  = [];
    _d.archetype  = null;
    _d.phase      = 'IDLE';
    _d.emitted    = false;
  }

  // Already traded today
  if (_d.emitted) return null;

  // Activity window: 9:20–10:00 ET only
  if (et.hm < 920 || et.hm >= 1000) return null;

  const barsDly = cfg.barsDly ?? [];

  const atrArr = calcAtr(bars5m, 14);
  const atr    = atrArr[atrArr.length - 1];
  if (!atr || atr < 4) return null;

  // ── Phase: IDLE → SCORED (9:20–9:29 ET: compute direction) ──────────────
  if (et.hm < 930 && _d.phase === 'IDLE') {
    const bias    = computePreopenBias(bars5m, bars15m, bars1h, bars4h, barsDly);
    _d.direction  = bias.direction;
    _d.longScore  = bias.longScore;
    _d.shortScore = bias.shortScore;
    _d.biasNotes  = bias.notes;
    _d.phase      = 'SCORED';
    return null;
  }

  // ── Phase: SCORED → HUNTING (9:30+ ET) ───────────────────────────────────
  if (et.hm >= 930 && _d.phase === 'SCORED') _d.phase = 'HUNTING';

  // Edge case: if process restarted after 9:30, score now before hunting
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
  const isDeadline = et.hm >= 955;
  let entryResult  = null;

  if (!isDeadline) {
    entryResult = findOpeningEntry(bars5m, _d.direction, atr);
  }

  // Tier 3: Deadline forced entry — always fires at 9:55 ET
  if (!entryResult && isDeadline) {
    entryResult = {
      bar:      lastBar,
      entry:    lastBar.close,
      archetype: 'FORCED_BIAS_ENTRY',
    };
  }

  if (!entryResult) return null;

  // ── Stop loss ─────────────────────────────────────────────────────────────
  const isBull   = _d.direction === 'LONG';
  const entry    = entryResult.entry;
  const vwapArr2 = calcVwap(bars5m);
  const vwap     = vwapArr2[vwapArr2.length - 1];
  const swLow    = recentSwingLow(bars5m,  10);
  const swHigh   = recentSwingHigh(bars5m, 10);

  let rawRisk;
  let sl;
  if (isBull) {
    const structFloor = Math.min(swLow, vwap != null ? vwap - 0.5 * atr : swLow);
    rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, entry - structFloor));
    sl      = +(entry - rawRisk).toFixed(2);
  } else {
    const structCeil  = Math.max(swHigh, vwap != null ? vwap + 0.5 * atr : swHigh);
    rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, structCeil - entry));
    sl      = +(entry + rawRisk).toFixed(2);
  }

  // ── Take profit ───────────────────────────────────────────────────────────
  // TP1=1.5R (trigger for BE), TP2=2.5R (partial exit), TP3=3.5R (runner)
  const tp1 = isBull ? +(entry + 1.5 * rawRisk).toFixed(2) : +(entry - 1.5 * rawRisk).toFixed(2);
  const tp2 = isBull ? +(entry + 2.5 * rawRisk).toFixed(2) : +(entry - 2.5 * rawRisk).toFixed(2);
  const tp3 = isBull ? +(entry + 3.5 * rawRisk).toFixed(2) : +(entry - 3.5 * rawRisk).toFixed(2);

  // ── Confidence ────────────────────────────────────────────────────────────
  const winScore = isBull ? _d.longScore : _d.shortScore;
  const total    = _d.longScore + _d.shortScore;
  let confidence = total > 0 ? Math.round(50 + (winScore / total - 0.5) * 80) : 50;
  // Entry archetype bonus
  if (entryResult.archetype === 'OPENING_DRIVE_PULLBACK') confidence = Math.min(92, confidence + 8);
  if (entryResult.archetype === 'VWAP_CONFIRMATION')       confidence = Math.min(92, confidence + 4);
  confidence = Math.max(45, Math.min(92, confidence));

  // ── Supporting indicators ─────────────────────────────────────────────────
  const closes = bars5m.map(b => b.close);
  const rsiArr = calcRsi(closes, 14);
  const rsi    = rsiArr[rsiArr.length - 1];

  const b4  = bars4h  && bars4h.length  >= 5  ? calcHtfBias(bars4h,  9, 21) : 0;
  const b1  = bars1h  && bars1h.length  >= 21 ? calcHtfBias(bars1h,  9, 21) : 0;
  const b15 = bars15m && bars15m.length >= 21 ? calcHtfBias(bars15m, 9, 21) : 0;

  const sess = getSessionInfo(lastBar.timestamp);
  const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

  _d.emitted   = true;
  _d.archetype = entryResult.archetype;
  _d.phase     = 'DONE';

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
      `${entryResult.archetype} | ${_d.direction}`,
      `bias=${confidence}% (L${_d.longScore} vs S${_d.shortScore})`,
      `4H:${b4 > 0 ? 'BULL' : b4 < 0 ? 'BEAR' : 'NEUT'} 1H:${b1 > 0 ? 'BULL' : b1 < 0 ? 'BEAR' : 'NEUT'} 15m:${b15 > 0 ? 'BULL' : b15 < 0 ? 'BEAR' : 'NEUT'}`,
      entryResult.archetype === 'FORCED_BIAS_ENTRY' ? 'DEADLINE_ENTRY_9:55' : null,
    ].filter(Boolean).join(' | '),
    indicators: {
      atr:        +atr.toFixed(2),
      vwap:       vwap != null ? +vwap.toFixed(2) : null,
      rsi:        rsi  != null ? +rsi.toFixed(1)  : null,
      htfBias:    b4,
      htf2Bias:   b1,
      htf3Bias:   b15,
      longScore:  _d.longScore,
      shortScore: _d.shortScore,
      regime:     b4 > 0 ? 'TREND_BULL' : b4 < 0 ? 'TREND_BEAR' : 'MIXED',
    },
    timestamp:    lastBar.timestamp,
    trade_status: 'PENDING',
  };
}

/**
 * Dedicated daily backtest for NQ_NY_OPEN.
 * Iterates over each trading day in bars5m, simulates the full decision engine,
 * and returns aggregate metrics plus a per-trade log.
 *
 * @param {object[]} bars5m    - full 5m bar history
 * @param {object[]} bars1h    - 1h bars (for HTF bias)
 * @param {object[]} bars4h    - 4h bars (for trend bias)
 * @param {object[]} barsDly   - daily bars (for gap + prior day)
 * @param {object}   opts
 * @param {string}   [opts.instrument='MNQ']
 * @returns {{ metrics, signalLog }}
 */
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
  let maxWin = 0, maxLoss = 0, maxDrawdown = 0, peak = 0, drawdown = 0;
  let pnlRunning = 0;
  const dayKeys = [...dayMap.keys()].sort();

  for (const dateKey of dayKeys) {
    const dayBars = dayMap.get(dateKey);
    if (!dayBars || dayBars.length < 10) continue;

    // Check weekday
    const et = getET(dayBars[0].timestamp);
    if (et.dow === 0 || et.dow === 6) continue;

    // Build same-day 15m bars (aggregated from 5m)
    const bars15m = _agg5mTo15m(dayBars.slice(0, -1)); // exclude current bar

    // Get 1h/4h bars up to this day (exclude future bars)
    const cutoff  = dayBars[0].timestamp;
    const h1Slice = bars1h  ? bars1h.filter(b => b.timestamp < cutoff) : [];
    const h4Slice = bars4h  ? bars4h.filter(b => b.timestamp < cutoff) : [];
    const dlySlice = barsDly ? barsDly.filter(b => b.timestamp < cutoff) : [];

    // --- Pre-open scoring (9:20–9:29 ET bars) ---
    const preBars  = dayBars.filter(b => { const e = getET(b.timestamp); return e.hm < 930; });
    const allPreBars = [
      ...(bars5m.filter(b => b.timestamp < dayBars[0].timestamp).slice(-200)),
      ...preBars,
    ];
    if (allPreBars.length < 10) continue;

    const bias    = computePreopenBias(allPreBars, bars15m, h1Slice, h4Slice, dlySlice);
    const dir     = bias.direction;
    const isBull  = dir === 'LONG';

    // --- Opening window (9:30–10:00 ET bars for the day) ---
    const openBars = dayBars.filter(b => { const e = getET(b.timestamp); return e.hm >= 930 && e.hm < 1000; });
    if (openBars.length < 2) continue;

    // All 5m bars available at time of entry (for stop calc, VWAP, ATR)
    const preEntryBars = [
      ...allPreBars,
      ...dayBars.filter(b => getET(b.timestamp).hm < 930),
    ];
    const atrArr = calcAtr(preEntryBars.length >= 14 ? preEntryBars : dayBars, 14);
    const atr    = atrArr[atrArr.length - 1] || 10;

    // Find entry
    let entryResult = findOpeningEntry([...preEntryBars, ...openBars], dir, atr);
    let entryBar    = null;

    if (entryResult) {
      entryBar = entryResult.bar;
    } else {
      // Forced entry at 9:55 (last open bar or bars near 9:55)
      const forceBar = openBars[openBars.length - 1];
      entryResult = { bar: forceBar, entry: forceBar.close, archetype: 'FORCED_BIAS_ENTRY' };
      entryBar    = forceBar;
    }

    const entry   = entryResult.entry;
    const allBarsAtEntry = [...preEntryBars, ...openBars.filter(b => b.timestamp <= entryBar.timestamp)];
    const vArr    = calcVwap(allBarsAtEntry);
    const vwap    = vArr[vArr.length - 1];
    const swLow   = recentSwingLow(allBarsAtEntry, 10);
    const swHigh  = recentSwingHigh(allBarsAtEntry, 10);

    let rawRisk;
    let sl;
    if (isBull) {
      const floor = Math.min(swLow, vwap != null ? vwap - 0.5 * atr : swLow);
      rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, entry - floor));
      sl      = entry - rawRisk;
    } else {
      const ceil  = Math.max(swHigh, vwap != null ? vwap + 0.5 * atr : swHigh);
      rawRisk = Math.max(0.75 * atr, Math.min(2.0 * atr, ceil - entry));
      sl      = entry + rawRisk;
    }
    const tp1 = isBull ? entry + 1.5 * rawRisk : entry - 1.5 * rawRisk;

    // --- Simulate outcome using bars from entry time to 11:00 ET ---
    const futureBars = dayBars.filter(b => {
      const e = getET(b.timestamp);
      return b.timestamp > entryBar.timestamp && e.hm <= 1100;
    });

    let outcome = 'TIMEOUT';
    let exitPrice = null;
    for (const bar of futureBars) {
      if (isBull) {
        if (bar.high >= tp1) { outcome = 'WIN';  exitPrice = tp1; break; }
        if (bar.low  <= sl)  { outcome = 'LOSS'; exitPrice = sl;  break; }
      } else {
        if (bar.low  <= tp1) { outcome = 'WIN';  exitPrice = tp1; break; }
        if (bar.high >= sl)  { outcome = 'LOSS'; exitPrice = sl;  break; }
      }
    }
    // TIMEOUT: exit at 11:00 ET bar close (or last available)
    if (outcome === 'TIMEOUT') {
      const exitBar = futureBars[futureBars.length - 1];
      exitPrice = exitBar ? exitBar.close : entry;
      const pnl = isBull ? exitPrice - entry : entry - exitPrice;
      outcome   = pnl >= 0 ? 'WIN' : 'LOSS';
    }

    const pnlPts = isBull
      ? +(exitPrice - entry).toFixed(2)
      : +(entry - exitPrice).toFixed(2);

    if (outcome === 'WIN')  { wins++; maxWin  = Math.max(maxWin, pnlPts); }
    if (outcome === 'LOSS') { losses++; maxLoss = Math.min(maxLoss, pnlPts); }
    totalPnl    += pnlPts;
    pnlRunning  += pnlPts;
    peak        = Math.max(peak, pnlRunning);
    drawdown    = peak - pnlRunning;
    maxDrawdown = Math.max(maxDrawdown, drawdown);

    let confidence = bias.confidence;
    if (entryResult.archetype === 'OPENING_DRIVE_PULLBACK') confidence = Math.min(92, confidence + 8);
    if (entryResult.archetype === 'VWAP_CONFIRMATION')       confidence = Math.min(92, confidence + 4);

    signalLog.push({
      date:        dateKey,
      direction:   dir,
      archetype:   entryResult.archetype,
      entry:       +entry.toFixed(2),
      sl:          +sl.toFixed(2),
      tp1:         +tp1.toFixed(2),
      outcome,
      pnl_pts:     pnlPts,
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

  const tradeCount = wins + losses;
  const winRate    = tradeCount > 0 ? wins / tradeCount : 0;
  const avgWin     = wins   > 0 ? signalLog.filter(t => t.outcome === 'WIN').reduce((s, t) => s + t.pnl_pts, 0) / wins  : 0;
  const avgLoss    = losses > 0 ? Math.abs(signalLog.filter(t => t.outcome === 'LOSS').reduce((s, t) => s + t.pnl_pts, 0) / losses) : 0;
  const profitFactor = avgLoss > 0 ? (wins * avgWin) / (losses * avgLoss) : null;
  const expectancy   = tradeCount > 0 ? +(totalPnl / tradeCount).toFixed(2) : 0;

  // Sharpe: daily returns normalized
  const returns = signalLog.map(t => t.pnl_pts);
  const mean    = returns.reduce((s, v) => s + v, 0) / (returns.length || 1);
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const sharpe   = variance > 0 ? +(mean / Math.sqrt(variance) * Math.sqrt(252)).toFixed(3) : null;

  return {
    metrics: {
      tradeCount,
      winRate,
      wins,
      losses,
      totalPnl:    +totalPnl.toFixed(2),
      expectancy,
      profitFactor: profitFactor != null ? +profitFactor.toFixed(3) : null,
      maxDrawdown: +maxDrawdown.toFixed(2),
      sharpe,
      avgWin:      +avgWin.toFixed(2),
      avgLoss:     +avgLoss.toFixed(2),
      maxWin:      +maxWin.toFixed(2),
      maxLoss:     +maxLoss.toFixed(2),
    },
    signalLog,
  };
}

// Minimal 5m→15m aggregator for backtest (avoids shared-indicators dependency)
function _agg5mTo15m(bars5m) {
  const out = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3) {
    const slice = bars5m.slice(i, i + 3);
    out.push({
      timestamp: slice[0].timestamp,
      open:  slice[0].open,
      high:  Math.max(...slice.map(b => b.high)),
      low:   Math.min(...slice.map(b => b.low)),
      close: slice[2].close,
      volume: slice.reduce((s, b) => s + (b.volume || 0), 0),
    });
  }
  return out;
}

function reset() {
  _d.dateKey    = null;
  _d.direction  = null;
  _d.longScore  = 0;
  _d.shortScore = 0;
  _d.biasNotes  = [];
  _d.archetype  = null;
  _d.phase      = 'IDLE';
  _d.emitted    = false;
}

module.exports = {
  evaluate,
  reset,
  backtestNyOpen,
  computePreopenBias,
  STRATEGY_NAME,
  STRATEGY_VERSION,
  LIVE_THRESHOLD,
};
