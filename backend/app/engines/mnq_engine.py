"""
NQ Pro Signal Engine v4 — Python port of the TradingView Pine Script.

Implements the 4-factor model:
  F1: HTF Bias       — 15m EMA structure
  F2: OTE Zone       — 61.8-78.6% Fibonacci retracement (ICT Optimal Trade Entry)
  F3: STDV Deviation — VWAP 1σ / 2σ band overextension detection
  F4: Confirmation   — displacement candle + volume surge

3 setup types: OTE_PULLBACK | STDV_REVERSAL | OTE_STDV_COMBO

Tick maths:
  MNQ tick size   = 0.25 points
  MNQ point value = $2.00 / contract
  25-point SL     = 100 ticks = $50 / contract
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import pytz

from .indicators import (
    atr,
    ema,
    highest,
    lowest,
    rsi,
    sma,
    stdev,
    vwap_daily,
)

logger = logging.getLogger(__name__)
ET = pytz.timezone("America/New_York")


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class MNQSignal:
    instrument: str = "MNQ"
    direction: str = ""           # LONG | SHORT
    setup_type: str = ""          # OTE_PULLBACK | STDV_REVERSAL | OTE_STDV_COMBO
    grade: str = ""               # A+ | A
    score: float = 0.0

    entry_price: float = 0.0
    sl_price: float = 0.0
    tp1_price: float = 0.0
    tp2_price: float = 0.0
    tp3_price: float = 0.0
    tp4_price: float = 0.0

    # Price levels shown on chart
    ote_low: float = 0.0
    ote_high: float = 0.0
    stdv1_upper: float = 0.0
    stdv1_lower: float = 0.0
    stdv2_upper: float = 0.0
    stdv2_lower: float = 0.0

    factors: dict = field(default_factory=dict)
    signal_time: Optional[datetime] = None
    source: str = "ENGINE"

    def to_dict(self) -> dict:
        return {
            "instrument": self.instrument,
            "direction": self.direction,
            "setup_type": self.setup_type,
            "grade": self.grade,
            "score": self.score,
            "entry_price": self.entry_price,
            "sl_price": self.sl_price,
            "tp1_price": self.tp1_price,
            "tp2_price": self.tp2_price,
            "tp3_price": self.tp3_price,
            "tp4_price": self.tp4_price,
            "gates_json": json.dumps(self.factors),
            "signal_time": self.signal_time.isoformat() if self.signal_time else None,
            "source": self.source,
        }


# ── Engine ────────────────────────────────────────────────────────────────────

class MNQEngine:
    """
    Generates MNQ (Micro E-mini Nasdaq) signals from the NQ Pro v4 strategy.

    Parameters mirror Pine Script inputs so the optimization loop can tune them.
    """

    def __init__(
        self,
        min_grade: str = "A",          # A+ | A
        sl_pts: int = 25,              # points
        tp_pts: int = 75,              # full target points
        contracts: int = 1,
        cooldown_bars: int = 3,
        max_bars: int = 50,
        # OTE settings
        ote_low_fib: float = 0.618,
        ote_high_fib: float = 0.786,
        swing_lookback: int = 20,
        # STDV settings
        stdv_len: int = 20,
        std1_mult: float = 1.0,
        std2_mult: float = 2.0,
        # HTF
        htf_ema_fast: int = 9,
        htf_ema_slow: int = 21,
        # LTF indicators
        atr_len: int = 14,
        ema_fast: int = 9,
        ema_slow: int = 21,
        ema_trend: int = 50,
        # Breakeven
        be_bars: int = 8,
        be_favor_pts: int = 10,
        # Session
        best_hours_only: bool = True,
        block_lunch: bool = True,
    ):
        self.min_grade = min_grade
        self.sl_pts = sl_pts
        # TP levels: TP1=1/3 target, TP2=2/3, TP3=full, TP4=1.5x
        self.tp1_pts = tp_pts // 3
        self.tp2_pts = (tp_pts * 2) // 3
        self.tp3_pts = tp_pts
        self.tp4_pts = int(tp_pts * 1.5)
        self.contracts = contracts
        self.cooldown_bars = cooldown_bars
        self.max_bars = max_bars

        self.ote_low_fib = ote_low_fib
        self.ote_high_fib = ote_high_fib
        self.swing_lookback = swing_lookback

        self.stdv_len = stdv_len
        self.std1_mult = std1_mult
        self.std2_mult = std2_mult

        self.htf_ema_fast = htf_ema_fast
        self.htf_ema_slow = htf_ema_slow

        self.atr_len = atr_len
        self.ema_fast = ema_fast
        self.ema_slow = ema_slow
        self.ema_trend = ema_trend

        self.be_bars = be_bars
        self.be_favor_pts = be_favor_pts

        self.best_hours_only = best_hours_only
        self.block_lunch = block_lunch

        self._last_signal_bar: Optional[int] = None
        self._grade_thresh = {"A+": 85, "A": 70}

    # ── Public API ────────────────────────────────────────────────────────────

    def check(
        self,
        df_ltf: pd.DataFrame,
        df_htf: pd.DataFrame,
    ) -> Optional[MNQSignal]:
        """
        Evaluate the last confirmed bar of `df_ltf`.

        `df_ltf` — 5m OHLCV DataFrame with DatetimeIndex (timezone-aware).
        `df_htf` — 15m OHLCV DataFrame for HTF bias.

        Returns MNQSignal or None.
        """
        if len(df_ltf) < 60 or len(df_htf) < 30:
            return None

        i = -2  # last confirmed bar
        bar_n = len(df_ltf) + i

        if self._last_signal_bar is not None:
            if bar_n - self._last_signal_bar < self.cooldown_bars:
                return None

        ind = self._compute_indicators(df_ltf, df_htf)

        # Factor checks at bar i
        f1_bull = bool(ind["f1_bull"].iloc[i])
        f1_bear = bool(ind["f1_bear"].iloc[i])

        f2_long = bool(ind["f2_long"].iloc[i])
        f2_short = bool(ind["f2_short"].iloc[i])

        f3_long = bool(ind["f3_long"].iloc[i])
        f3_short = bool(ind["f3_short"].iloc[i])

        f4_long = bool(ind["f4_long"].iloc[i])
        f4_short = bool(ind["f4_short"].iloc[i])

        in_session = bool(ind["in_session"].iloc[i])
        spike = bool(ind["spike"].iloc[i])

        # ── Setup types ────────────────────────────────────────────────────
        # OTE Pullback: HTF bias + OTE zone + confirmation
        ote_pb_long = f1_bull and f2_long and f4_long and in_session
        ote_pb_short = f1_bear and f2_short and f4_short and in_session

        # STDV Reversal: VWAP band overextension + confirmation
        stdv_rev_long = f1_bull and f3_long and f4_long and in_session
        stdv_rev_short = f1_bear and f3_short and f4_short and in_session

        # OTE + STDV Combo: both F2 and F3 align (highest grade)
        combo_long = f1_bull and f2_long and f3_long and f4_long and in_session
        combo_short = f1_bear and f2_short and f3_short and f4_short and in_session

        any_long = ote_pb_long or stdv_rev_long or combo_long
        any_short = ote_pb_short or stdv_rev_short or combo_short

        if not any_long and not any_short:
            return None

        direction = "LONG" if any_long else "SHORT"
        score = self._score(ind, i, direction, combo_long, combo_short, ote_pb_long, ote_pb_short)

        thresh = self._grade_thresh.get(self.min_grade, 70)
        if score < thresh:
            return None

        # Setup label
        if direction == "LONG":
            setup = "OTE+STDV" if combo_long else "OTE_PULLBACK" if ote_pb_long else "STDV_REVERSAL"
        else:
            setup = "OTE+STDV" if combo_short else "OTE_PULLBACK" if ote_pb_short else "STDV_REVERSAL"

        grade = "A+" if score >= 85 else "A"

        entry = float(df_ltf["close"].iloc[i])
        if direction == "LONG":
            sl = entry - self.sl_pts
            tp1 = entry + self.tp1_pts
            tp2 = entry + self.tp2_pts
            tp3 = entry + self.tp3_pts
            tp4 = entry + self.tp4_pts
        else:
            sl = entry + self.sl_pts
            tp1 = entry - self.tp1_pts
            tp2 = entry - self.tp2_pts
            tp3 = entry - self.tp3_pts
            tp4 = entry - self.tp4_pts

        factors_state = {
            "F1_HTF": f1_bull if direction == "LONG" else f1_bear,
            "F2_OTE": f2_long if direction == "LONG" else f2_short,
            "F3_STDV": f3_long if direction == "LONG" else f3_short,
            "F4_Confirm": f4_long if direction == "LONG" else f4_short,
            "in_session": in_session,
            "ote_low": round(float(ind["ote_low"].iloc[i]), 2),
            "ote_high": round(float(ind["ote_high"].iloc[i]), 2),
            "stdv1_upper": round(float(ind["stdv1_upper"].iloc[i]), 2),
            "stdv1_lower": round(float(ind["stdv1_lower"].iloc[i]), 2),
            "stdv2_upper": round(float(ind["stdv2_upper"].iloc[i]), 2),
            "stdv2_lower": round(float(ind["stdv2_lower"].iloc[i]), 2),
        }

        bar_time = df_ltf.index[i]
        if hasattr(bar_time, "to_pydatetime"):
            bar_time = bar_time.to_pydatetime()

        self._last_signal_bar = bar_n

        return MNQSignal(
            direction=direction,
            setup_type=setup,
            grade=grade,
            score=round(score, 1),
            entry_price=round(entry, 2),
            sl_price=round(sl, 2),
            tp1_price=round(tp1, 2),
            tp2_price=round(tp2, 2),
            tp3_price=round(tp3, 2),
            tp4_price=round(tp4, 2),
            ote_low=factors_state["ote_low"],
            ote_high=factors_state["ote_high"],
            stdv1_upper=factors_state["stdv1_upper"],
            stdv1_lower=factors_state["stdv1_lower"],
            stdv2_upper=factors_state["stdv2_upper"],
            stdv2_lower=factors_state["stdv2_lower"],
            factors=factors_state,
            signal_time=bar_time,
        )

    # ── Indicator pre-computation ─────────────────────────────────────────────

    def _compute_indicators(self, df: pd.DataFrame, df_htf: pd.DataFrame) -> dict:
        o, h, l, c, v = df["open"], df["high"], df["low"], df["close"], df["volume"]

        atr_s = atr(h, l, c, self.atr_len)
        atr_sma_s = sma(atr_s, 20)
        atr_exp = atr_s > atr_sma_s * 1.05

        ema_f = ema(c, self.ema_fast)
        ema_s_s = ema(c, self.ema_slow)
        ema_t = ema(c, self.ema_trend)

        vwap_s = vwap_daily(h, l, c, v)
        std_s = stdev(c, self.stdv_len)
        vol_avg = sma(v, 20)

        # STDV bands
        stdv1_upper = vwap_s + std_s * self.std1_mult
        stdv1_lower = vwap_s - std_s * self.std1_mult
        stdv2_upper = vwap_s + std_s * self.std2_mult
        stdv2_lower = vwap_s - std_s * self.std2_mult

        # ── Factor 1: HTF Bias ────────────────────────────────────────────────
        htf_fast_s = ema(df_htf["close"], self.htf_ema_fast).reindex(df.index, method="ffill")
        htf_slow_s = ema(df_htf["close"], self.htf_ema_slow).reindex(df.index, method="ffill")

        f1_bull = htf_fast_s > htf_slow_s
        f1_bear = htf_fast_s < htf_slow_s

        # ── Factor 2: OTE Zone ────────────────────────────────────────────────
        # ICT OTE: price retraces 61.8-78.6% of a recent swing in HTF direction
        swing_h = highest(h, self.swing_lookback)
        swing_l = lowest(l, self.swing_lookback)

        # Bull OTE zone: in a discount area during uptrend
        # (swing_l + fib_low * range) to (swing_l + fib_high * range)
        swing_range = swing_h - swing_l
        ote_bull_low = swing_l + swing_range * self.ote_low_fib
        ote_bull_high = swing_l + swing_range * self.ote_high_fib

        # Bear OTE zone: in a premium area during downtrend
        ote_bear_low = swing_h - swing_range * self.ote_high_fib
        ote_bear_high = swing_h - swing_range * self.ote_low_fib

        in_ote_bull = (c >= ote_bull_low) & (c <= ote_bull_high)
        in_ote_bear = (c >= ote_bear_low) & (c <= ote_bear_high)

        # Use bull OTE for long (unified label)
        ote_low = ote_bull_low
        ote_high = ote_bull_high

        # ── Factor 3: STDV Overextension ──────────────────────────────────────
        # Long signal: price at/below STDV1 lower (oversold vs VWAP)
        # Short signal: price at/above STDV1 upper (overbought vs VWAP)
        at_stdv1_lower = c <= stdv1_lower
        at_stdv2_lower = c <= stdv2_lower
        at_stdv1_upper = c >= stdv1_upper
        at_stdv2_upper = c >= stdv2_upper

        # Returning toward VWAP from extension
        f3_long = at_stdv1_lower & (c > c.shift(1)) & f1_bull
        f3_short = at_stdv1_upper & (c < c.shift(1)) & f1_bear

        # ── Factor 2 final ───────────────────────────────────────────────────
        f2_long = in_ote_bull & f1_bull
        f2_short = in_ote_bear & f1_bear

        # ── Factor 4: Confirmation ───────────────────────────────────────────
        c_rng = h - l
        c_body = (c - o).abs()
        bull = c > o
        bear = c < o
        c_loc = (c - l) / c_rng.replace(0, pd.NA)

        spike = c_rng >= 5.0 * atr_s

        disp_bull = (c_body >= 0.4 * atr_s) & (c_loc >= 0.60) & bull & ~spike
        disp_bear = (c_body >= 0.4 * atr_s) & (c_loc <= 0.40) & bear & ~spike

        vol_surge = v > vol_avg * 1.3

        f4_long = disp_bull & vol_surge
        f4_short = disp_bear & vol_surge

        # ── Session ──────────────────────────────────────────────────────────
        in_session = self._session_mask(df.index)

        return dict(
            atr_s=atr_s, atr_exp=atr_exp,
            f1_bull=f1_bull, f1_bear=f1_bear,
            f2_long=f2_long, f2_short=f2_short,
            f3_long=f3_long, f3_short=f3_short,
            f4_long=f4_long, f4_short=f4_short,
            disp_bull=disp_bull, disp_bear=disp_bear,
            vol_surge=vol_surge, spike=spike,
            vwap_s=vwap_s,
            stdv1_upper=stdv1_upper, stdv1_lower=stdv1_lower,
            stdv2_upper=stdv2_upper, stdv2_lower=stdv2_lower,
            ote_low=ote_low, ote_high=ote_high,
            in_ote_bull=in_ote_bull, in_ote_bear=in_ote_bear,
            in_session=in_session,
            htf_fast_s=htf_fast_s, htf_slow_s=htf_slow_s,
        )

    def _session_mask(self, index: pd.DatetimeIndex) -> pd.Series:
        et_times = index.tz_convert(ET) if index.tzinfo is not None else index.tz_localize("UTC").tz_convert(ET)
        hour = et_times.hour
        minute = et_times.minute

        is_london = (hour >= 2) & (hour < 8)
        is_ny_open = (hour >= 8) & (hour < 12)
        is_afternoon = (hour >= 13) & (hour < 17)
        is_lunch = ((hour == 12) | ((hour == 13) & (minute < 30))) & self.block_lunch

        if self.best_hours_only:
            active = (is_london | is_ny_open) & ~is_lunch
        else:
            active = (is_london | is_ny_open | is_afternoon) & ~is_lunch

        return pd.Series(active, index=index)

    # ── Scoring ───────────────────────────────────────────────────────────────

    def _score(
        self, ind: dict, i: int, direction: str,
        combo_long: bool, combo_short: bool,
        ote_long: bool, ote_short: bool,
    ) -> float:
        s = 0

        if direction == "LONG":
            # Setup quality
            s += 35 if combo_long else 28 if ote_long else 22
            # HTF strength
            s += 15 if ind["f1_bull"].iloc[i] else 0
            # OTE precision
            s += 20 if ind["in_ote_bull"].iloc[i] else 0
            # STDV location
            s += 15 if ind["f3_long"].iloc[i] else 0
            # Confirmation
            s += 10 if ind["disp_bull"].iloc[i] else 5 if ind["vol_surge"].iloc[i] else 0
            # Session
            s += 5 if ind["in_session"].iloc[i] else -20
            # Anti-spike
            s += -25 if ind["spike"].iloc[i] else 0
            # ATR regime
            s += 5 if ind["atr_exp"].iloc[i] else -10
        else:
            s += 35 if combo_short else 28 if ote_short else 22
            s += 15 if ind["f1_bear"].iloc[i] else 0
            s += 20 if ind["in_ote_bear"].iloc[i] else 0
            s += 15 if ind["f3_short"].iloc[i] else 0
            s += 10 if ind["disp_bear"].iloc[i] else 5 if ind["vol_surge"].iloc[i] else 0
            s += 5 if ind["in_session"].iloc[i] else -20
            s += -25 if ind["spike"].iloc[i] else 0
            s += 5 if ind["atr_exp"].iloc[i] else -10

        return float(min(max(s, 0), 100))
