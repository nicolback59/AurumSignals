from sqlalchemy import Column, Integer, Float, String, Boolean, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime

from .database import Base


class Signal(Base):
    """Every trade signal — from TradingView webhook or the Python engine."""
    __tablename__ = "signals"

    id = Column(Integer, primary_key=True, index=True)
    instrument = Column(String(10), nullable=False, index=True)  # MGC | MNQ
    direction = Column(String(10), nullable=False)               # LONG | SHORT
    setup_type = Column(String(20))   # PB-EMA | VWAP | MOM | SWEEP | OTE | STDV | OTE+STDV
    grade = Column(String(5))         # A+ | A | B+
    score = Column(Float)

    entry_price = Column(Float, nullable=False)
    sl_price = Column(Float, nullable=False)
    tp1_price = Column(Float, nullable=False)
    tp2_price = Column(Float)
    tp3_price = Column(Float)
    tp4_price = Column(Float)

    # JSON snapshot of gate/factor states at signal time
    gates_json = Column(Text)

    signal_time = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Source of signal: TRADINGVIEW (webhook) or ENGINE (Python engine)
    source = Column(String(20), default="TRADINGVIEW")

    paper_trades = relationship(
        "PaperTrade", back_populates="signal", cascade="all, delete-orphan"
    )


class PaperTrade(Base):
    """Simulated trade opened when a signal arrives. Resolved against real price data."""
    __tablename__ = "paper_trades"

    id = Column(Integer, primary_key=True, index=True)
    signal_id = Column(Integer, ForeignKey("signals.id"), nullable=False)
    instrument = Column(String(10), nullable=False, index=True)
    direction = Column(String(10), nullable=False)

    entry_price = Column(Float, nullable=False)
    exit_price = Column(Float)
    # TP1 | TP2 | TP3 | TP4 | SL | EXPIRED
    exit_reason = Column(String(20))

    contracts = Column(Integer, default=1)
    pnl_points = Column(Float)
    pnl_dollars = Column(Float)

    opened_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    closed_at = Column(DateTime)
    breakeven_moved = Column(Boolean, default=False)

    # OPEN | CLOSED
    status = Column(String(20), default="OPEN", index=True)

    signal = relationship("Signal", back_populates="paper_trades")

    @property
    def is_win(self) -> bool:
        return self.exit_reason in ("TP1", "TP2", "TP3", "TP4")


class StrategyLog(Base):
    """Optimization loop output: insights and parameter suggestions (never auto-applied)."""
    __tablename__ = "strategy_logs"

    id = Column(Integer, primary_key=True, index=True)
    instrument = Column(String(10))
    # INSIGHT | SUGGESTION | BACKTEST_RESULT | WARNING
    log_type = Column(String(30))
    message = Column(Text, nullable=False)
    data_json = Column(Text)   # supporting metrics as JSON
    created_at = Column(DateTime, default=datetime.utcnow)
    # Track whether a human acted on a suggestion
    applied = Column(Boolean, default=False)
