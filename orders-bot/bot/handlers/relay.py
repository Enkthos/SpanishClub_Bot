"""Переписка клиент ⇄ исполнитель через темы группы. Роутер подключается последним."""

import logging

from aiogram import Bot, F, Router
from aiogram.enums import ChatType, ContentType
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import StateFilter
from aiogram.types import Message, MessageId
from sqlalchemy.ext.asyncio import AsyncSession

from bot import texts
from bot.config import Settings
from bot.db import repo
from bot.db.models import User
from bot.filters import InAdminGroup, IsAdmin
from bot.keyboards import inline
from bot.keyboards.reply import main_menu
from bot.services.notify import copy_to_user
from bot.services.order_flow import TERMINAL
from bot.services.topics import call_in_order_thread, call_in_support_thread, refresh_card

logger = logging.getLogger(__name__)
router = Router(name="relay")

RELAYABLE = frozenset(
    {
        ContentType.TEXT,
        ContentType.PHOTO,
        ContentType.DOCUMENT,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.VOICE,
        ContentType.VIDEO_NOTE,
        ContentType.STICKER,
        ContentType.ANIMATION,
        ContentType.LOCATION,
        ContentType.CONTACT,
    }
)


def _is_command(message: Message) -> bool:
    return bool(message.text and message.text.startswith("/"))


@router.message(F.chat.type == ChatType.PRIVATE, StateFilter(None))
async def client_to_admin(
    message: Message, bot: Bot, session: AsyncSession, settings: Settings, db_user: User
) -> None:
    if db_user.id == settings.admin_id:
        await message.answer("Вы исполнитель — отвечайте клиентам в темах группы.")
        return
    if _is_command(message):
        await message.answer(texts.UNKNOWN_COMMAND, reply_markup=main_menu())
        return
    if message.content_type not in RELAYABLE:
        await message.answer(texts.NOT_RELAYABLE)
        return

    async def copy(thread_id: int) -> MessageId:
        return await message.copy_to(settings.admin_group_id, message_thread_id=thread_id)

    order = (
        await repo.get_order(session, db_user.active_order_id) if db_user.active_order_id else None
    )
    try:
        if order is not None and order.user_id == db_user.id and order.status not in TERMINAL:
            result = await call_in_order_thread(bot, session, settings, order.id, copy)
        else:
            result = await call_in_support_thread(bot, session, settings, db_user.id, copy)
    except TelegramAPIError:
        logger.exception("Relay client -> admin failed (user %s)", db_user.id)
        result = None
    if result is None:
        await message.answer(texts.RELAY_FAILED)


@router.message(InAdminGroup(), IsAdmin(), F.is_topic_message, StateFilter(None))
async def admin_to_client(
    message: Message, bot: Bot, session: AsyncSession, settings: Settings
) -> None:
    if _is_command(message) or message.content_type not in RELAYABLE:
        return
    thread_id = message.message_thread_id
    if thread_id is None:
        return

    order = await repo.get_order_by_thread(session, thread_id)
    if order is not None:
        user_id = order.user_id
        # Защита: готовый файл не должен уйти до полной оплаты без подтверждения
        if message.document and not order.is_fully_paid and order.status not in TERMINAL:
            await message.reply(
                texts.RELAY_FILE_UNPAID,
                reply_markup=inline.relay_file_confirm(order.id, message.message_id),
            )
            return
    else:
        support_user = await repo.get_user_by_support_thread(session, thread_id)
        if support_user is None:
            return  # посторонняя тема
        user_id = support_user.id

    if not await copy_to_user(bot, session, user_id, message.chat.id, message.message_id):
        await message.reply(texts.ADMIN_CLIENT_BLOCKED)
        if order is not None:
            await refresh_card(bot, session, settings, order.id)
        return
    # Ответ клиента уйдёт туда, откуда написал исполнитель
    active = order.id if order is not None and order.status not in TERMINAL else None
    await repo.set_active_order(session, user_id, active)
