import asyncio
import weakref
from datetime import date, datetime
from zoneinfo import ZoneInfo

_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = weakref.WeakValueDictionary()


def user_lock(user_id: int) -> asyncio.Lock:
    """Per-user lock: апдейты обрабатываются конкурентно (альбомы, двойные нажатия)."""
    lock = _locks.get(user_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[user_id] = lock
    return lock


def plural(n: int, forms: tuple[str, str, str]) -> str:
    """plural(5, ("слайд", "слайда", "слайдов")) -> "слайдов"."""
    n = abs(n)
    if n % 10 == 1 and n % 100 != 11:
        return forms[0]
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return forms[1]
    return forms[2]


def today(tz: str) -> date:
    return datetime.now(ZoneInfo(tz)).date()


def fmt_date(value: date) -> str:
    return value.strftime("%d.%m.%Y")
