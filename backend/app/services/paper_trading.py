"""
Paper trading service.

Responsibilities:
  1. Open a paper trade when a signal arrives.
  2. Resolve open trades against historical or live OHLCV data
     (checks if TP or SL was hit on subsequent bars).
  3. Calculate P&L in both points and dollars.

P&L reference:
  MGC — $10/point,  SL=5pts ($50), TP1=5pts ($50)  per contract
  MNQ — $2/point,   SL=25pts ($50), TP3=75pts ($150) per contract
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import pandas as pd

from sqlalchemy.orm import Session

from ..models import PaperTrade, Signal

logger = logging.getLogger(__name__)

# Dollar value per point per instrument
_POINT_VALUE = {"MGC": 10.0, "MNQ": 2.0}

# Maximum bars before a trade is expired (acts as time-stop)
_MAX_BARS = 60


def open_paper_trade(
    db: Session,
    signal: Signal,
    contracts: int = 1,
) -> PaperTrade:
    """Create a new OPEN paper trade from a signal."""
    trade = PaperTrade(
        signal_id=signal.id,
        instrument=signal.instrument,
        direction=signal.direction,
        entry_price=signal.entry_price,
        contracts=contracts,
        opened_at=signal.signal_time or datetime.now(timezone.utc),
        status="OPEN",
    )
    db.add(trade)
    db.commit()
    db.refresh(trade)
    logger.info(
        "Opened paper trade #%d  %s %s @ %.2f",
        trade.id, trade.instrument, trade.direction, trade.entry_price,
    )
    return trade


def resolve_open_trades(db: Session, df: pd.DataFrame, instrument: str) -> list[PaperTrade]:
    """
    Check all OPEN paper trades for `instrument` against the supplied OHLCV
    DataFrame and close any that have hit their TP or SL.

    `df` should contain bars AFTER the entry bar (i.e. forward-looking from the
    signal).  It only needs: open, high, low, close columns.

    Returns list of trades that were closed.
    """
    open_trades = (
        db.query(PaperTrade)
        .join(Signal)
        .filter(PaperTrade.instrument == instrument, PaperTrade.status == "OPEN")
        .all()
    )

    closed = []
    for trade in open_trades:
        sig = trade.signal
        if sig is None:
            continue

        result = _resolve_single(trade, sig, df)
        if result is not None:
            exit_price, exit_reason, closed_at = result
            _close_trade(db, trade, exit_price, exit_reason, closed_at)
            closed.append(trade)

    return closed


def _resolve_single(
    trade: PaperTrade,
    signal: Signal,
    df: pd.DataFrame,
) -> Optional[tuple[float, str, datetime]]:
    """
    Scan bars after the signal to see if TP1–TP4 or SL was hit first.

    Returns (exit_price, exit_reason, closed_at) or None if still open.
    """
    direction = trade.direction
    entry_time = trade.opened_at
    # Filter to bars strictly after entry
    try:
        future_bars = df[df.index > pd.Timestamp(entry_time, tz="UTC")]
    except Exception:
        future_bars = df[df.index > pd.Timestamp(entry_time)]

    if future_bars.empty:
        return None

    # Grab TP/SL levels from the signal
    sl = signal.sl_price
    tp1 = signal.tp1_price
    tp2 = signal.tp2_price or tp1
    tp3 = signal.tp3_price or tp2
    tp4 = signal.tp4_price or tp3

    tp1_hit = False
    tp2_hit = False
    tp3_hit = False

    for bar_idx, (ts, row) in enumerate(future_bars.iterrows()):
        bar_high = row["high"]
        bar_low = row["low"]

        if direction == "LONG":
            hit_sl = bar_low <= sl
            hit_tp1 = bar_high >= tp1
            hit_tp2 = bar_high >= tp2
            hit_tp3 = bar_high >= tp3
            hit_tp4 = bar_high >= tp4
        else:
            hit_sl = bar_high >= sl
            hit_tp1 = bar_low <= tp1
            hit_tp2 = bar_low <= tp2
            hit_tp3 = bar_low <= tp3
            hit_tp4 = bar_low <= tp4

        # Progressive TP tracking (mirrors Pine Script P tracker)
        if not tp1_hit:
            if hit_sl and not hit_tp1:
                return (sl, "SL", _ts_to_dt(ts))
            if hit_tp1 and not hit_sl:
                tp1_hit = True
                # Possible TP1 exit or continue
            if hit_tp1 and hit_sl:
                # Both on same bar — use open to adjudicate
                if direction == "LONG":
                    win = row["open"] >= (entry - (sl - entry) * 0.3)
                else:
                    win = row["open"] <= (entry + (entry - sl) * 0.3)
                if win:
                    tp1_hit = True
                else:
                    return (sl, "SL", _ts_to_dt(ts))
        elif tp1_hit and not tp2_hit:
            if hit_tp2:
                tp2_hit = True
            if hit_sl:  # after TP1 → treat as BE
                return (tp1, "TP1", _ts_to_dt(ts))
        elif tp2_hit and not tp3_hit:
            if hit_tp3:
                tp3_hit = True
            if hit_sl:
                return (tp2, "TP2", _ts_to_dt(ts))
        elif tp3_hit:
            if hit_tp4:
                return (tp4, "TP4", _ts_to_dt(ts))
            if hit_sl:
                return (tp3, "TP3", _ts_to_dt(ts))

        # Time-stop
        if bar_idx + 1 >= _MAX_BARS:
            if tp3_hit:
                return (tp3, "TP3", _ts_to_dt(ts))
            if tp2_hit:
                return (tp2, "TP2", _ts_to_dt(ts))
            if tp1_hit:
                return (tp1, "TP1", _ts_to_dt(ts))
            return (row["close"], "EXPIRED", _ts_to_dt(ts))

    # If TP1 was hit but subsequent TPs not yet reached, return TP1
    if tp3_hit:
        return None  # still progressing
    if tp2_hit:
        return None
    if tp1_hit:
        return None

    return None


def _close_trade(
    db: Session,
    trade: PaperTrade,
    exit_price: float,
    exit_reason: str,
    closed_at: datetime,
) -> None:
    point_value = _POINT_VALUE.get(trade.instrument, 10.0)

    if trade.direction == "LONG":
        pnl_pts = exit_price - trade.entry_price
    else:
        pnl_pts = trade.entry_price - exit_price

    pnl_usd = pnl_pts * point_value * trade.contracts

    trade.exit_price = round(exit_price, 2)
    trade.exit_reason = exit_reason
    trade.pnl_points = round(pnl_pts, 2)
    trade.pnl_dollars = round(pnl_usd, 2)
    trade.closed_at = closed_at
    trade.status = "CLOSED"

    db.commit()
    logger.info(
        "Closed paper trade #%d  %s → %s  PnL: %.2f pts / $%.2f",
        trade.id, trade.instrument, exit_reason, pnl_pts, pnl_usd,
    )


def _ts_to_dt(ts) -> datetime:
    if hasattr(ts, "to_pydatetime"):
        return ts.to_pydatetime()
    if isinstance(ts, datetime):
        return ts
    return datetime.utcfromtimestamp(float(ts))


def compute_performance_stats(db: Session, instrument: Optional[str] = None) -> dict:
    """
    Calculate win rate, TP hit rates, and profit factor from all closed trades.
    Returns a dict suitable for the /performance endpoint.
    """
    query = db.query(PaperTrade).filter(PaperTrade.status == "CLOSED")
    if instrument:
        query = query.filter(PaperTrade.instrument == instrument)

    trades = query.all()

    if not trades:
        return _empty_stats(instrument)

    total = len(trades)
    wins = [t for t in trades if t.is_win]
    losses = [t for t in trades if not t.is_win]

    win_rate = len(wins) / total * 100 if total > 0 else 0.0

    tp1_hits = sum(1 for t in trades if t.exit_reason == "TP1")
    tp2_hits = sum(1 for t in trades if t.exit_reason == "TP2")
    tp3_hits = sum(1 for t in trades if t.exit_reason == "TP3")
    tp4_hits = sum(1 for t in trades if t.exit_reason == "TP4")

    avg_win_pts = sum(t.pnl_points for t in wins if t.pnl_points) / len(wins) if wins else 0.0
    avg_loss_pts = sum(abs(t.pnl_points) for t in losses if t.pnl_points) / len(losses) if losses else 0.0

    total_profit = sum(t.pnl_dollars for t in wins if t.pnl_dollars) or 0.0
    total_loss = abs(sum(t.pnl_dollars for t in losses if t.pnl_dollars)) or 0.0
    profit_factor = total_profit / total_loss if total_loss > 0 else None

    total_pnl = sum(t.pnl_dollars for t in trades if t.pnl_dollars is not None)

    # Breakdown by setup type
    from collections import defaultdict
    setup_stats: dict = defaultdict(lambda: {"wins": 0, "total": 0})
    for t in trades:
        sig = t.signal
        if sig:
            key = sig.setup_type or "UNKNOWN"
            setup_stats[key]["total"] += 1
            if t.is_win:
                setup_stats[key]["wins"] += 1

    setup_win_rates = {
        k: round(v["wins"] / v["total"] * 100, 1)
        for k, v in setup_stats.items()
        if v["total"] >= 3
    }
    best_setup = max(setup_win_rates, key=setup_win_rates.get) if setup_win_rates else None
    worst_setup = min(setup_win_rates, key=setup_win_rates.get) if setup_win_rates else None

    return {
        "instrument": instrument or "ALL",
        "total_trades": total,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(win_rate, 1),
        "tp1_hits": tp1_hits,
        "tp2_hits": tp2_hits,
        "tp3_hits": tp3_hits,
        "tp4_hits": tp4_hits,
        "avg_win_pts": round(avg_win_pts, 2),
        "avg_loss_pts": round(avg_loss_pts, 2),
        "profit_factor": round(profit_factor, 2) if profit_factor else None,
        "total_pnl_dollars": round(total_pnl, 2),
        "setup_win_rates": setup_win_rates,
        "best_setup": best_setup,
        "worst_setup": worst_setup,
    }


def _empty_stats(instrument: Optional[str]) -> dict:
    return {
        "instrument": instrument or "ALL",
        "total_trades": 0,
        "wins": 0,
        "losses": 0,
        "win_rate": 0.0,
        "tp1_hits": 0,
        "tp2_hits": 0,
        "tp3_hits": 0,
        "tp4_hits": 0,
        "avg_win_pts": 0.0,
        "avg_loss_pts": 0.0,
        "profit_factor": None,
        "total_pnl_dollars": 0.0,
        "setup_win_rates": {},
        "best_setup": None,
        "worst_setup": None,
    }
