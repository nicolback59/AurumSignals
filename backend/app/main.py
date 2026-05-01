"""
NQ Signal Pro — Autonomous Signal Engine

The system is fully self-contained:
  1. Every 5 minutes: fetch real NQ futures data via yfinance
  2. Run the Python NQ Pro v4 signal engine (4-factor model)
  3. Store any signal found, open a paper trade automatically
  4. Every 5 minutes: resolve open paper trades against real price data
  5. Daily 4 AM UTC: analyse performance, write insights, adjust parameters

No TradingView required. A webhook endpoint remains available as an optional
manual override but the engine operates completely independently.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytz
import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, SessionLocal, engine
from .models import Signal, PaperTrade, StrategyLog, EngineParams
from .routers import signals, webhook, performance

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
ET = pytz.timezone("America/New_York")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting NQ Signal Pro — Autonomous Engine …")
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables ready.")

    scheduler.add_job(_scan_market_job,         "interval", minutes=5,  id="scan_market",      replace_existing=True)
    scheduler.add_job(_resolve_paper_trades_job, "interval", minutes=5,  id="resolve_trades",   replace_existing=True)
    scheduler.add_job(_optimization_loop_job,    "cron", hour=4, minute=0, id="optimization_loop", replace_existing=True)
    scheduler.add_job(_daily_reset_job,          "cron", hour=0, minute=1, id="daily_reset",       replace_existing=True)
    scheduler.start()
    logger.info("Scheduler started — engine scans every 5 minutes during market hours.")

    yield

    scheduler.shutdown(wait=False)
    logger.info("Scheduler stopped.")


app = FastAPI(
    title="NQ Signal Pro API",
    description=(
        "Autonomous NQ/MNQ futures signal engine. Generates signals from real "
        "market data, tracks simulated trades, and learns from every outcome."
    ),
    version="2.0.0",
    lifespan=lifespan,
)

origins = [o.strip() for o in settings.cors_origins.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(webhook.router)
app.include_router(signals.router)
app.include_router(performance.router)


@app.get("/", include_in_schema=False)
def root():
    return {"service": "NQ Signal Pro", "version": "2.0.0", "mode": "autonomous", "status": "running", "docs": "/docs"}


@app.get("/health", tags=["Health"])
def health_check():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


# ── MARKET SCAN JOB ──────────────────────────────────────────────────────────────────────────────

async def _scan_market_job():
    """
    Every 5 min during market hours: fetch NQ=F data, run the signal engine,
    store any signal found, open a paper trade automatically.
    """
    try:
        now_utc = datetime.now(timezone.utc)
        now_et  = now_utc.astimezone(ET)

        # Skip weekends and off-hours (8 AM – 5 PM ET on weekdays)
        if now_et.weekday() >= 5:
            return
        if not (8 <= now_et.hour < 17):
            return

        import yfinance as yf
        from .engines.mnq_engine import MNQEngine
        from .services.paper_trading import check_can_trade, open_paper_trade

        # Load latest adaptive parameters
        db = SessionLocal()
        try:
            params_row = (
                db.query(EngineParams)
                .filter(EngineParams.instrument == "MNQ")
                .order_by(EngineParams.updated_at.desc())
                .first()
            )
            params = {}
            if params_row and params_row.params_json:
                try:
                    params = json.loads(params_row.params_json)
                except Exception:
                    params = {}
        finally:
            db.close()

        engine_instance = MNQEngine(**params)

        # Fetch 5-min and 15-min NQ futures data
        df_5m  = yf.download("NQ=F", period="5d",  interval="5m",  progress=False, auto_adjust=True)
        df_15m = yf.download("NQ=F", period="10d", interval="15m", progress=False, auto_adjust=True)

        if df_5m.empty or df_15m.empty:
            logger.warning("yfinance returned empty data for NQ=F")
            return

        def _flatten(df):
            df.columns = [
                c[0].lower() if isinstance(c, tuple) else c.lower()
                for c in df.columns
            ]
            if df.index.tzinfo is None:
                df.index = df.index.tz_localize("UTC")
            else:
                df.index = df.index.tz_convert("UTC")
            return df

        df_5m  = _flatten(df_5m)
        df_15m = _flatten(df_15m)

        sig = engine_instance.check(df_5m, df_15m)
        if not sig:
            logger.debug("Scan complete — no signal this bar")
            return

        db = SessionLocal()
        try:
            can_trade, reason = check_can_trade(db, "MNQ")
            if not can_trade:
                logger.info("Engine: %s signal found but halted — %s", sig.direction, reason)
                return

            signal_row = Signal(
                instrument=sig.instrument,
                direction=sig.direction,
                setup_type=sig.setup_type,
                grade=sig.grade,
                score=sig.score,
                entry_price=sig.entry_price,
                sl_price=sig.sl_price,
                tp1_price=sig.tp1_price,
                tp2_price=sig.tp2_price,
                tp3_price=sig.tp3_price,
                tp4_price=sig.tp4_price,
                gates_json=json.dumps(sig.factors),
                signal_time=sig.signal_time or now_utc,
                source="ENGINE",
            )
            db.add(signal_row)
            db.commit()
            db.refresh(signal_row)

            logger.info(
                "ENGINE signal #%d: %s %s | grade=%s score=%.1f @ %.2f",
                signal_row.id, sig.direction, sig.setup_type,
                sig.grade, sig.score, sig.entry_price,
            )

            if settings.paper_trading_enabled:
                open_paper_trade(db, signal_row, contracts=settings.trade_contracts)

            from .services.alerts import dispatch_signal_alert
            asyncio.create_task(dispatch_signal_alert(sig.to_dict()))

        finally:
            db.close()

    except Exception as exc:
        logger.error("Error in scan_market_job: %s", exc, exc_info=True)


# ── PAPER TRADE RESOLVER ───────────────────────────────────────────────────────────────────────

async def _resolve_paper_trades_job():
    try:
        import yfinance as yf
        from .services.paper_trading import resolve_open_trades

        db = SessionLocal()
        try:
            for instrument, ticker in [("MNQ", "NQ=F"), ("MGC", "GC=F")]:
                from .models import PaperTrade as PT
                open_count = db.query(PT).filter(PT.instrument == instrument, PT.status == "OPEN").count()
                if open_count == 0:
                    continue

                df = yf.download(ticker, period="2d", interval="5m", progress=False, auto_adjust=True)
                if df.empty:
                    continue

                df.columns = [c[0].lower() if isinstance(c, tuple) else c.lower() for c in df.columns]
                if df.index.tzinfo is None:
                    df.index = df.index.tz_localize("UTC")
                else:
                    df.index = df.index.tz_convert("UTC")

                closed = resolve_open_trades(db, df, instrument)
                if closed:
                    logger.info("Resolved %d paper trades for %s", len(closed), instrument)
        finally:
            db.close()
    except Exception as exc:
        logger.error("Error in resolve_paper_trades_job: %s", exc, exc_info=True)


# ── DAILY RESET ────────────────────────────────────────────────────────────────────────────────────

async def _daily_reset_job():
    try:
        from .services.paper_trading import reset_daily_stats
        db = SessionLocal()
        try:
            reset_daily_stats(db)
        finally:
            db.close()
    except Exception as exc:
        logger.error("Error in daily_reset_job: %s", exc, exc_info=True)


# ── LEARNING / OPTIMIZATION LOOP ─────────────────────────────────────────────────────────────────────

async def _optimization_loop_job():
    """
    Daily 4 AM UTC: analyse all closed trades, write insights to strategy_logs,
    and write a new EngineParams row if performance data warrants a parameter change.
    All changes are logged with a reason — full audit trail, never silent.
    """
    try:
        from .services.paper_trading import compute_performance_stats

        db = SessionLocal()
        try:
            for instrument in ("MNQ",):
                stats = compute_performance_stats(db, instrument)
                if stats.get("total_trades", 0) < 5:
                    continue

                for msg, log_type, data in _generate_insights(stats, instrument, db):
                    db.add(StrategyLog(
                        instrument=instrument,
                        log_type=log_type,
                        message=msg,
                        data_json=json.dumps(data),
                    ))

                _maybe_update_params(db, instrument, stats)

            db.commit()
            logger.info("Learning loop complete.")
        finally:
            db.close()
    except Exception as exc:
        logger.error("Error in optimization_loop_job: %s", exc, exc_info=True)


def _maybe_update_params(db, instrument: str, stats: dict):
    """
    Propose conservative parameter adjustments based on live performance.
    Each change creates a new versioned EngineParams row with a written reason.
    """
    current_row = (
        db.query(EngineParams)
        .filter(EngineParams.instrument == instrument)
        .order_by(EngineParams.updated_at.desc())
        .first()
    )
    current_params = {}
    current_version = 0
    if current_row:
        try:
            current_params = json.loads(current_row.params_json)
            current_version = current_row.version or 0
        except Exception:
            pass

    new_params = dict(current_params)
    changes = []
    wr    = stats.get("win_rate", 0)
    total = stats.get("total_trades", 0)

    # Strong performance: relax grade gate A+ → A
    if wr >= 68 and total >= 30 and new_params.get("min_grade") == "A+":
        new_params["min_grade"] = "A"
        changes.append(f"Relaxed min_grade A+→A (win rate {wr:.1f}% over {total} trades)")

    # Poor performance: tighten gate A → A+
    if wr < 45 and total >= 20 and new_params.get("min_grade", "A") == "A":
        new_params["min_grade"] = "A+"
        changes.append(f"Tightened min_grade A→A+ (win rate {wr:.1f}% below 45% threshold)")

    # Restrict to best hours if afternoon session consistently drags win rate
    if wr < 50 and total >= 15 and not new_params.get("best_hours_only"):
        new_params["best_hours_only"] = True
        changes.append(f"Enabled best_hours_only (filtering out afternoon session, win rate {wr:.1f}%)")

    if not changes:
        return

    db.add(EngineParams(
        instrument=instrument,
        params_json=json.dumps(new_params),
        version=current_version + 1,
        reason="; ".join(changes),
    ))
    db.add(StrategyLog(
        instrument=instrument,
        log_type="PARAM_UPDATE",
        message=f"Engine auto-adjusted (v{current_version + 1}): {'; '.join(changes)}",
        data_json=json.dumps({"old": current_params, "new": new_params, "version": current_version + 1}),
    ))
    logger.info("Engine params updated v%d: %s", current_version + 1, "; ".join(changes))


def _generate_insights(stats: dict, instrument: str, db) -> list[tuple[str, str, dict]]:
    insights = []
    wr    = stats.get("win_rate", 0)
    total = stats.get("total_trades", 0)
    pf    = stats.get("profit_factor")
    total_ticks = stats.get("total_ticks", 0)

    if wr < 45 and total >= 10:
        insights.append((
            f"{instrument}: Win rate {wr:.1f}% over {total} trades is below 45%. Engine tightening grade gate.",
            "WARNING", {"win_rate": wr, "trades": total},
        ))
    elif wr >= 65:
        insights.append((
            f"{instrument}: Strong performance — {wr:.1f}% win rate over {total} trades.",
            "INSIGHT", {"win_rate": wr, "trades": total},
        ))

    if pf is not None and pf < 1.0 and total >= 10:
        insights.append((
            f"{instrument}: Profit factor {pf:.2f} — net negative. Review TP/SL ratio.",
            "WARNING", {"profit_factor": pf},
        ))
    elif pf is not None and pf >= 2.0:
        insights.append((
            f"{instrument}: Excellent profit factor {pf:.2f}.",
            "INSIGHT", {"profit_factor": pf},
        ))

    if stats.get("best_setup"):
        best_wr = stats.get("setup_win_rates", {}).get(stats["best_setup"], 0)
        insights.append((
            f"{instrument}: Best setup is '{stats['best_setup']}' at {best_wr:.1f}% win rate. Engine is prioritising this.",
            "SUGGESTION", {"best_setup": stats["best_setup"], "best_wr": best_wr},
        ))

    if stats.get("worst_setup"):
        worst_wr = stats.get("setup_win_rates", {}).get(stats["worst_setup"], 0)
        if worst_wr < 40:
            insights.append((
                f"{instrument}: '{stats['worst_setup']}' at {worst_wr:.1f}% — underperforming. Engine raising bar for this setup.",
                "SUGGESTION", {"worst_setup": stats["worst_setup"], "worst_wr": worst_wr},
            ))

    if total_ticks < -500:
        insights.append((
            f"{instrument}: Cumulative P&L negative ({total_ticks:+.0f} ticks). Engine under review.",
            "WARNING", {"total_ticks": total_ticks},
        ))

    return insights


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
