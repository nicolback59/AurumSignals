"""
Paper trading service.

Responsibilities:
  1. Check daily limits and global drawdown before opening a trade.
  2. Open a paper trade when a signal arrives.
  3. Resolve open trades against OHLCV data (TP/SL/BE/EXPIRED).
  4. Update per-instrument DailyStats after each close.
  5. Expose risk status for the dashboard API.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Optional

import pandas as pd
from sqlalchemy.orm import Session

from ..config import settings
from ..models import DailyStats, PaperTrade, Signal

logger = logging.getLogger(__name__)

# Dollar value per point and ticks per point for each instrument
_POINT_VALUE: dict[str, float] = {"MGC": 10.0, "MNQ": 2.0}
_TICKS_PER_POINT: dict[str, float] = {"MGC": 10.0, "MNQ": 4.0}  # MGC tick=0.1pt, MNQ tick=0.25pt

_MAX_BARS = 60  # time-stop in bars


# ── Daily stats helpers ───────────────────────────────────────────────────────

def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _get_or_create_daily(db: Session, instrument: str, day: date) -> DailyStats:
    row = (
        db.query(DailyStats)
        .filter(DailyStats.instrument == instrument, DailyStats.date == day)
        .first()
    )
    if row is None:
        row = DailyStats(instrument=instrument, date=day)
        db.add(row)
        db.flush()
    return row


# ── Risk checks ───────────────────────────────────────────────────────────────

def check_can_trade(db: Session, instrument: str) -> tuple[bool, str]:
    """Returns (can_trade, reason). Blocks on daily limit, consec losses, or global drawdown."""
    day = _today_utc()
    stats = _get_or_create_daily(db, instrument, day)

    if stats.is_halted:
        return False, stats.halt_reason or "HALTED"

    if stats.trades_count >= settings.daily_trade_limit:
        _halt(db, stats, f"Max {instrument} trades ({settings.daily_trade_limit}) reached today")
        return False, stats.halt_reason

    if stats.consecutive_losses >= settings.consecutive_loss_halt:
        _halt(db, stats, f"{stats.consecutive_losses} consecutive losses — paused")
        return False, stats.halt_reason

    global_ticks = _global_pnl_ticks_today(db, day)
    if global_ticks <= -abs(settings.global_drawdown_halt_ticks):
        reason = f"Global drawdown limit hit ({global_ticks:.0f}t)"
        _halt(db, stats, reason)
        for inst in ("MGC", "MNQ"):
            if inst != instrument:
                other = _get_or_create_daily(db, inst, day)
                if not other.is_halted:
                    _halt(db, other, reason)
        return False, reason

    return True, "OK"


def _global_pnl_ticks_today(db: Session, day: date) -> float:
    rows = db.query(DailyStats).filter(DailyStats.date == day).all()
    return sum(r.pnl_ticks or 0 for r in rows)


def _halt(db: Session, stats: DailyStats, reason: str) -> None:
    stats.is_halted = True
    stats.halt_reason = reason
    db.commit()
    logger.warning("HALTED %s: %s", stats.instrument, reason)


def reset_daily_stats(db: Session) -> None:
    """Called at start of each trading day (midnight UTC)."""
    day = _today_utc()
    for instrument in ("MGC", "MNQ"):
        _get_or_create_daily(db, instrument, day)
    db.commit()
    logger.info("Daily stats reset for %s", day)


# ── Open trade ────────────────────────────────────────────────────────────────

def open_paper_trade(
    db: Session,
    signal: Signal,
    contracts: int = 1,
) -> Optional[PaperTrade]:
    """Create a new OPEN paper trade. Returns None if daily limit or drawdown blocks it."""
    can_trade, reason = check_can_trade(db, signal.instrument)
    if not can_trade:
        logger.info("Trade blocked for %s: %s", signal.instrument, reason)
        return None

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

    day = _today_utc()
    stats = _get_or_create_daily(db, signal.instrument, day)
    stats.trades_count += 1
    db.commit()
    db.refresh(trade)

    logger.info(
        "Opened paper trade #%d  %s %s @ %.2f  (%d/%d today)",
        trade.id, trade.instrument, trade.direction, trade.entry_price,
        stats.trades_count, settings.daily_trade_limit,
    )
    return trade


# ── Resolve trades ────────────────────────────────────────────────────────────

def resolve_open_trades(db: Session, df: pd.DataFrame, instrument: str) -> list[PaperTrade]:
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
    direction = trade.direction
    entry_time = trade.opened_at
    try:
        future_bars = df[df.index > pd.Timestamp(entry_time, tz="UTC")]
    except Exception:
        future_bars = df[df.index > pd.Timestamp(entry_time)]

    if future_bars.empty:
        return None

    sl = signal.sl_price
    tp1 = signal.tp1_price
    tp2 = signal.tp2_price or tp1
    tp3 = signal.tp3_price or tp2
    tp4 = signal.tp4_price or tp3
    be_level = trade.entry_price  # stop moves to entry after TP1

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
            hit_be = bar_low <= be_level
        else:
            hit_sl = bar_high >= sl
            hit_tp1 = bar_low <= tp1
            hit_tp2 = bar_low <= tp2
            hit_tp3 = bar_low <= tp3
            hit_tp4 = bar_low <= tp4
            hit_be = bar_high >= be_level

        if not tp1_hit:
            if hit_sl and not hit_tp1:
                return (sl, "SL", _ts_to_dt(ts))
            if hit_tp1 and not hit_sl:
                tp1_hit = True
            elif hit_tp1 and hit_sl:
                open_px = row["open"]
                sl_dist = abs(signal.sl_price - trade.entry_price)
                win = (open_px >= be_level - sl_dist * 0.3) if direction == "LONG" else (open_px <= be_level + sl_dist * 0.3)
                if win:
                    tp1_hit = True
                else:
                    return (sl, "SL", _ts_to_dt(ts))
        elif tp1_hit and not tp2_hit:
            if hit_tp2:
                tp2_hit = True
            elif hit_be:
                return (be_level, "BE", _ts_to_dt(ts))
        elif tp2_hit and not tp3_hit:
            if hit_tp3:
                tp3_hit = True
            elif hit_be:
                return (tp2, "TP2", _ts_to_dt(ts))
        elif tp3_hit:
            if hit_tp4:
                return (tp4, "TP4", _ts_to_dt(ts))
            elif hit_be:
                return (tp3, "TP3", _ts_to_dt(ts))

        if bar_idx + 1 >= _MAX_BARS:
            if tp3_hit:
                return (tp3, "TP3", _ts_to_dt(ts))
            if tp2_hit:
                return (tp2, "TP2", _ts_to_dt(ts))
            if tp1_hit:
                return (tp1, "TP1", _ts_to_dt(ts))
            return (row["close"], "EXPIRED", _ts_to_dt(ts))

    return None


def _close_trade(
    db: Session,
    trade: PaperTrade,
    exit_price: float,
    exit_reason: str,
    closed_at: datetime,
) -> None:
    point_value = _POINT_VALUE.get(trade.instrument, 10.0)
    ticks_per_point = _TICKS_PER_POINT.get(trade.instrument, 10.0)

    pnl_pts = (exit_price - trade.entry_price) if trade.direction == "LONG" else (trade.entry_price - exit_price)
    pnl_ticks = pnl_pts * ticks_per_point
    pnl_usd = pnl_pts * point_value * trade.contracts

    trade.exit_price = round(exit_price, 2)
    trade.exit_reason = exit_reason
    trade.pnl_points = round(pnl_pts, 2)
    trade.pnl_ticks = round(pnl_ticks, 1)
    trade.pnl_dollars = round(pnl_usd, 2)
    trade.closed_at = closed_at
    trade.status = "CLOSED"
    db.commit()

    # Update daily stats
    day = closed_at.date() if hasattr(closed_at, "date") else _today_utc()
    stats = _get_or_create_daily(db, trade.instrument, day)
    stats.pnl_ticks = (stats.pnl_ticks or 0) + pnl_ticks
    stats.pnl_dollars = (stats.pnl_dollars or 0) + pnl_usd

    if trade.is_win:
        stats.wins += 1
        stats.consecutive_losses = 0
    elif trade.is_be:
        stats.be_count += 1
        stats.consecutive_losses = 0
    else:
        stats.losses += 1
        stats.consecutive_losses += 1
        if stats.consecutive_losses >= settings.consecutive_loss_halt:
            _halt(db, stats, f"{stats.consecutive_losses} consecutive losses — paused")

    db.commit()
    logger.info(
        "Closed trade #%d  %s → %s  %.1f ticks / $%.2f",
        trade.id, trade.instrument, exit_reason, pnl_ticks, pnl_usd,
    )


def _ts_to_dt(ts) -> datetime:
    if hasattr(ts, "to_pydatetime"):
        return ts.to_pydatetime()
    if isinstance(ts, datetime):
        return ts
    return datetime.utcfromtimestamp(float(ts))


# ── Risk status for dashboard ─────────────────────────────────────────────────

def get_risk_status(db: Session) -> dict:
    """Returns halt status, daily counts, and global P&L for all instruments."""
    day = _today_utc()
    global_ticks = _global_pnl_ticks_today(db, day)

    instruments = {}
    for inst in ("MGC", "MNQ"):
        stats = _get_or_create_daily(db, inst, day)
        decided = stats.wins + stats.losses
        instruments[inst] = {
            "instrument": inst,
            "is_active": not stats.is_halted,
            "halt_reason": stats.halt_reason if stats.is_halted else None,
            "trades_today": stats.trades_count,
            "trades_limit": settings.daily_trade_limit,
            "wins_today": stats.wins,
            "losses_today": stats.losses,
            "be_today": stats.be_count,
            "win_rate_today": round(stats.wins / decided * 100, 1) if decided > 0 else None,
            "pnl_ticks_today": round(stats.pnl_ticks or 0, 1),
            "pnl_dollars_today": round(stats.pnl_dollars or 0, 2),
            "consecutive_losses": stats.consecutive_losses,
        }
    db.commit()

    return {
        "date": day.isoformat(),
        "global_pnl_ticks": round(global_ticks, 1),
        "global_drawdown_limit": settings.global_drawdown_halt_ticks,
        "instruments": instruments,
    }


# ── Overall performance stats ─────────────────────────────────────────────────

def compute_performance_stats(db: Session, instrument: Optional[str] = None) -> dict:
    query = db.query(PaperTrade).filter(PaperTrade.status == "CLOSED")
    if instrument:
        query = query.filter(PaperTrade.instrument == instrument)

    trades = query.all()
    if not trades:
        return _empty_stats(instrument)

    total = len(trades)
    wins = [t for t in trades if t.is_win]
    losses = [t for t in trades if not t.is_win and not t.is_be]
    bes = [t for t in trades if t.is_be]

    decided = len(wins) + len(losses)
    win_rate = len(wins) / decided * 100 if decided > 0 else 0.0
    total_ticks = sum(t.pnl_ticks or 0 for t in trades)

    tp1_hits = sum(1 for t in trades if t.exit_reason == "TP1")
    tp2_hits = sum(1 for t in trades if t.exit_reason == "TP2")
    tp3_hits = sum(1 for t in trades if t.exit_reason == "TP3")
    tp4_hits = sum(1 for t in trades if t.exit_reason == "TP4")

    avg_win_pts = sum(t.pnl_points for t in wins if t.pnl_points) / len(wins) if wins else 0.0
    avg_loss_pts = sum(abs(t.pnl_points) for t in losses if t.pnl_points) / len(losses) if losses else 0.0

    total_profit = sum(t.pnl_dollars for t in wins if t.pnl_dollars) or 0.0
    total_loss_amt = abs(sum(t.pnl_dollars for t in losses if t.pnl_dollars)) or 0.0
    profit_factor = total_profit / total_loss_amt if total_loss_amt > 0 else None
    total_pnl = sum(t.pnl_dollars for t in trades if t.pnl_dollars is not None)

    from collections import defaultdict
    setup_stats: dict = defaultdict(lambda: {"wins": 0, "total": 0})
    for t in trades:
        if t.signal:
            key = t.signal.setup_type or "UNKNOWN"
            setup_stats[key]["total"] += 1
            if t.is_win:
                setup_stats[key]["wins"] += 1

    setup_win_rates = {
        k: round(v["wins"] / v["total"] * 100, 1)
        for k, v in setup_stats.items() if v["total"] >= 3
    }
    best_setup = max(setup_win_rates, key=setup_win_rates.get) if setup_win_rates else None
    worst_setup = min(setup_win_rates, key=setup_win_rates.get) if setup_win_rates else None

    return {
        "instrument": instrument or "ALL",
        "total_trades": total,
        "wins": len(wins),
        "losses": len(losses),
        "be_count": len(bes),
        "win_rate": round(win_rate, 1),
        "total_ticks": round(total_ticks, 1),
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
        "total_trades": 0, "wins": 0, "losses": 0, "be_count": 0,
        "win_rate": 0.0, "total_ticks": 0.0,
        "tp1_hits": 0, "tp2_hits": 0, "tp3_hits": 0, "tp4_hits": 0,
        "avg_win_pts": 0.0, "avg_loss_pts": 0.0,
        "profit_factor": None, "total_pnl_dollars": 0.0,
        "setup_win_rates": {}, "best_setup": None, "worst_setup": None,
    }
