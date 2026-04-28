"""
Technical indicator implementations that match Pine Script's built-ins.

All functions accept pandas Series and return pandas Series.
Results match TradingView's calculation methods (Wilder smoothing for ATR/RSI,
daily-reset VWAP, population stdev matching ta.stdev).
"""

import pandas as pd
import numpy as np
from typing import Optional


# ── Moving averages ──────────────────────────────────────────────────────────

def ema(series: pd.Series, length: int) -> pd.Series:
    """Exponential Moving Average — matches Pine ta.ema()."""
    return series.ewm(span=length, adjust=False).mean()


def sma(series: pd.Series, length: int) -> pd.Series:
    """Simple Moving Average — matches Pine ta.sma()."""
    return series.rolling(window=length).mean()


def rma(series: pd.Series, length: int) -> pd.Series:
    """Wilder's Moving Average (RMA) — used internally by ta.atr() and ta.rsi()."""
    return series.ewm(alpha=1.0 / length, adjust=False).mean()


# ── Volatility ───────────────────────────────────────────────────────────────

def atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    """Average True Range using Wilder smoothing — matches Pine ta.atr()."""
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return rma(tr, length)


def stdev(series: pd.Series, length: int = 20) -> pd.Series:
    """Rolling population standard deviation — matches Pine ta.stdev() (ddof=0)."""
    return series.rolling(window=length).std(ddof=0)


# ── Momentum ─────────────────────────────────────────────────────────────────

def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    """RSI using Wilder smoothing — matches Pine ta.rsi()."""
    delta = close.diff()
    up = delta.clip(lower=0)
    down = (-delta).clip(lower=0)
    avg_up = rma(up, length)
    avg_down = rma(down, length)
    rs = avg_up / avg_down.replace(0, np.nan)
    return 100.0 - (100.0 / (1.0 + rs))


# ── Volume / VWAP ─────────────────────────────────────────────────────────────

def vwap_daily(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    volume: pd.Series,
) -> pd.Series:
    """
    VWAP with daily reset matching Pine ta.vwap(hlc3).
    Index must be a DatetimeIndex with timezone info so day boundaries are correct.
    """
    hlc3 = (high + low + close) / 3.0
    idx = pd.to_datetime(high.index)
    # Normalise to calendar date in whatever tz the index carries
    dates = idx.normalize() if hasattr(idx, "normalize") else idx.date

    result = pd.Series(np.nan, index=high.index, dtype=float)
    for d in pd.unique(dates):
        mask = dates == d
        pv = (hlc3[mask] * volume[mask]).cumsum()
        vol = volume[mask].cumsum()
        result[mask] = pv / vol.replace(0, np.nan)
    return result


# ── Range helpers ─────────────────────────────────────────────────────────────

def highest(series: pd.Series, length: int) -> pd.Series:
    """Rolling highest — matches Pine ta.highest()."""
    return series.rolling(window=length).max()


def lowest(series: pd.Series, length: int) -> pd.Series:
    """Rolling lowest — matches Pine ta.lowest()."""
    return series.rolling(window=length).min()


# ── Structure ─────────────────────────────────────────────────────────────────

def pivot_high(high: pd.Series, left: int = 4, right: int = 4) -> pd.Series:
    """
    Detect pivot highs.
    Returns NaN except at bar i when high[i] is the max of the [i-left, i+right] window.
    NOTE: result is shifted `right` bars into the past (like Pine's ta.pivothigh).
    """
    result = pd.Series(np.nan, index=high.index, dtype=float)
    arr = high.to_numpy()
    for i in range(left, len(arr) - right):
        window = arr[i - left : i + right + 1]
        if arr[i] == window.max():
            result.iloc[i] = arr[i]
    return result


def pivot_low(low: pd.Series, left: int = 4, right: int = 4) -> pd.Series:
    """Detect pivot lows (symmetric to pivot_high)."""
    result = pd.Series(np.nan, index=low.index, dtype=float)
    arr = low.to_numpy()
    for i in range(left, len(arr) - right):
        window = arr[i - left : i + right + 1]
        if arr[i] == window.min():
            result.iloc[i] = arr[i]
    return result


def bars_since(condition: pd.Series) -> pd.Series:
    """
    Number of bars since `condition` was last True.
    Returns large number (999) when condition has never been True.
    """
    result = pd.Series(999, index=condition.index, dtype=int)
    last_true = None
    for i, (idx, val) in enumerate(condition.items()):
        if val:
            last_true = i
        result.iloc[i] = 999 if last_true is None else i - last_true
    return result
