import asyncio
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from aiogram import BaseMiddleware, Bot
from aiogram.client.session.middlewares.base import (
    BaseRequestMiddleware,
    NextRequestMiddlewareType,
)
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramRetryAfter
from aiogram.methods import TelegramMethod
from aiogram.methods.base import Response, TelegramType
from aiogram.types import Chat, Message, TelegramObject
from aiogram.types import User as TgUser
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bot import texts
from bot.db import repo

logger = logging.getLogger(__name__)
Handler = Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]]


class DbSessionMiddleware(BaseMiddleware):
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.sessionmaker = sessionmaker

    async def __call__(self, handler: Handler, event: TelegramObject, data: dict[str, Any]) -> Any:
        async with self.sessionmaker() as session:
            data["session"] = session
            return await handler(event, data)


class UserMiddleware(BaseMiddleware):
    """В личке: создаёт/обновляет пользователя, кладёт db_user и is_new_user."""

    async def __call__(self, handler: Handler, event: TelegramObject, data: dict[str, Any]) -> Any:
        tg_user: TgUser | None = data.get("event_from_user")
        chat: Chat | None = data.get("event_chat")
        data["db_user"], data["is_new_user"] = None, False
        if tg_user and not tg_user.is_bot and chat and chat.type == ChatType.PRIVATE:
            data["db_user"], data["is_new_user"] = await repo.upsert_user(
                data["session"], tg_user.id, tg_user.username, tg_user.full_name
            )
        return await handler(event, data)


class ThrottlingMiddleware(BaseMiddleware):
    """Мягкий лимит: альбомы проходят, флуд — нет. Исполнитель не ограничивается."""

    def __init__(self, limit: int = 20, period: float = 10.0) -> None:
        self.limit, self.period = limit, period
        self._hits: dict[int, deque[float]] = {}
        self._warned_at: dict[int, float] = {}

    async def __call__(self, handler: Handler, event: TelegramObject, data: dict[str, Any]) -> Any:
        tg_user: TgUser | None = data.get("event_from_user")
        settings = data.get("settings")
        if tg_user is None or (settings is not None and tg_user.id == settings.admin_id):
            return await handler(event, data)

        now = time.monotonic()
        hits = self._hits.setdefault(tg_user.id, deque())
        while hits and now - hits[0] > self.period:
            hits.popleft()
        if len(hits) >= self.limit:
            if now - self._warned_at.get(tg_user.id, 0.0) > self.period:
                self._warned_at[tg_user.id] = now
                if isinstance(event, Message):
                    await event.answer(texts.TOO_FAST)
            return None
        hits.append(now)
        if len(self._hits) > 10_000:  # не даём словарю расти бесконечно
            self._hits = {
                uid: q for uid, q in self._hits.items() if q and now - q[-1] <= self.period
            }
            self._warned_at.clear()
        return await handler(event, data)


class RetryAfterMiddleware(BaseRequestMiddleware):
    """Повтор запроса при флуд-лимите Telegram (429)."""

    def __init__(self, attempts: int = 3) -> None:
        self.attempts = attempts

    async def __call__(
        self,
        make_request: NextRequestMiddlewareType[TelegramType],
        bot: Bot,
        method: TelegramMethod[TelegramType],
    ) -> Response[TelegramType]:
        for attempt in range(1, self.attempts + 1):
            try:
                return await make_request(bot, method)
            except TelegramRetryAfter as e:
                if attempt == self.attempts:
                    raise
                logger.warning(
                    "Flood limit on %s, retry in %ss", type(method).__name__, e.retry_after
                )
                await asyncio.sleep(e.retry_after + 1)
        raise AssertionError("unreachable")
