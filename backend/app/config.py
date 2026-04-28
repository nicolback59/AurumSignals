from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # Database — SQLite by default; set DATABASE_URL on Render for PostgreSQL
    database_url: str = "sqlite:///./signals.db"

    # Webhook authentication — TradingView includes this in the alert JSON body
    webhook_secret: Optional[str] = None

    # Alert destinations (all optional — configure what you have)
    discord_webhook_url: Optional[str] = None
    slack_webhook_url: Optional[str] = None
    sendgrid_api_key: Optional[str] = None
    alert_email_to: Optional[str] = None
    alert_email_from: str = "alerts@nqsignalpro.com"

    # CORS — set to your Squarespace domain in production, e.g. "https://yoursite.squarespace.com"
    cors_origins: str = "*"

    # Behaviour
    log_level: str = "INFO"
    paper_trading_enabled: bool = True
    max_open_trades_per_instrument: int = 1  # avoid stacking multiple open trades
    trade_contracts: int = 1

    # Scheduler (minutes between engine scans when running Python engine)
    scan_interval_minutes: int = 5

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
