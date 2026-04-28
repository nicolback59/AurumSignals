"""
TradingView webhook receiver.

TradingView sends a POST request when an alertcondition fires.
The alert message must be configured as JSON in TradingView's alert dialog.

Required JSON fields:
    instrument  — "MGC" or "MNQ"
    direction   — "LONG" or "SHORT"
    entry       — float (current close price)
    sl          — float (stop loss price)
    tp1         — float
    grade       — "A+" | "A" | "B+"
    score       — number
    setup       — "PB-EMA" | "VWAP" | "MOM" | "SWEEP" | "OTE_PULLBACK" | ...

Optional:
    secret      — must match WEBHOOK_SECRET env var if set
    tp2, tp3, tp4, gates

Example TradingView alert message (paste into TradingView alert dialog):
{
  "secret": "YOUR_SECRET_HERE",
  "instrument": "MGC",
  "direction": "LONG",
  "entry": {{close}},
  "sl": {{plot_0}},
  "tp1": {{plot_1}},
  "tp2": {{plot_2}},
  "tp3": {{plot_3}},
  "tp4": {{plot_4}},
  "grade": "A",
  "score": 80,
  "setup": "PB-EMA",
  "time": "{{timenow}}"
}
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Signal
from ..services.alerts import dispatch_signal_alert
from ..services.paper_trading import open_paper_trade

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhook", tags=["Webhook"])


# ── Pydantic schema ───────────────────────────────────────────────────────────

class TVAlertPayload(BaseModel):
    # Auth
    secret: Optional[str] = None

    # Signal identity
    instrument: str            # MGC | MNQ
    direction: str             # LONG | SHORT
    grade: Optional[str] = None
    score: Optional[float] = None
    setup: Optional[str] = None

    # Prices
    entry: float
    sl: float
    tp1: float
    tp2: Optional[float] = None
    tp3: Optional[float] = None
    tp4: Optional[float] = None

    # Optional metadata
    time: Optional[str] = None   # TradingView {{timenow}}
    gates: Optional[dict] = None

    @field_validator("instrument")
    @classmethod
    def validate_instrument(cls, v: str) -> str:
        v = v.upper().strip()
        if v not in ("MGC", "MNQ"):
            raise ValueError("instrument must be MGC or MNQ")
        return v

    @field_validator("direction")
    @classmethod
    def validate_direction(cls, v: str) -> str:
        v = v.upper().strip()
        if v not in ("LONG", "SHORT"):
            raise ValueError("direction must be LONG or SHORT")
        return v


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/tradingview")
async def receive_tradingview_alert(
    payload: TVAlertPayload,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Receive a signal alert from TradingView, store it, open a paper trade,
    and fire configured alerts (Discord, email, Slack).
    """
    # ── Authentication ───────────────────────────────────────────────────────
    if settings.webhook_secret:
        if payload.secret != settings.webhook_secret:
            logger.warning(
                "Webhook secret mismatch from TradingView — rejecting alert"
            )
            raise HTTPException(status_code=401, detail="Invalid webhook secret")

    # ── Determine signal time ─────────────────────────────────────────────────
    signal_time = datetime.now(timezone.utc)
    if payload.time:
        try:
            signal_time = datetime.fromisoformat(payload.time.replace("Z", "+00:00"))
        except ValueError:
            pass

    # ── Derive missing TP levels from SL/entry symmetry ───────────────────────
    sl_distance = abs(payload.entry - payload.sl)
    tp1 = payload.tp1
    tp2 = payload.tp2 or _derive_tp(payload.direction, payload.entry, sl_distance * 1.5)
    tp3 = payload.tp3 or _derive_tp(payload.direction, payload.entry, sl_distance * 2.0)
    tp4 = payload.tp4 or _derive_tp(payload.direction, payload.entry, sl_distance * 2.5)

    # ── Persist signal ────────────────────────────────────────────────────────
    import json
    signal = Signal(
        instrument=payload.instrument,
        direction=payload.direction,
        setup_type=payload.setup,
        grade=payload.grade,
        score=payload.score,
        entry_price=payload.entry,
        sl_price=payload.sl,
        tp1_price=tp1,
        tp2_price=tp2,
        tp3_price=tp3,
        tp4_price=tp4,
        gates_json=json.dumps(payload.gates) if payload.gates else None,
        signal_time=signal_time,
        source="TRADINGVIEW",
    )
    db.add(signal)
    db.commit()
    db.refresh(signal)

    logger.info(
        "Signal #%d received: %s %s @ %.2f (grade=%s score=%.0f)",
        signal.id, signal.instrument, signal.direction,
        signal.entry_price, signal.grade, signal.score or 0,
    )

    # ── Open paper trade ──────────────────────────────────────────────────────
    if settings.paper_trading_enabled:
        trade = open_paper_trade(db, signal, contracts=settings.trade_contracts)

    # ── Dispatch alerts async ─────────────────────────────────────────────────
    alert_data = {
        "instrument": signal.instrument,
        "direction": signal.direction,
        "setup_type": signal.setup_type,
        "grade": signal.grade,
        "score": signal.score,
        "entry_price": signal.entry_price,
        "sl_price": signal.sl_price,
        "tp1_price": signal.tp1_price,
        "tp2_price": signal.tp2_price,
        "tp3_price": signal.tp3_price,
        "tp4_price": signal.tp4_price,
        "signal_time": signal_time.isoformat(),
    }
    background_tasks.add_task(dispatch_signal_alert, alert_data)

    return {
        "status": "ok",
        "signal_id": signal.id,
        "paper_trade_id": trade.id if settings.paper_trading_enabled else None,
    }


def _derive_tp(direction: str, entry: float, distance: float) -> float:
    return entry + distance if direction == "LONG" else entry - distance
