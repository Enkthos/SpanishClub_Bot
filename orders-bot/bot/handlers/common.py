from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.filters import Command, CommandObject, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import Message
from sqlalchemy.ext.asyncio import AsyncSession

from bot import texts, views
from bot.db import repo
from bot.db.models import User
from bot.keyboards import inline
from bot.keyboards.reply import main_menu
from bot.services.clients import referral_link
from bot.services.notify import send_to_user

router = Router(name="common")
router.message.filter(F.chat.type == ChatType.PRIVATE)

REF_PREFIX = "ref_"


@router.message(CommandStart(), StateFilter("*"))
async def cmd_start(
    message: Message,
    command: CommandObject,
    state: FSMContext,
    bot: Bot,
    session: AsyncSession,
    db_user: User,
    is_new_user: bool,
) -> None:
    await state.clear()
    invited = False
    args = command.args or ""
    # Реферала привязываем только при самом первом запуске бота
    if is_new_user and args.startswith(REF_PREFIX):
        referrer = await repo.get_user_by_ref_code(session, args.removeprefix(REF_PREFIX))
        if referrer is not None and await repo.set_referrer(session, db_user.id, referrer.id):
            invited = True
            await send_to_user(bot, session, referrer.id, texts.REFERRER_NEW_FRIEND)
    await message.answer(views.welcome(db_user, invited), reply_markup=main_menu())


@router.message(F.text == texts.BTN_HOW, StateFilter("*"))
@router.message(Command("help"), StateFilter("*"))
async def how_it_works(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer(texts.HOW_IT_WORKS, reply_markup=main_menu())


@router.message(Command("cancel"), StateFilter("*"))
async def cmd_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Действие отменено.", reply_markup=main_menu())


@router.message(F.text == texts.BTN_SUPPORT, StateFilter("*"))
async def support(
    message: Message, state: FSMContext, session: AsyncSession, db_user: User
) -> None:
    await state.clear()
    await repo.set_active_order(session, db_user.id, None)
    await message.answer(texts.SUPPORT, reply_markup=main_menu())


@router.message(F.text == texts.BTN_REFERRAL, StateFilter("*"))
@router.message(Command("invite"), StateFilter("*"))
async def referral(
    message: Message, state: FSMContext, bot: Bot, session: AsyncSession, db_user: User
) -> None:
    await state.clear()
    link = await referral_link(bot, db_user)
    qualified = await repo.count_qualified_referrals(session, db_user.id)
    invited = await repo.count_invited(session, db_user.id)
    await message.answer(
        views.referral_text(link, qualified, invited), reply_markup=inline.referral_share(link)
    )
