import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError
from aiogram.fsm.storage.base import BaseStorage
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.fsm.storage.redis import RedisStorage
from aiogram.fsm.strategy import FSMStrategy
from aiogram.types import BotCommand, BotCommandScopeAllPrivateChats
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bot.config import Settings, get_settings
from bot.db.session import create_db
from bot.handlers import build_root_router, errors
from bot.middlewares import (
    DbSessionMiddleware,
    RetryAfterMiddleware,
    ThrottlingMiddleware,
    UserMiddleware,
)

logger = logging.getLogger("bot")

COMMANDS = [
    BotCommand(command="start", description="Главное меню"),
    BotCommand(command="new", description="Новый заказ"),
    BotCommand(command="orders", description="Мои заказы"),
    BotCommand(command="invite", description="Пригласить друга"),
    BotCommand(command="help", description="Как это работает"),
    BotCommand(command="cancel", description="Отменить действие"),
]


def build_dispatcher(
    settings: Settings, sessionmaker: async_sessionmaker[AsyncSession], storage: BaseStorage
) -> Dispatcher:
    # USER_IN_TOPIC: у ввода цены в разных темах группы — независимые состояния
    dp = Dispatcher(storage=storage, fsm_strategy=FSMStrategy.USER_IN_TOPIC, settings=settings)
    dp.update.outer_middleware(DbSessionMiddleware(sessionmaker))
    dp.update.outer_middleware(UserMiddleware())
    dp.message.outer_middleware(ThrottlingMiddleware())
    dp.errors.register(errors.on_error)
    dp.include_router(build_root_router())
    return dp


async def check_admin_group(bot: Bot, settings: Settings) -> None:
    try:
        chat = await bot.get_chat(settings.admin_group_id)
    except TelegramAPIError as e:
        logger.error(
            "ADMIN_GROUP_ID=%s недоступна (%s). Добавьте бота в группу администратором "
            "и узнайте ID командой /id в группе.",
            settings.admin_group_id,
            e.message,
        )
        return
    if not chat.is_forum:
        logger.error(
            "В группе «%s» не включены темы — включите их в настройках группы.", chat.title
        )


async def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    engine, sessionmaker = create_db(settings.db_url)
    storage: BaseStorage = (
        RedisStorage.from_url(settings.redis_url) if settings.redis_url else MemoryStorage()
    )
    bot = Bot(
        settings.bot_token.get_secret_value(),
        default=DefaultBotProperties(parse_mode=ParseMode.HTML, link_preview_is_disabled=True),
    )
    bot.session.middleware(RetryAfterMiddleware())
    dp = build_dispatcher(settings, sessionmaker, storage)

    try:
        await bot.set_my_commands(COMMANDS, scope=BotCommandScopeAllPrivateChats())
        await check_admin_group(bot, settings)
        await bot.delete_webhook()
        logger.info("Bot started (storage: %s)", type(storage).__name__)
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        await storage.close()
        await bot.session.close()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
