"""Database engine, session factory and schema bootstrap.

Jupiter runs on SQLite by default - one file, no server, nothing to operate.
It also runs on PostgreSQL, which is what you want once the server is hosted
somewhere with an ephemeral disk (a container, a PaaS dyno) where a local file
would not survive a restart.

The engine setup is dialect-aware because the two need genuinely different
handling: SQLite wants ``check_same_thread=False`` and WAL mode, and Postgres
wants neither - issuing a ``PRAGMA`` against it is a syntax error.
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import OperationalError, ProgrammingError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from .dotenv import load_dotenv
from .models import Base

DEFAULT_DB_DIR = Path.home() / ".jupiter"
DEFAULT_DB_NAME = "jupiter.db"

# Checked in order. DATABASE_URL is the de-facto standard most hosts inject.
URL_VARS = ("JUPITER_DB", "DATABASE_URL")


def database_url() -> str:
    """Resolve the database URL from the environment, or the default file.

    A value containing ``://`` is taken as a full URL; anything else is treated
    as a SQLite file path.
    """
    load_dotenv()

    configured = None
    for name in URL_VARS:
        value = (os.environ.get(name) or "").strip()
        if value:
            configured = value
            break

    if not configured:
        DEFAULT_DB_DIR.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{DEFAULT_DB_DIR / DEFAULT_DB_NAME}"

    if "://" not in configured:
        path = Path(configured).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{path}"

    return normalize_url(configured)


def normalize_url(url: str) -> str:
    """Pin the DBAPI driver so the URL does not depend on what is installed.

    ``postgresql://`` defaults to psycopg2 in SQLAlchemy; Jupiter ships
    psycopg (v3), so say so explicitly. ``postgres://`` - still handed out by
    some providers - is not a scheme SQLAlchemy recognises at all.
    """
    for prefix in ("postgresql+", "sqlite+", "mysql+"):
        if url.startswith(prefix):
            return url
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def _engine_kwargs(url: str) -> dict:
    """Per-dialect engine options."""
    backend = make_url(url).get_backend_name()

    if backend == "sqlite":
        return {
            # uvicorn serves requests from a worker thread pool, so the
            # connection must not be pinned to the thread that created it.
            "connect_args": {"check_same_thread": False},
        }

    if backend == "postgresql":
        return {
            # Hosted Postgres closes idle connections; verify before handing
            # one out rather than failing the request.
            "pool_pre_ping": True,
            "pool_size": 5,
            "max_overflow": 5,
            "pool_recycle": 300,
            # Layerbase (and Neon, Supabase, pgBouncer generally) front
            # Postgres with a transaction-mode pooler, where server-side
            # prepared statements are not safe to reuse across checkouts.
            # psycopg keeps them off entirely when the threshold is None.
            "connect_args": {"prepare_threshold": None},
        }

    return {}


def is_sqlite(url: str | None = None) -> bool:
    return make_url(url or database_url()).get_backend_name() == "sqlite"


_url = database_url()
engine: Engine = create_engine(_url, future=True, **_engine_kwargs(_url))

SessionLocal = sessionmaker(bind=engine, class_=Session, expire_on_commit=False, future=True)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _connection_record):  # pragma: no cover - driver hook
    """WAL and foreign keys, for SQLite only.

    Registered against this engine and guarded by dialect, because ``PRAGMA``
    is a syntax error on every other backend.
    """
    if engine.dialect.name != "sqlite":
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def _existing_tables() -> set[str]:
    """Table names already present, via introspection that actually works.

    SQLAlchemy's ``create_all(checkfirst=True)`` asks ``pg_class``, which some
    Postgres-compatible gateways only partially emulate - Layerbase's pgsqlite
    is SQLite behind the Postgres wire protocol and under-reports there, so
    checkfirst sees nothing and the CREATE fails on the second start-up.
    ``information_schema.tables`` is answered correctly, so use that.
    """
    try:
        with engine.connect() as conn:
            if engine.dialect.name == "sqlite":
                rows = conn.execute(
                    text("SELECT name FROM sqlite_master WHERE type = 'table'"))
            else:
                rows = conn.execute(text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"))
            return {row[0] for row in rows}
    except SQLAlchemyError:
        return set()


def init_db() -> None:
    """Create any missing tables. Safe to call on every start-up."""
    existing = _existing_tables()
    missing = [
        table for name, table in Base.metadata.tables.items()
        if name not in existing
    ]
    if not missing:
        return
    try:
        Base.metadata.create_all(engine, tables=missing, checkfirst=False)
    except (ProgrammingError, OperationalError) as exc:
        # Two servers starting at once, or a gateway that under-reports what
        # exists. Either way the table is there, which is all we needed.
        if "already exists" not in str(exc).lower():
            raise


def get_session():
    """FastAPI dependency yielding a scoped ORM session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
