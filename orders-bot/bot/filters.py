from aiogram.filters import Filter
from aiogram.types import Message, TelegramObject
from aiogram.types import User as TgUser

from bot.config import Settings


class IsAdmin(Filter):
    async def __call__(
        self, event: TelegramObject, settings: Settings, event_from_user: TgUser | None = None
    ) -> bool:
        return event_from_user is not None and event_from_user.id == settings.admin_id


class InAdminGroup(Filter):
    async def __call__(self, message: Message, settings: Settings) -> bool:
        return message.chat.id == settings.admin_group_id
