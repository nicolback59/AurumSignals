"""
Signals router — read-only endpoints for viewing stored signals.
Used by the Squarespace widgets to display live signal data.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Signal

router = APIRouter(prefix="/signals", tags=["Signals"])


@router.get("")
def list_signals(
    instrument: Optional[str] = Query(None, description="MGC or MNQ"),
    direction: Optional[str] = Query(None, description="LONG or SHORT"),
    grade: Optional[str] = Query(None, description="A+ or A"),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Return recent signals ordered newest-first."""
    q = db.query(Signal)
    if instrument:
        q = q.filter(Signal.instrument == instrument.upper())
    if direction:
        q = q.filter(Signal.direction == direction.upper())
    if grade:
        q = q.filter(Signal.grade == grade)

    signals = q.order_by(Signal.signal_time.desc()).limit(limit).all()
    return [_signal_to_dict(s) for s in signals]


@router.get("/latest")
def latest_signal(
    instrument: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Return the single most recent signal (optionally filtered by instrument)."""
    q = db.query(Signal)
    if instrument:
        q = q.filter(Signal.instrument == instrument.upper())
    sig = q.order_by(Signal.signal_time.desc()).first()
    if not sig:
        return {"signal": None}
    return {"signal": _signal_to_dict(sig)}


@router.get("/today")
def today_signals(
    instrument: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Return all signals generated today (UTC day)."""
    start_of_day = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    q = db.query(Signal).filter(Signal.signal_time >= start_of_day)
    if instrument:
        q = q.filter(Signal.instrument == instrument.upper())
    signals = q.order_by(Signal.signal_time.desc()).all()
    return {
        "count": len(signals),
        "signals": [_signal_to_dict(s) for s in signals],
    }


@router.get("/{signal_id}")
def get_signal(signal_id: int, db: Session = Depends(get_db)):
    sig = db.query(Signal).filter(Signal.id == signal_id).first()
    if not sig:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Signal not found")
    # Include associated paper trade info
    trades = [
        {
            "id": t.id,
            "status": t.status,
            "exit_reason": t.exit_reason,
            "pnl_points": t.pnl_points,
            "pnl_dollars": t.pnl_dollars,
        }
        for t in sig.paper_trades
    ]
    return {**_signal_to_dict(sig), "paper_trades": trades}


def _signal_to_dict(s: Signal) -> dict:
    import json
    gates = {}
    if s.gates_json:
        try:
            gates = json.loads(s.gates_json)
        except Exception:
            pass

    return {
        "id": s.id,
        "instrument": s.instrument,
        "direction": s.direction,
        "setup_type": s.setup_type,
        "grade": s.grade,
        "score": s.score,
        "entry_price": s.entry_price,
        "sl_price": s.sl_price,
        "tp1_price": s.tp1_price,
        "tp2_price": s.tp2_price,
        "tp3_price": s.tp3_price,
        "tp4_price": s.tp4_price,
        "gates": gates,
        "signal_time": s.signal_time.isoformat() if s.signal_time else None,
        "source": s.source,
    }
