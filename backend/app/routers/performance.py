"""
Performance router — stats, trade history, optimization insights, engine state.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import PaperTrade, Signal, StrategyLog, EngineParams
from ..services.paper_trading import compute_performance_stats, get_risk_status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/performance", tags=["Performance"])


@router.get("/status")
def get_status(db: Session = Depends(get_db)):
    """Live risk dashboard: halt state, daily trade counts, ticks P&L."""
    return get_risk_status(db)


@router.get("")
def get_performance(
    instrument: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Overall win rate, TP hit rates, profit factor, setup breakdown."""
    return compute_performance_stats(db, instrument)


@router.get("/engine-state")
def engine_state(db: Session = Depends(get_db)):
    """
    Current adaptive engine parameters, version history, and the reason
    for each parameter change written by the learning loop.
    """
    rows = (
        db.query(EngineParams)
        .order_by(EngineParams.updated_at.desc())
        .limit(10)
        .all()
    )
    latest = rows[0] if rows else None

    # Describe what the current params mean in plain English
    current = {}
    if latest and latest.params_json:
        try:
            current = json.loads(latest.params_json)
        except Exception:
            pass

    description = []
    grade = current.get("min_grade", "A")
    description.append(f"Minimum signal grade: {grade}")
    if current.get("best_hours_only"):
        description.append("Active sessions: London + NY Open only")
    else:
        description.append("Active sessions: London, NY Open, Afternoon")
    if current.get("sl_pts"):
        description.append(f"Stop loss: {current['sl_pts']} pts")

    return {
        "version": latest.version if latest else 0,
        "last_updated": latest.updated_at.isoformat() if latest and latest.updated_at else None,
        "reason": latest.reason if latest else None,
        "current_params": current,
        "description": description,
        "history": [
            {
                "version": r.version,
                "reason": r.reason,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }


@router.get("/insights")
def get_insights(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Latest learning loop outputs: INSIGHT, WARNING, SUGGESTION, PARAM_UPDATE."""
    logs = (
        db.query(StrategyLog)
        .order_by(StrategyLog.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": log.id,
            "instrument": log.instrument,
            "log_type": log.log_type,
            "message": log.message,
            "data": json.loads(log.data_json) if log.data_json else None,
            "created_at": log.created_at.isoformat() if log.created_at else None,
            "applied": log.applied,
        }
        for log in logs
    ]


@router.get("/by-setup")
def performance_by_setup(
    instrument: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(PaperTrade).filter(PaperTrade.status == "CLOSED")
    if instrument:
        q = q.filter(PaperTrade.instrument == instrument.upper())
    trades = q.all()

    from collections import defaultdict
    buckets: dict = defaultdict(lambda: {"wins": 0, "losses": 0, "pnl": 0.0})
    for t in trades:
        setup = (t.signal.setup_type or "UNKNOWN") if t.signal else "UNKNOWN"
        if t.is_win:
            buckets[setup]["wins"] += 1
        else:
            buckets[setup]["losses"] += 1
        buckets[setup]["pnl"] += t.pnl_dollars or 0.0

    result = []
    for setup, v in sorted(buckets.items()):
        total = v["wins"] + v["losses"]
        result.append({
            "setup": setup, "wins": v["wins"], "losses": v["losses"],
            "total": total,
            "win_rate": round(v["wins"] / total * 100, 1) if total > 0 else 0.0,
            "pnl_dollars": round(v["pnl"], 2),
        })
    return result


@router.get("/by-session")
def performance_by_session(
    instrument: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import pytz
    ET = pytz.timezone("America/New_York")
    q = db.query(PaperTrade).filter(PaperTrade.status == "CLOSED")
    if instrument:
        q = q.filter(PaperTrade.instrument == instrument.upper())
    trades = q.all()

    from collections import defaultdict
    buckets: dict = defaultdict(lambda: {"wins": 0, "losses": 0})
    for t in trades:
        if not t.opened_at:
            continue
        et = t.opened_at.astimezone(ET) if t.opened_at.tzinfo else ET.localize(t.opened_at)
        h = et.hour
        sess = "London" if 2 <= h < 8 else "NY Open" if 8 <= h < 12 else "Afternoon" if 13 <= h < 17 else "Other"
        if t.is_win:
            buckets[sess]["wins"] += 1
        else:
            buckets[sess]["losses"] += 1

    result = []
    for sess in ["London", "NY Open", "Afternoon", "Other"]:
        v = buckets[sess]
        total = v["wins"] + v["losses"]
        result.append({
            "session": sess, "wins": v["wins"], "losses": v["losses"],
            "total": total,
            "win_rate": round(v["wins"] / total * 100, 1) if total > 0 else 0.0,
        })
    return result


@router.get("/trades")
def list_trades(
    instrument: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(PaperTrade)
    if instrument:
        q = q.filter(PaperTrade.instrument == instrument.upper())
    if status:
        q = q.filter(PaperTrade.status == status.upper())
    trades = q.order_by(PaperTrade.opened_at.desc()).limit(limit).all()
    return [_trade_to_dict(t) for t in trades]


@router.get("/equity-curve")
def equity_curve(
    instrument: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(PaperTrade).filter(PaperTrade.status == "CLOSED").order_by(PaperTrade.closed_at)
    if instrument:
        q = q.filter(PaperTrade.instrument == instrument.upper())
    trades = q.all()
    running = 0.0
    points = []
    for t in trades:
        running += t.pnl_dollars or 0.0
        points.append({
            "date": t.closed_at.isoformat() if t.closed_at else None,
            "pnl_dollars": round(running, 2),
            "exit_reason": t.exit_reason,
            "instrument": t.instrument,
        })
    return {"equity_curve": points}


def _trade_to_dict(t: PaperTrade) -> dict:
    return {
        "id": t.id, "signal_id": t.signal_id, "instrument": t.instrument,
        "direction": t.direction, "entry_price": t.entry_price,
        "exit_price": t.exit_price, "exit_reason": t.exit_reason,
        "contracts": t.contracts, "pnl_points": t.pnl_points,
        "pnl_dollars": t.pnl_dollars,
        "opened_at": t.opened_at.isoformat() if t.opened_at else None,
        "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        "status": t.status, "is_win": t.is_win,
    }
