"""Темы в группе исполнителя: одна на заказ (с карточкой) и одна «поддержка» на клиента.

Если тему удалили вручную — она пересоздаётся при следующей отправке.
"""

import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import TypeVar

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from sqlalchemy.ext.asyncio import AsyncSession

from bot.config import Settings
from bot.db import repo
from bot.db.models import Order, User
from bot.keyboards import inline
from bot.services.clients import load_terms
from bot.services.notify import is_not_modified
from bot.services.order_flow import status_emoji
from bot.services.pricing import get_work_type
from bot.utils import today
from bot.views import admin_card, support_header, truncate

logger = logging.getLogger(__name__)
T = TypeVar("T")

TOPIC_NAME_MAX = 128


def _thread_missing(error: TelegramBadRequest) -> bool:
    msg = error.message.lower()
    return "thread not found" in msg or "topic_deleted" in msg or "topic_id_invalid" in msg


def order_topic_name(order: Order, user: User) -> str:
    wt = get_work_type(order.work_type)
    name = f"{status_emoji(order.status)} #{order.id} · {wt.title} · {user.full_name}"
    return truncate(name, TOPIC_NAME_MAX)


async def _create_topic(bot: Bot, settings: Settings, name: str) -> int | None:
    try:
        topic = await bot.create_forum_topic(settings.admin_group_id, name=name)
    except TelegramAPIError:
        logger.exception("Cannot create forum topic — check ADMIN_GROUP_ID and bot rights")
        return None
    return topic.message_thread_id


async def call_in_order_thread(
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
    order_id: int,
    fn: Callable[[int], Awaitable[T]],
    *,
    repost_card: bool = True,
) -> T | None:
    """Выполнить fn(thread_id) в теме заказа; тему создать/пересоздать при необходимости."""
    recreated = False
    for attempt in (1, 2):
        order = await repo.get_order(session, order_id)
        if order is None:
            return None
        thread_id = order.thread_id
        if thread_id is None:
            user = await repo.get_user(session, order.user_id)
            if user is None:
                return None
            thread_id = await _create_topic(bot, settings, order_topic_name(order, user))
            if thread_id is None:
                return None
            await repo.set_order_thread(session, order_id, thread_id)
            recreated = True
            if repost_card:
                await refresh_card(bot, session, settings, order_id)
        try:
            return await fn(thread_id)
        except TelegramBadRequest as e:
            if attempt == 1 and _thread_missing(e):
                logger.warning("Topic of order %s is gone, recreating", order_id)
                await repo.set_order_thread(session, order_id, None)
                continue
            raise
    if recreated:
        logger.warning("Order %s: topic recreated but call still failed", order_id)
    return None


async def call_in_support_thread(
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
    user_id: int,
    fn: Callable[[int], Awaitable[T]],
) -> T | None:
    for attempt in (1, 2):
        user = await repo.get_user(session, user_id)
        if user is None:
            return None
        thread_id = user.support_thread_id
        if thread_id is None:
            name = truncate(f"💬 {user.full_name} · поддержка", TOPIC_NAME_MAX)
            thread_id = await _create_topic(bot, settings, name)
            if thread_id is None:
                return None
            await repo.set_support_thread(session, user_id, thread_id)
            try:
                await bot.send_message(
                    settings.admin_group_id, support_header(user), message_thread_id=thread_id
                )
            except TelegramAPIError:
                logger.exception("Cannot post support header")
        try:
            return await fn(thread_id)
        except TelegramBadRequest as e:
            if attempt == 1 and _thread_missing(e):
                await repo.set_support_thread(session, user_id, None)
                continue
            raise
    return None


async def post_to_order(
    bot: Bot, session: AsyncSession, settings: Settings, order_id: int, text: str
) -> None:
    """Служебное сообщение в тему заказа. Ошибки не пробрасываются — это уведомление."""

    async def send(thread_id: int) -> object:
        return await bot.send_message(settings.admin_group_id, text, message_thread_id=thread_id)

    try:
        await call_in_order_thread(bot, session, settings, order_id, send)
    except TelegramAPIError:
        logger.exception("Cannot post to order %s topic", order_id)


async def refresh_card(bot: Bot, session: AsyncSession, settings: Settings, order_id: int) -> None:
    """Обновить карточку заказа (или опубликовать заново) и название темы."""
    order = await repo.get_order(session, order_id)
    user = await repo.get_user(session, order.user_id) if order else None
    if order is None or user is None:
        return
    terms = await load_terms(session, user, order.id)
    text = admin_card(order, user, terms, today(settings.timezone))
    markup = inline.admin_card(order)
    chat_id = settings.admin_group_id

    posted = False
    if order.thread_id is not None and order.card_message_id is not None:
        try:
            await bot.edit_message_text(
                text=text, chat_id=chat_id, message_id=order.card_message_id, reply_markup=markup
            )
            posted = True
        except TelegramBadRequest as e:
            if is_not_modified(e):
                posted = True
            else:
                logger.warning("Card of order %s not editable (%s), reposting", order_id, e.message)

    if not posted:

        async def send(thread_id: int) -> int:
            msg = await bot.send_message(
                chat_id, text, message_thread_id=thread_id, reply_markup=markup
            )
            return msg.message_id

        try:
            message_id = await call_in_order_thread(
                bot, session, settings, order_id, send, repost_card=False
            )
        except TelegramAPIError:
            logger.exception("Cannot post card of order %s", order_id)
            return
        if message_id is None:
            return
        await repo.set_card_message(session, order_id, message_id)
        try:
            await bot.pin_chat_message(chat_id, message_id, disable_notification=True)
        except TelegramAPIError:
            logger.info("Cannot pin card of order %s (no pin rights?)", order_id)

    order = await repo.get_order(session, order_id)
    if order is not None and order.thread_id is not None:
        # TOPIC_NOT_MODIFIED или нет прав — не критично
        with suppress(TelegramAPIError):
            await bot.edit_forum_topic(chat_id, order.thread_id, name=order_topic_name(order, user))
