from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

router = Router(name="service")


@router.message(Command("id"))
async def cmd_id(message: Message) -> None:
    """Помогает заполнить ADMIN_ID / ADMIN_GROUP_ID при настройке."""
    lines = [f"chat_id: <code>{message.chat.id}</code>"]
    if message.from_user:
        lines.append(f"user_id: <code>{message.from_user.id}</code>")
    if message.chat.is_forum is not None:
        lines.append(f"темы включены: {'да' if message.chat.is_forum else 'нет'}")
    await message.answer("\n".join(lines))
