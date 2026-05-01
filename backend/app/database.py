from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import settings


def _build_url(url: str) -> str:
    """Rewrite postgresql:// -> postgresql+psycopg:// so SQLAlchemy uses psycopg3."""
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1).replace(
            "postgresql://", "postgresql+psycopg://", 1
        )
    return url


_url = _build_url(settings.database_url)
connect_args = {"check_same_thread": False} if _url.startswith("sqlite") else {}

engine = create_engine(_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
