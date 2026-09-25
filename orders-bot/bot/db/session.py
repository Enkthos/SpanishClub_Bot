from pathlib import Path

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def ensure_sqlite_dir(url: str) -> None:
    parsed = make_url(url)
    if parsed.get_backend_name() == "sqlite" and parsed.database not in (None, "", ":memory:"):
        Path(str(parsed.database)).parent.mkdir(parents=True, exist_ok=True)


def create_db(url: str) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    ensure_sqlite_dir(url)
    connect_args = {"timeout": 30} if url.startswith("sqlite") else {}
    engine = create_async_engine(url, connect_args=connect_args)
    return engine, async_sessionmaker(engine, expire_on_commit=False)
