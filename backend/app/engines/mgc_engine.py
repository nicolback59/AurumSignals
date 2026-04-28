"""
MGC Gold Scalper v3 — Python port of the TradingView Pine Script.

Faithfully implements all 5 mandatory gates, 4 setup types, and the scoring
system from the Pine Script. Uses confirmed-bar logic (index -2 is the last
fully-closed bar, matching Pine's barstate.isconfirmed).

Tick maths:
  MGC tick size  = 0.1 points
  MGC point value = $10 / contract
  50-tick SL     = 5 pts = $50 / contract
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import pytz

from .indicators import (
    atr,
    bars_since,
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
class MGCSignal:
    instrument: str = "MGC"
    direction: str = ""          # LONG | SHORT
    setup_type: str = ""         # PB-EMA | VWAP | MOM | SWEEP
    grade: str = ""              # A+ | A | B+
    score: float = 0.0

    entry_price: float = 0.0
    sl_price: float = 0.0
    tp1_price: float = 0.0
    tp2_price: float = 0.0
    tp3_price: float = 0.0
    tp4_price: float = 0.0

    gates: dict = field(default_factory=dict)
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
            "gates_json": json.dumps(self.gates),
            "signal_time": self.signal_time.isoformat() if self.signal_time else None,
            "source": self.source,
        }


# ── Engine ────────────────────────────────────────────────────────────────────

class MGCEngine:
    """
    Generates MGC Gold Scalper v3 signals from OHLCV DataFrames.

    Parameters mirror the Pine Script inputs so they can be tuned via the
    optimization loop without changing code.
    """

    def __init__(
        self,
        # Signal engine
        min_tier: str = "A",          # A+ | A | B+
        contracts: int = 1,
        cooldown_bars: int = 3,
        # Risk structure (ticks; MGC tick = 0.1 pt)
        sl_tks: int = 50,
        tp1_tks: int = 50,
        tp2_tks: int = 75,
        tp3_tks: int = 100,
        tp4_tks: int = 125,
        tick_size: float = 0.1,
        # HTF (Gate 1)
        htf_fast: int = 9,
        htf_slow: int = 21,
        htf_slope_bars: int = 5,
        # Quality filters (Gates 3-5)
        atr_len: int = 14,
        atr_sma_len: int = 20,
        atr_exp_min: float = 1.0,
        chop_bars: int = 12,
        chop_mult: float = 2.2,
        min_candle_atr: float = 0.4,
        vol_mult: float = 1.3,
        # LTF indicators
        ema_fast: int = 9,
        ema_slow: int = 21,
        ema_trend: int = 50,
        rsi_len: int = 14,
        # Session
        best_hours_only: bool = True,
        block_lunch: bool = True,
    ):
        self.min_tier = min_tier
        self.contracts = contracts
        self.cooldown_bars = cooldown_bars

        self.sl_pts = sl_tks * tick_size
        self.tp1_pts = tp1_tks * tick_size
        self.tp2_pts = tp2_tks * tick_size
        self.tp3_pts = tp3_tks * tick_size
        self.tp4_pts = tp4_tks * tick_size
        self.tick_size = tick_size

        self.htf_fast = htf_fast
        self.htf_slow = htf_slow
        self.htf_slope_bars = htf_slope_bars

        self.atr_len = atr_len
        self.atr_sma_len = atr_sma_len
        self.atr_exp_min = atr_exp_min
        self.chop_bars = chop_bars
        self.chop_mult = chop_mult
        self.min_candle_atr = min_candle_atr
        self.vol_mult = vol_mult

        self.ema_fast = ema_fast
        self.ema_slow = ema_slow
        self.ema_trend = ema_trend
        self.rsi_len = rsi_len

        self.best_hours_only = best_hours_only
        self.block_lunch = block_lunch

        # Score thresholds by tier
        self._thresh = {"A+": 85, "A": 72, "B+": 60}

        # Cooldown state — bar index of last signal
        self._last_signal_bar: Optional[int] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def check(
        self,
        df_ltf: pd.DataFrame,
        df_htf: pd.DataFrame,
    ) -> Optional[MGCSignal]:
        """
        Evaluate the last confirmed bar of `df_ltf` against all 5 gates.

        `df_ltf` — 5m or 15m OHLCV DataFrame with a DatetimeIndex (ET-aware).
        `df_htf` — 15m OHLCV DataFrame for HTF bias (Gate 1).

        Returns an MGCSignal or None.
        """
        if len(df_ltf) < 60 or len(df_htf) < 30:
            return None

        # Confirmed bar is index -2 (last closed bar; -1 is the forming bar)
        i = -2
        n = len(df_ltf)
        bar_n = n + i   # absolute bar number for cooldown tracking

        # Cooldown check
        if self._last_signal_bar is not None:
            if bar_n - self._last_signal_bar < self.cooldown_bars:
                return None

        # Pre-compute all indicators on full history then read at index i
        ind = self._compute_indicators(df_ltf, df_htf)

        # ── Gate 1: HTF Bias ────────────────────────────────────────────────
        g1_long = bool(ind["g1_long"].iloc[i])
        g1_short = bool(ind["g1_short"].iloc[i])

        # ── Gate 2: VWAP Side ───────────────────────────────────────────────
        g2_long = bool(ind["g2_long"].iloc[i])
        g2_short = bool(ind["g2_short"].iloc[i])

        # ── Gate 3: Regime ──────────────────────────────────────────────────
        g3 = bool(ind["g3"].iloc[i])

        # ── Gate 4: Candle Quality ──────────────────────────────────────────
        g4_long = bool(ind["g4_long"].iloc[i])
        g4_short = bool(ind["g4_short"].iloc[i])

        # ── Gate 5: RSI Zone ────────────────────────────────────────────────
        g5_long = bool(ind["g5_long"].iloc[i])
        g5_short = bool(ind["g5_short"].iloc[i])

        # ── Setups ──────────────────────────────────────────────────────────
        s1l = bool(ind["s1l"].iloc[i])
        s2l = bool(ind["s2l"].iloc[i])
        s3l = bool(ind["s3l"].iloc[i])
        s4l = bool(ind["s4l"].iloc[i])
        s1s = bool(ind["s1s"].iloc[i])
        s2s = bool(ind["s2s"].iloc[i])
        s3s = bool(ind["s3s"].iloc[i])
        s4s = bool(ind["s4s"].iloc[i])

        any_l = s1l or s2l or s3l or s4l
        any_s = s1s or s2s or s3s or s4s

        spike = bool(ind["spike"].iloc[i])

        # ── Final gate combination ───────────────────────────────────────────
        long_sig = (any_l and g1_long and g2_long and g3 and g4_long and g5_long and not spike)
        short_sig = (any_s and g1_short and g2_short and g3 and g4_short and g5_short and not spike)

        if not long_sig and not short_sig:
            return None

        # Direction with priority: long wins ties (rare)
        direction = "LONG" if long_sig else "SHORT"

        # Score
        score = self._score(ind, i, direction, s1l, s2l, s3l, s4l, s1s, s2s, s3s, s4s)
        thresh = self._thresh.get(self.min_tier, 72)
        if score < thresh:
            return None

        # Setup name
        if direction == "LONG":
            setup = "PB-EMA" if s1l else "VWAP" if s2l else "MOM" if s3l else "SWEEP"
        else:
            setup = "PB-EMA" if s1s else "VWAP" if s2s else "MOM" if s3s else "SWEEP"

        # Grade
        grade = "A+" if score >= 85 else "A" if score >= 72 else "B+"

        # Prices
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

        gates_state = {
            "G1_HTF": g1_long if direction == "LONG" else g1_short,
            "G2_VWAP": g2_long if direction == "LONG" else g2_short,
            "G3_Regime": g3,
            "G4_Candle": g4_long if direction == "LONG" else g4_short,
            "G5_RSI": g5_long if direction == "LONG" else g5_short,
            "htf_bull": bool(ind["htf_bull"].iloc[i]),
            "htf_bear": bool(ind["htf_bear"].iloc[i]),
            "is_chop": bool(ind["is_chop"].iloc[i]),
            "atr_exp": bool(ind["atr_exp"].iloc[i]),
            "rsi_val": round(float(ind["rsi_s"].iloc[i]), 1),
        }

        # Bar time (last confirmed bar)
        bar_time = df_ltf.index[i]
        if hasattr(bar_time, "to_pydatetime"):
            bar_time = bar_time.to_pydatetime()

        self._last_signal_bar = bar_n

        return MGCSignal(
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
            gates=gates_state,
            signal_time=bar_time,
        )

    # ── Indicator pre-computation ─────────────────────────────────────────────

    def _compute_indicators(self, df: pd.DataFrame, df_htf: pd.DataFrame) -> dict:
        o, h, l, c, v = df["open"], df["high"], df["low"], df["close"], df["volume"]

        atr_s = atr(h, l, c, self.atr_len)
        atr_sma_s = sma(atr_s, self.atr_sma_len)
        atr_exp = atr_s > atr_sma_s * self.atr_exp_min

        ema_f = ema(c, self.ema_fast)
        ema_s = ema(c, self.ema_slow)
        ema_t = ema(c, self.ema_trend)
        rsi_s = rsi(c, self.rsi_len)
        vwap_s = vwap_daily(h, l, c, v)
        vol_avg = sma(v, 20)

        # ── Gate 1: HTF Bias ─────────────────────────────────────────────────
        htf_fast_s = ema(df_htf["close"], self.htf_fast).reindex(df.index, method="ffill")
        htf_slow_s = ema(df_htf["close"], self.htf_slow).reindex(df.index, method="ffill")
        htf_close_s = df_htf["close"].reindex(df.index, method="ffill")

        htf_bull = (htf_fast_s > htf_slow_s) & (htf_close_s > htf_slow_s)
        htf_bear = (htf_fast_s < htf_slow_s) & (htf_close_s < htf_slow_s)
        htf_bull_mom = htf_fast_s > htf_fast_s.shift(self.htf_slope_bars)
        htf_bear_mom = htf_fast_s < htf_fast_s.shift(self.htf_slope_bars)

        g1_long = htf_bull & htf_bull_mom
        g1_short = htf_bear & htf_bear_mom

        # ── Gate 2: VWAP Side ────────────────────────────────────────────────
        vwap_dist = (c - vwap_s).abs() / atr_s.replace(0, pd.NA)
        vwap_far = vwap_dist > 3.5
        abv_vwap = c > vwap_s
        blw_vwap = c < vwap_s

        g2_long = abv_vwap & ~vwap_far
        g2_short = blw_vwap & ~vwap_far

        # ── Gate 3: Regime ───────────────────────────────────────────────────
        chop_h = highest(h, self.chop_bars)
        chop_l = lowest(l, self.chop_bars)
        is_chop = (chop_h - chop_l) < atr_s * self.chop_mult

        in_session = self._session_mask(df.index)
        g3 = ~is_chop & atr_exp & in_session

        # ── Gate 4: Candle Quality ───────────────────────────────────────────
        c_rng = h - l
        c_body = (c - o).abs()
        bull = c > o
        bear = c < o
        c_loc = (c - l) / c_rng.replace(0, pd.NA)

        spike = c_rng >= 5.0 * atr_s

        disp_bull = (c_body >= self.min_candle_atr * atr_s) & (c_loc >= 0.62) & bull & ~spike
        disp_bear = (c_body >= self.min_candle_atr * atr_s) & (c_loc <= 0.38) & bear & ~spike

        l_wick = pd.concat([o, c], axis=1).min(axis=1) - l
        u_wick = h - pd.concat([o, c], axis=1).max(axis=1)
        l_wr = l_wick / c_rng.replace(0, pd.NA)
        u_wr = u_wick / c_rng.replace(0, pd.NA)

        rej_up = (l_wr >= 0.35) & (l_wick > c_body * 0.5) & (c_rng >= atr_s * 0.3)
        rej_down = (u_wr >= 0.35) & (u_wick > c_body * 0.5) & (c_rng >= atr_s * 0.3)

        vol_surge = v > vol_avg * self.vol_mult
        m_bull = (c > h.shift(1)) & bull
        m_bear = (c < l.shift(1)) & bear

        g4_long = (disp_bull | (rej_up & m_bull)) & vol_surge
        g4_short = (disp_bear | (rej_down & m_bear)) & vol_surge

        # ── Gate 5: RSI Zone ─────────────────────────────────────────────────
        rsi_ob = rsi_s > 68
        rsi_os = rsi_s < 32
        rsi_bull = (rsi_s >= 45) & (rsi_s <= 65)
        rsi_bear = (rsi_s >= 35) & (rsi_s <= 55)

        g5_long = rsi_bull & ~rsi_ob
        g5_short = rsi_bear & ~rsi_os

        # ── EMA structure ────────────────────────────────────────────────────
        bull_stack = (ema_f > ema_s) & (ema_s > ema_t)
        bear_stack = (ema_f < ema_s) & (ema_s < ema_t)
        ema_f_bull = ema_f > ema_f.shift(2)
        ema_f_bear = ema_f < ema_f.shift(2)
        near_ema_f = (c - ema_f).abs() <= atr_s * 0.5
        abv_s_s = c > ema_s
        blw_s_s = c < ema_s
        abv_t = c > ema_t
        blw_t = c < ema_t

        # ── VWAP interactions ─────────────────────────────────────────────────
        near_vwap = vwap_dist <= 1.0
        vwap_rec_u = abv_vwap & ~abv_vwap.shift(1).fillna(False)
        vwap_rec_d = blw_vwap & ~blw_vwap.shift(1).fillna(False)
        vwap_rej_u = (l < vwap_s) & abv_vwap & rej_up
        vwap_rej_d = (h > vwap_s) & blw_vwap & rej_down

        # ── Liquidity sweep (S4) ──────────────────────────────────────────────
        ref_h = highest(h, 10)
        ref_l = lowest(l, 10)
        sweep_l = (l < ref_l.shift(1)) & (c > ref_l.shift(1)) & bull & ~spike
        sweep_h = (h > ref_h.shift(1)) & (c < ref_h.shift(1)) & bear & ~spike
        swp_la = bars_since(sweep_l)
        swp_ha = bars_since(sweep_h)

        # ── Setup conditions ──────────────────────────────────────────────────
        s1l = g1_long & bull_stack & near_ema_f & abv_s_s & (disp_bull | (rej_up & m_bull)) & ema_f_bull
        s1s = g1_short & bear_stack & near_ema_f & blw_s_s & (disp_bear | (rej_down & m_bear)) & ema_f_bear

        s2l = g1_long & (vwap_rec_u | vwap_rej_u) & abv_vwap
        s2s = g1_short & (vwap_rec_d | vwap_rej_d) & blw_vwap

        s3l = g1_long & disp_bull & bull_stack & abv_t & ema_f_bull
        s3s = g1_short & disp_bear & bear_stack & blw_t & ema_f_bear

        s4l = sweep_l & (swp_la <= 2) & disp_bull & (htf_bull | htf_bull_mom)
        s4s = sweep_h & (swp_ha <= 2) & disp_bear & (htf_bear | htf_bear_mom)

        return dict(
            atr_s=atr_s, atr_exp=atr_exp, is_chop=is_chop,
            g1_long=g1_long, g1_short=g1_short,
            g2_long=g2_long, g2_short=g2_short,
            g3=g3,
            g4_long=g4_long, g4_short=g4_short,
            g5_long=g5_long, g5_short=g5_short,
            htf_bull=htf_bull, htf_bear=htf_bear,
            htf_bull_mom=htf_bull_mom, htf_bear_mom=htf_bear_mom,
            bull_stack=bull_stack, bear_stack=bear_stack,
            disp_bull=disp_bull, disp_bear=disp_bear,
            rej_up=rej_up, rej_down=rej_down,
            vol_surge=vol_surge, rsi_s=rsi_s,
            abv_vwap=abv_vwap, blw_vwap=blw_vwap,
            near_vwap=near_vwap, vwap_far=vwap_far,
            spike=spike, swp_la=swp_la, swp_ha=swp_ha,
            s1l=s1l, s2l=s2l, s3l=s3l, s4l=s4l,
            s1s=s1s, s2s=s2s, s3s=s3s, s4s=s4s,
            sess_bonus=self._session_bonus(df.index),
        )

    # ── Session helpers ───────────────────────────────────────────────────────

    def _session_mask(self, index: pd.DatetimeIndex) -> pd.Series:
        """Returns True for bars in the active trading session (ET hours)."""
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

    def _session_bonus(self, index: pd.DatetimeIndex) -> pd.Series:
        """Score bonus based on session quality."""
        et_times = index.tz_convert(ET) if index.tzinfo is not None else index.tz_localize("UTC").tz_convert(ET)
        hour = et_times.hour

        is_overlap = (hour >= 8) & (hour < 11)
        is_ny = (hour >= 8) & (hour < 12)
        is_london = (hour >= 2) & (hour < 8)

        bonus = pd.Series(0, index=index, dtype=int)
        bonus[is_london] = 5
        bonus[is_ny] = 7
        bonus[is_overlap] = 10
        return bonus

    # ── Scoring ───────────────────────────────────────────────────────────────

    def _score(
        self, ind: dict, i: int, direction: str,
        s1l: bool, s2l: bool, s3l: bool, s4l: bool,
        s1s: bool, s2s: bool, s3s: bool, s4s: bool,
    ) -> float:
        s = 0

        if direction == "LONG":
            s += 28 if s1l else 26 if s2l else 24 if s3l else 22 if s4l else 0
            s += 15 if (ind["g1_long"].iloc[i] and ind["htf_bull_mom"].iloc[i]) else 8 if ind["g1_long"].iloc[i] else 0
            s += 10 if ind["bull_stack"].iloc[i] else 5 if (ind["atr_s"].iloc[i] > 0) else 0  # abvT proxy
            s += 12 if ind["disp_bull"].iloc[i] else 8 if ind["rej_up"].iloc[i] else 0
            s += 8 if ind["vol_surge"].iloc[i] else 0
            s += 7 if ((ind["rsi_s"].iloc[i] >= 45) and (ind["rsi_s"].iloc[i] <= 65)) else 0
            s += 8 if (ind["abv_vwap"].iloc[i] and not ind["vwap_far"].iloc[i]) else 0
            s += 4 if ind["near_vwap"].iloc[i] else 0
            s += int(ind["sess_bonus"].iloc[i])
            s += 5 if (ind["swp_la"].iloc[i] <= 3) else 0
            s += -20 if ind["is_chop"].iloc[i] else 0
            s += -12 if not ind["atr_exp"].iloc[i] else 0
            s += -20 if (ind["rsi_s"].iloc[i] > 68) else 0
            s += -12 if ind["blw_vwap"].iloc[i] else 0
            s += -10 if ind["vwap_far"].iloc[i] else 0
            s += -25 if (ind["spike"].iloc[i] or ind["spike"].shift(1).fillna(False).iloc[i]) else 0
        else:
            s += 28 if s1s else 26 if s2s else 24 if s3s else 22 if s4s else 0
            s += 15 if (ind["g1_short"].iloc[i] and ind["htf_bear_mom"].iloc[i]) else 8 if ind["g1_short"].iloc[i] else 0
            s += 10 if ind["bear_stack"].iloc[i] else 5 if (ind["atr_s"].iloc[i] > 0) else 0
            s += 12 if ind["disp_bear"].iloc[i] else 8 if ind["rej_down"].iloc[i] else 0
            s += 8 if ind["vol_surge"].iloc[i] else 0
            s += 7 if ((ind["rsi_s"].iloc[i] >= 35) and (ind["rsi_s"].iloc[i] <= 55)) else 0
            s += 8 if (ind["blw_vwap"].iloc[i] and not ind["vwap_far"].iloc[i]) else 0
            s += 4 if ind["near_vwap"].iloc[i] else 0
            s += int(ind["sess_bonus"].iloc[i])
            s += 5 if (ind["swp_ha"].iloc[i] <= 3) else 0
            s += -20 if ind["is_chop"].iloc[i] else 0
            s += -12 if not ind["atr_exp"].iloc[i] else 0
            s += -20 if (ind["rsi_s"].iloc[i] < 32) else 0
            s += -12 if ind["abv_vwap"].iloc[i] else 0
            s += -10 if ind["vwap_far"].iloc[i] else 0
            s += -25 if (ind["spike"].iloc[i] or ind["spike"].shift(1).fillna(False).iloc[i]) else 0

        return float(min(max(s, 0), 100))
