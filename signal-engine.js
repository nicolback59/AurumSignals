'use strict';

// ── Math helpers ──────────────────────────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map(v => (prev = v * k + prev * (1 - k)));
}

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j] ?? 0;
    return s / period;
  });
}

// Wilder's RMA — matches Pine Script ta.atr() smoothing
function rma(values, period) {
  const alpha = 1 / period;
  const result = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      if (i === period - 1) {
        let s = 0;
        for (let j = 0; j < period; j++) s += values[j] ?? 0;
        prev = s / period;
        result[i] = prev;
      }
    } else {
      prev = alpha * (values[i] ?? 0) + (1 - alpha) * prev;
      result[i] = prev;
    }
  }
  return result;
}

function rollingStdev(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  });
}

function calcAtr(bars, period) {
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low :
    Math.max(b.high - b.low, Math.abs(b.high - bars[i-1].close), Math.abs(b.low - bars[i-1].close))
  );
  return rma(tr, period);
}

function calcVwap(bars) {
  let cumPV = 0, cumV = 0, lastDate = '';
  return bars.map(b => {
    const date = new Date(b.timestamp).toISOString().slice(0, 10);
    if (date !== lastDate) { cumPV = 0; cumV = 0; lastDate = date; }
    const hlc3 = (b.high + b.low + b.close) / 3;
    const v    = b.volume || 1;
    cumPV += hlc3 * v;
    cumV  += v;
    return cumPV / cumV;
  });
}

function getSessionInfo(timestamp, instrument = 'MNQ') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const h    = parseInt(parts.find(p => p.type === 'hour').value);
  const m    = parseInt(parts.find(p => p.type === 'minute').value);
  const hhmm = h * 100 + m;

  const inLondonNY = hhmm >= 800  && hhmm < 930;    // London/NY overlap pre-open
  const inNYOpen   = hhmm >= 930  && hhmm < 1130;
  const inMidDay   = hhmm >= 1130 && hhmm < 1330;
  const inAftNoon  = hhmm >= 1330 && hhmm < 1600;
  const inLunch    = hhmm >= 1145 && hhmm < 1300;
  const inRTH      = hhmm >= 930  && hhmm < 1600;

  // MGC (gold): also active during London/NY overlap and pre-market
  const isMGC   = instrument === 'MGC';
  const sessOK  = isMGC
    ? (hhmm >= 800 && hhmm < 1600 && !inLunch)
    : (inRTH && !inLunch);

  // Session quality multiplier
  let sessScore, sessQ, sessName;
  if (inNYOpen)    { sessScore = 3; sessQ = 1.00; sessName = 'NY Open ★'; }
  else if (inLondonNY && isMGC) { sessScore = 3; sessQ = 0.95; sessName = 'London/NY ★'; }
  else if (inAftNoon)  { sessScore = 2; sessQ = 0.85; sessName = 'Afternoon ✓'; }
  else if (inLondonNY) { sessScore = 2; sessQ = 0.80; sessName = 'Pre-Open'; }
  else if (inMidDay)   { sessScore = 1; sessQ = 0.65; sessName = 'Midday'; }
  else if (hhmm >= 1600) { sessScore = 0; sessQ = 0.50; sessName = 'After Hours'; }
  else if (hhmm >= 400)  { sessScore = 0; sessQ = 0.45; sessName = 'Pre-Market'; }
  else               { sessScore = 0; sessQ = 0.40; sessName = 'Overnight'; }

  return { sessOK, sessScore, sessQ, sessName, hhmm, inRTH };
}

// ── Win probability ───────────────────────────────────────────────────────────
function calcWinProb(score, isAplus, sessQ, setup, tradeStyle) {
  const base  = setup === 'OTE+STDV' ? 0.72 : setup === 'OTE PB' ? 0.67
              : (setup === 'STDV REV' || setup === 'STDV RST') ? 0.61 : 0.58;
  const gAdj  = isAplus ? 0.06 : 0.0;
  const sAdj  = (score - 16) * 0.008;
  const ssAdj = sessQ >= 0.95 ? 0.05 : sessQ >= 0.85 ? 0.03 : sessQ >= 0.65 ? 0.0 : -0.06;
  // Swing trades have lower TP1 win prob (harder to reach 2R target) but high quality floor
  const styleAdj = tradeStyle === 'swing' ? -0.04 : tradeStyle === 'intraday' ? -0.01 : 0.0;
  return Math.min(Math.max(base + gAdj + sAdj + ssAdj + styleAdj, 0.35), 0.92);
}

// ── Main signal computation ───────────────────────────────────────────────────
/**
 * Compute a signal for the last bar in `bars`.
 * @param {Array}  bars    - 1m OHLCV bars, oldest first
 * @param {Array}  htfBars - 15m OHLCV bars (or configured HTF period)
 * @param {Object} cfg     - parameter overrides including `instrument`
 * @returns signal object or null
 */
function computeSignal(bars, htfBars, cfg = {}) {
  const instrument = cfg.instrument ?? 'MNQ';
  const isMGC      = instrument === 'MGC';

  // ── Instrument-specific defaults ─────────────────────────────────────────────
  const C = {
    slPts:          cfg.slPts          ?? (isMGC ? 10  : 25),
    minScore:       cfg.minScore       ?? (isMGC ? 14  : 16),
    oteHigh:        cfg.oteHigh        ?? 0.786,
    oteLow:         cfg.oteLow         ?? 0.618,
    swingLook:      cfg.swingLook      ?? (isMGC ? 15  : 20),
    stdvLen:        cfg.stdvLen        ?? (isMGC ? 14  : 20),
    std2:           cfg.std2           ?? 2.0,
    std1:           cfg.std1           ?? 1.0,
    htfEmaF:        cfg.htfEmaF        ?? 9,
    htfEmaS:        cfg.htfEmaS        ?? 21,
    atrLen:         cfg.atrLen         ?? 14,
    swingL:         cfg.swingL         ?? (isMGC ? 5   : 7),
    emaF:           cfg.emaF           ?? 9,
    emaS:           cfg.emaS           ?? 21,
    emaT:           cfg.emaT           ?? 50,
    volFilter:      cfg.volFilter      ?? (isMGC ? 1.15 : 1.20),
    swing_minScore: cfg.swing_minScore ?? 28,   // MNQ only: score threshold for swing style
    rthOnly:        cfg.rthOnly        ?? false,
  };

  const n = bars.length;
  if (n < 60 || htfBars.length < 10) return null;

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const opens   = bars.map(b => b.open);
  const volumes = bars.map(b => b.volume || 1);
  const htfClose = htfBars.map(b => b.close);

  // ── Indicators ───────────────────────────────────────────────────────────────
  const atrV    = calcAtr(bars, C.atrLen);
  const atrSmaV = sma(atrV.map(v => v ?? 0), 20);
  const volAvgV = sma(volumes, 20);
  const vwapV   = calcVwap(bars);
  const stdvV   = rollingStdev(closes, C.stdvLen);
  const emaFV   = ema(closes, C.emaF);
  const emaSV   = ema(closes, C.emaS);
  const emaTArr = ema(closes, C.emaT);

  const htfEmaFV = ema(htfClose, C.htfEmaF);
  const htfEmaSV = ema(htfClose, C.htfEmaS);

  const i = n - 1;
  const { close, high, low, open, volume, timestamp } = bars[i];

  const atrVal  = atrV[i]    ?? 1;
  const atrSma  = atrSmaV[i] ?? atrVal;
  const vwap    = vwapV[i];
  const sdv     = stdvV[i]   ?? 1;
  const emaFVal = emaFV[i];
  const emaSVal = emaSV[i];
  const emaTVal = emaTArr[i];

  const upp1  = vwap + sdv * C.std1, dwn1 = vwap - sdv * C.std1;
  const upp2  = vwap + sdv * C.std2, dwn2 = vwap - sdv * C.std2;
  const abvV1 = close > upp1, abvV2 = close > upp2;
  const blwV1 = close < dwn1, blwV2 = close < dwn2;
  const atVwap = Math.abs(close - vwap) < sdv * 0.3;

  // STDV extension memory (20-bar rolling lookback)
  let hadExtUp = false, hadExtDn = false;
  for (let j = Math.max(0, i - 20); j < i; j++) {
    const c = closes[j], sv = stdvV[j] ?? 0, vv = vwapV[j];
    if (c > vv + sv * C.std2) hadExtUp = true;
    if (c < vv - sv * C.std2) hadExtDn = true;
    if (Math.abs(c - vv) < sv * 0.3) hadExtUp = hadExtDn = false;
  }
  const rstL = hadExtDn && blwV1 && !blwV2;
  const rstS = hadExtUp && abvV1 && !abvV2;

  // OTE zones
  const lb  = Math.min(C.swingLook, i);
  const swH = Math.max(...highs.slice(i - lb, i + 1));
  const swL = Math.min(...lows.slice(i - lb,  i + 1));
  const swR = swH - swL;
  const odL = swL + swR * (1 - C.oteHigh), odH = swL + swR * (1 - C.oteLow);
  const opL = swL + swR * C.oteLow,        opH = swL + swR * C.oteHigh;
  const inOTED   = close >= odL && close <= odH;
  const inOTEP   = close >= opL && close <= opH;
  const nearOTED = close >= odL - atrVal * 0.5 && close <= odH + atrVal * 0.3;
  const nearOTEP = close >= opL - atrVal * 0.3 && close <= opH + atrVal * 0.5;

  // Candle analysis
  const cRng  = high - low, cBody = Math.abs(close - open);
  const bull  = close > open, bear = !bull;
  const cLoc  = cRng > 0 ? (close - low) / cRng : 0.5;
  const lW    = Math.min(open, close) - low, uW = high - Math.max(open, close);
  const lWR   = cRng > 0 ? lW / cRng : 0, uWR = cRng > 0 ? uW / cRng : 0;
  const spike = cRng >= 4.5 * atrVal;
  const dB    = cBody >= 0.45 * atrVal && cLoc >= 0.60 && bull && !spike;
  const dBr   = cBody >= 0.45 * atrVal && cLoc <= 0.40 && bear && !spike;
  const rU    = lWR >= 0.33 && lW > cBody * 0.4;
  const rD    = uWR >= 0.33 && uW > cBody * 0.4;
  const mB    = close > highs[i-1] && bull;
  const mBr   = close < lows[i-1]  && bear;

  // Volume confirmation
  const volAvg = volAvgV[i] ?? 1;
  const vUp    = volume > volAvg * C.volFilter;
  const vSurge = volume > volAvg * (C.volFilter * 1.4);  // strong surge = extra point

  // ATR expansion (current ATR expanding vs its SMA)
  const atrExpanding = atrVal > atrSma * 1.05;

  // Short-term momentum: at least 2 of last 3 bars closed in upper/lower 60% of range
  let momentumUp = 0, momentumDn = 0;
  for (let j = Math.max(0, i - 2); j <= i; j++) {
    const r = highs[j] - lows[j];
    if (r > 0) {
      if ((closes[j] - lows[j]) / r >= 0.60) momentumUp++;
      if ((highs[j] - closes[j]) / r >= 0.60) momentumDn++;
    }
  }
  const mUp3 = momentumUp >= 2;
  const mDn3 = momentumDn >= 2;

  // Chop filter (tighter for MGC scalps)
  const chopLook = isMGC ? 12 : 14;
  const cH  = Math.max(...highs.slice(Math.max(0, i - chopLook), i + 1));
  const cL  = Math.min(...lows.slice(Math.max(0, i - chopLook),  i + 1));
  const chopThresh = isMGC ? 2.5 : 3.0;
  const chop = (cH - cL) < atrVal * chopThresh;

  // EMA trend alignment
  const emaUpTrend = emaFVal > emaSVal && emaSVal > emaTVal;
  const emaDnTrend = emaFVal < emaSVal && emaSVal < emaTVal;
  const emaExpansion = Math.abs(emaFVal - emaSVal) > Math.abs(ema(closes, C.emaS)[Math.max(0, i-5)] - ema(closes, C.emaF)[Math.max(0, i-5)]);

  // Pivot highs/lows → market structure
  const sl = C.swingL;
  const pH = [], pL = [];
  for (let j = sl; j < n - sl; j++) {
    if (highs[j] === Math.max(...highs.slice(j - sl, j + sl + 1))) pH.push(highs[j]);
    if (lows[j]  === Math.min(...lows.slice(j - sl,  j + sl + 1))) pL.push(lows[j]);
  }
  const [sh1, sh0] = pH.slice(-2);
  const [sl1, sl0] = pL.slice(-2);
  const msB  = sh0&&sh1&&sl0&&sl1 && sh0>sh1&&sl0>sl1;
  const msBr = sh0&&sh1&&sl0&&sl1 && sh0<sh1&&sl0<sl1;
  const eqTol = atrVal * 0.18;
  const eqH   = sh0&&sh1 && Math.abs(sh0-sh1) <= eqTol;
  const eqL   = sl0&&sl1 && Math.abs(sl0-sl1) <= eqTol;

  // Liquidity sweeps
  const rH   = Math.max(...highs.slice(Math.max(0, i - sl*2), i + 1));
  const rL   = Math.min(...lows.slice(Math.max(0,  i - sl*2), i + 1));
  const swpL = low < rL && close > rL && bull && !spike;
  const swpH = high > rH && close < rH && bear && !spike;

  // HTF bias
  const hj      = htfBars.length - 1;
  const htfEF   = htfEmaFV[hj], htfES = htfEmaSV[hj], htfC = htfClose[hj];
  const htfBull = htfEF > htfES && htfC > htfES;
  const htfBear = htfEF < htfES && htfC < htfES;
  const htfNeutral = !htfBull && !htfBear;
  const htfBiasStr = htfBull ? 'BULL ▲' : htfBear ? 'BEAR ▼' : 'NEUTRAL';

  // Session
  const sess = getSessionInfo(timestamp, instrument);
  if (C.rthOnly && !sess.sessOK) return null;

  // ── Setup conditions ──────────────────────────────────────────────────────────
  // Setup 1: OTE pullback with HTF trend alignment
  const s1L  = htfBull && inOTED && (dB  || (rU && mB))   && !chop;
  const s1S  = htfBear && inOTEP && (dBr || (rD && mBr))  && !chop;

  // Setup 2: STDV extension mean reversion
  const s2L  = blwV2   && (rU || dB)  && !htfBull && !chop;
  const s2S  = abvV2   && (rD || dBr) && !htfBear && !chop;

  // Setup 2C: STDV reset with HTF trend continuation
  const s2CL = rstL && htfBull && (dB  || mB);
  const s2CS = rstS && htfBear && (dBr || mBr);

  // Setup 3: OTE + STDV confluence (highest quality)
  const s3L  = htfBull && inOTED && blwV1 && (dB || rU)  && !chop;
  const s3S  = htfBear && inOTEP && abvV1 && (dBr || rD) && !chop;

  // Setup 4 (MNQ only): Swing continuation with EMA trend + market structure
  const s4L  = !isMGC && emaUpTrend && msB  && (swpL || inOTED) && (dB || rU)  && !chop && mUp3;
  const s4S  = !isMGC && emaDnTrend && msBr && (swpH || inOTEP) && (dBr || rD) && !chop && mDn3;

  const anyL = s1L || s2L || s2CL || s3L || s4L;
  const anyS = s1S || s2S || s2CS || s3S || s4S;
  if (!anyL && !anyS) return null;

  const direction = anyL ? 'LONG' : 'SHORT';

  // Determine primary setup label
  let setup;
  if (direction === 'LONG') {
    setup = s3L ? 'OTE+STDV' : s1L ? 'OTE PB' : s4L ? 'SWING' : s2CL ? 'STDV RST' : 'STDV REV';
  } else {
    setup = s3S ? 'OTE+STDV' : s1S ? 'OTE PB' : s4S ? 'SWING' : s2CS ? 'STDV RST' : 'STDV REV';
  }

  // ── Factor scoring (max 40 pts) ───────────────────────────────────────────────
  const sc  = sess.sessScore;

  // F1: HTF alignment (0–6)
  const f1L = htfBull ? 6 : htfNeutral ? 2 : 0;
  const f1S = htfBear ? 6 : htfNeutral ? 2 : 0;

  // F2: OTE zone quality (0–7)
  const f2L = inOTED ? 7 : nearOTED ? 3 : 0;
  const f2S = inOTEP ? 7 : nearOTEP ? 3 : 0;

  // F3: VWAP deviation (0–7)
  const f3L = blwV2 ? 7 : blwV1 ? 4 : rstL ? 5 : atVwap ? 2 : 0;
  const f3S = abvV2 ? 7 : abvV1 ? 4 : rstS ? 5 : atVwap ? 2 : 0;

  // F4: Candle + volume quality (0–6)
  const f4L = (dB ? 4 : rU ? 3 : 0) + (mB  ? 1 : 0) + (vUp ? 1 : 0);
  const f4S = (dBr? 4 : rD ? 3 : 0) + (mBr ? 1 : 0) + (vUp ? 1 : 0);

  // Bonus factors: structure, setups, session, new quality filters
  const bL  = (s3L?4:0) + (s4L?3:0) + (msB?2:0)  + (eqL?2:0) + (swpL?2:0)
            + (vSurge?2:0) + (atrExpanding?1:0) + (mUp3?1:0) + (emaUpTrend?1:0) + sc;
  const bS  = (s3S?4:0) + (s4S?3:0) + (msBr?2:0) + (eqH?2:0) + (swpH?2:0)
            + (vSurge?2:0) + (atrExpanding?1:0) + (mDn3?1:0) + (emaDnTrend?1:0) + sc;

  const scoreL = anyL ? Math.min(f1L + f2L + f3L + f4L + bL, 40) : 0;
  const scoreS = anyS ? Math.min(f1S + f2S + f3S + f4S + bS, 40) : 0;
  const score  = direction === 'LONG' ? scoreL : scoreS;

  if (score < C.minScore) return null;

  // Grade: A+ ≥ 28 (was 24), A ≥ 16 — raised bar for A+ reflects richer 40pt scale
  const grade = score >= 28 ? 'A+' : score >= 16 ? 'A' : null;
  if (!grade) return null;

  // ── Trade style classification ─────────────────────────────────────────────
  let tradeStyle = 'scalp';
  let tp1Mult = 1, tp2Mult = 2, tp3Mult = 3;

  if (!isMGC) {
    const strongStructure = (anyL && msB) || (anyS && msBr);
    const swingSetup      = s4L || s4S;
    if (score >= C.swing_minScore && strongStructure && swingSetup) {
      tradeStyle = 'swing';
      // Swing: 50/100/150pt targets (with slPts=25)
      tp1Mult = 2; tp2Mult = 4; tp3Mult = 6;
    } else if (score >= 22 && ((anyL && (msB || emaUpTrend)) || (anyS && (msBr || emaDnTrend)))) {
      tradeStyle = 'intraday';
      // Intraday: 37.5/75/112.5pt targets (with slPts=25)
      tp1Mult = 1.5; tp2Mult = 3; tp3Mult = 4.5;
    }
  }

  const isAplus = grade === 'A+';
  const wp1     = calcWinProb(score, isAplus, sess.sessQ, setup, tradeStyle);
  const entry   = close;
  const sl2     = direction === 'LONG' ? close - C.slPts : close + C.slPts;
  const tp1     = direction === 'LONG' ? close + C.slPts * tp1Mult : close - C.slPts * tp1Mult;
  const tp2     = direction === 'LONG' ? close + C.slPts * tp2Mult : close - C.slPts * tp2Mult;
  const tp3     = direction === 'LONG' ? close + C.slPts * tp3Mult : close - C.slPts * tp3Mult;

  const ticker = isMGC ? 'MGC1!' : 'MNQ1!';

  return {
    ticker, instrument, timeframe: '1', direction, grade, setup, tradeStyle,
    entry, sl: sl2, tp1, tp2, tp3, score,
    win_prob_tp1: Math.round(wp1 * 100),
    win_prob_tp2: Math.round(wp1 * 0.72 * 100),
    win_prob_tp3: Math.round(wp1 * 0.50 * 100),
    htf_bias: htfBiasStr,
    session:  sess.sessName,
    timestamp,
  };
}

module.exports = { computeSignal };
