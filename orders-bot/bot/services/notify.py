"""Отправка клиенту с обработкой блокировки бота."""

import logging
from typing import Any

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.types import InlineKeyboardMarkup, Message
from sqlalchemy.ext.asyncio import AsyncSession

from bot.db import repo

logger = logging.getLogger(__name__)


def is_not_modified(error: TelegramBadRequest) -> bool:
    return "message is not modified" in error.message.lower()


async def _mark_unreachable(session: AsyncSession, user_id: int, error: Exception) -> None:
    logger.info("User %s unreachable: %s", user_id, error)
    await repo.set_blocked(session, user_id)


async def send_to_user(
    bot: Bot, session: AsyncSession, user_id: int, text: str, **kwargs: Any
) -> Message | None:
    try:
        return await bot.send_message(user_id, text, **kwargs)
    except TelegramForbiddenError as e:
        await _mark_unreachable(session, user_id, e)
    except TelegramBadRequest as e:
        if "chat not found" not in e.message.lower():
            raise
        await _mark_unreachable(session, user_id, e)
    return None


async def copy_to_user(
    bot: Bot, session: AsyncSession, user_id: int, from_chat_id: int, message_id: int
) -> bool:
    try:
        await bot.copy_message(user_id, from_chat_id, message_id)
    except TelegramForbiddenError as e:
        await _mark_unreachable(session, user_id, e)
        return False
    except TelegramBadRequest as e:
        if "chat not found" not in e.message.lower():
            raise
        await _mark_unreachable(session, user_id, e)
        return False
    return True


async def edit_text(
    message: Message, text: str, reply_markup: InlineKeyboardMarkup | None = None
) -> None:
    """Редактирование с игнорированием «message is not modified»."""
    try:
        await message.edit_text(text, reply_markup=reply_markup)
    except TelegramBadRequest as e:
        if not is_not_modified(e):
            raise
