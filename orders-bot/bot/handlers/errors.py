import logging
from contextlib import suppress

from aiogram import Router
from aiogram.enums import ChatType
from aiogram.types import CallbackQuery, ErrorEvent

from bot import texts

logger = logging.getLogger(__name__)


async def on_error(event: ErrorEvent) -> bool:
    """Регистрируется на Dispatcher: ловит ошибки всех роутеров."""
    logger.error("Update %s failed", event.update.update_id, exc_info=event.exception)
    update = event.update
    with suppress(Exception):
        if update.callback_query:
            await update.callback_query.answer(texts.ERROR, show_alert=True)
        elif update.message and update.message.chat.type == ChatType.PRIVATE:
            await update.message.answer(texts.ERROR)
    return True


fallback_router = Router(name="fallback")


@fallback_router.callback_query()
async def stale_callback(callback: CallbackQuery) -> None:
    await callback.answer(texts.STALE_BUTTON)
