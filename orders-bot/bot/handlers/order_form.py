"""Анкета нового заказа: тип → тема → объём → срок → описание → файлы → подтверждение."""

import asyncio
import logging
import re
from contextlib import suppress
from datetime import date, timedelta
from html import escape

from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message
from sqlalchemy.ext.asyncio import AsyncSession

from bot import texts, views
from bot.callbacks import FormCb
from bot.config import Settings
from bot.db import repo
from bot.db.models import User
from bot.keyboards import inline
from bot.keyboards.reply import main_menu
from bot.services.pricing import WORK_TYPES, estimate, get_work_type, parse_deadline
from bot.services.topics import call_in_order_thread, refresh_card
from bot.states import OrderForm
from bot.utils import fmt_date, today, user_lock

logger = logging.getLogger(__name__)

router = Router(name="order_form")
router.message.filter(F.chat.type == ChatType.PRIVATE)
router.callback_query.filter(F.message.chat.type == ChatType.PRIVATE)

TOPIC_LEN = (3, 200)
DESCRIPTION_LEN = (10, 3000)
MAX_FILES = 10
ALBUM_SETTLE_SECONDS = 1.0


def _steps(data: dict[str, object]) -> list[State]:
    wt = WORK_TYPES.get(str(data.get("work_type", "")))
    has_volume = wt.has_volume if wt else True
    steps = [OrderForm.work_type, OrderForm.topic]
    if has_volume:
        steps.append(OrderForm.volume)
    return [*steps, OrderForm.deadline, OrderForm.description, OrderForm.files, OrderForm.confirm]


def _neighbour(data: dict[str, object], current: State, offset: int) -> State:
    steps = _steps(data)
    idx = steps.index(current) if current in steps else 0
    return steps[min(max(idx + offset, 0), len(steps) - 1)]


async def _close_prompt(bot: Bot, chat_id: int, state: FSMContext) -> None:
    """Убрать кнопки с предыдущего вопроса, чтобы в чате был один активный."""
    prompt_id = (await state.get_data()).get("prompt_id")
    if prompt_id:
        with suppress(TelegramBadRequest):
            await bot.edit_message_reply_markup(chat_id=chat_id, message_id=prompt_id)
        await state.update_data(prompt_id=None)


async def _mark_choice(callback: CallbackQuery, label: str) -> None:
    msg = callback.message
    if isinstance(msg, Message):
        with suppress(TelegramBadRequest):
            await msg.edit_text(f"{msg.html_text}\n\n<b>→ {escape(label)}</b>", reply_markup=None)


async def _ask(bot: Bot, chat: Message, state: FSMContext, step: State, settings: Settings) -> None:
    await _close_prompt(bot, chat.chat.id, state)
    data = await state.get_data()
    wt = get_work_type(str(data.get("work_type", "other")))
    now = today(settings.timezone)

    markup: InlineKeyboardMarkup
    if step == OrderForm.work_type:
        text, markup = texts.STEP_WORK_TYPE, inline.form_work_types()
    elif step == OrderForm.topic:
        text, markup = texts.STEP_TOPIC, inline.form_nav()
    elif step == OrderForm.volume and wt.unit_forms:
        text, markup = texts.STEP_VOLUME.format(unit=wt.unit_forms[2]), inline.form_volume(wt)
    elif step == OrderForm.deadline:
        example = (now + timedelta(days=7)).strftime("%d.%m")
        text, markup = texts.STEP_DEADLINE.format(example=example), inline.form_deadline()
    elif step == OrderForm.description:
        text, markup = texts.STEP_DESCRIPTION, inline.form_nav()
    elif step == OrderForm.files:
        text, markup = texts.STEP_FILES, inline.form_files(len(data.get("files", [])))
    else:
        step = OrderForm.confirm
        text, markup = views.form_summary(data, now), inline.form_confirm()

    if step != OrderForm.confirm:
        steps = _steps(data)
        header = texts.STEP_HEADER.format(n=steps.index(step) + 1, total=len(steps) - 1)
        text = header + text

    await state.set_state(step)
    sent = await chat.answer(text, reply_markup=markup)
    await state.update_data(prompt_id=sent.message_id)


async def _ask_next(
    bot: Bot, chat: Message, state: FSMContext, current: State, settings: Settings
) -> None:
    data = await state.get_data()
    await _ask(bot, chat, state, _neighbour(data, current, +1), settings)


def _cb_message(callback: CallbackQuery) -> Message | None:
    return callback.message if isinstance(callback.message, Message) else None


# ---------- старт / навигация ----------


@router.message(F.text == texts.BTN_NEW_ORDER, StateFilter("*"))
@router.message(Command("new"), StateFilter("*"))
async def start_form(message: Message, state: FSMContext, bot: Bot, settings: Settings) -> None:
    await state.clear()
    await _ask(bot, message, state, OrderForm.work_type, settings)


@router.callback_query(FormCb.filter(F.action == "cancel"), StateFilter(OrderForm))
async def cancel_form(callback: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    await _mark_choice(callback, "Отменено")
    if msg := _cb_message(callback):
        await msg.answer(texts.FORM_CANCELLED, reply_markup=main_menu())
    await callback.answer()


@router.callback_query(FormCb.filter(F.action == "back"), StateFilter(OrderForm))
async def go_back(callback: CallbackQuery, state: FSMContext, bot: Bot, settings: Settings) -> None:
    msg = _cb_message(callback)
    current_name = await state.get_state()
    data = await state.get_data()
    current = next((s for s in _steps(data) if s.state == current_name), OrderForm.work_type)
    if msg:
        await _ask(bot, msg, state, _neighbour(data, current, -1), settings)
    await callback.answer()


# ---------- тип ----------


@router.callback_query(OrderForm.work_type, FormCb.filter(F.action == "type"))
async def choose_type(
    callback: CallbackQuery, callback_data: FormCb, state: FSMContext, bot: Bot, settings: Settings
) -> None:
    wt = WORK_TYPES.get(callback_data.value)
    msg = _cb_message(callback)
    if wt is None or msg is None:
        await callback.answer(texts.STALE_BUTTON)
        return
    data = await state.get_data()
    if data.get("work_type") != wt.code:
        await state.update_data(work_type=wt.code, volume=None)
    await _mark_choice(callback, wt.label)
    await state.update_data(prompt_id=None)
    await _ask(bot, msg, state, OrderForm.topic, settings)
    await callback.answer()


# ---------- тема ----------


@router.message(OrderForm.topic, F.text)
async def enter_topic(message: Message, state: FSMContext, bot: Bot, settings: Settings) -> None:
    topic = (message.text or "").strip()
    if not TOPIC_LEN[0] <= len(topic) <= TOPIC_LEN[1]:
        await message.answer(texts.ERR_TOPIC.format(min=TOPIC_LEN[0], max=TOPIC_LEN[1]))
        return
    await state.update_data(topic=topic)
    await _ask_next(bot, message, state, OrderForm.topic, settings)


# ---------- объём ----------


async def _set_volume(
    raw: str, chat: Message, state: FSMContext, bot: Bot, settings: Settings
) -> bool:
    wt = get_work_type(str((await state.get_data()).get("work_type", "other")))
    value = int(match[1]) if (match := re.match(r"\s*(\d{1,4})\b", raw)) else 0
    if not 1 <= value <= wt.max_volume:
        await chat.answer(texts.ERR_VOLUME.format(max=wt.max_volume))
        return False
    await state.update_data(volume=value)
    await _ask_next(bot, chat, state, OrderForm.volume, settings)
    return True


@router.message(OrderForm.volume, F.text)
async def enter_volume(message: Message, state: FSMContext, bot: Bot, settings: Settings) -> None:
    await _set_volume(message.text or "", message, state, bot, settings)


@router.callback_query(OrderForm.volume, FormCb.filter(F.action == "vol"))
async def choose_volume(
    callback: CallbackQuery, callback_data: FormCb, state: FSMContext, bot: Bot, settings: Settings
) -> None:
    msg = _cb_message(callback)
    if msg:
        await _mark_choice(callback, callback_data.value)
        await state.update_data(prompt_id=None)
        await _set_volume(callback_data.value, msg, state, bot, settings)
    await callback.answer()


# ---------- срок ----------


async def _set_deadline(
    value: date, chat: Message, state: FSMContext, bot: Bot, settings: Settings
) -> None:
    await state.update_data(deadline=value.isoformat())
    await _ask_next(bot, chat, state, OrderForm.deadline, settings)


@router.message(OrderForm.deadline, F.text)
async def enter_deadline(message: Message, state: FSMContext, bot: Bot, settings: Settings) -> None:
    now = today(settings.timezone)
    value = parse_deadline(message.text or "", now)
    if value is None:
        example = (now + timedelta(days=7)).strftime("%d.%m")
        await message.answer(texts.ERR_DEADLINE.format(example=example))
        return
    await _set_deadline(value, message, state, bot, settings)


@router.callback_query(OrderForm.deadline, FormCb.filter(F.action == "dl"))
async def choose_deadline(
    callback: CallbackQuery, callback_data: FormCb, state: FSMContext, bot: Bot, settings: Settings
) -> None:
    msg = _cb_message(callback)
    if msg is None or not callback_data.value.isdigit():
        await callback.answer(texts.STALE_BUTTON)
        return
    value = today(settings.timezone) + timedelta(days=int(callback_data.value))
    await _mark_choice(callback, fmt_date(value))
    await state.update_data(prompt_id=None)
    await _set_deadline(value, msg, state, bot, settings)
    await callback.answer()


# ---------- описание ----------


@router.message(OrderForm.description, F.text)
async def enter_description(
    message: Message, state: FSMContext, bot: Bot, settings: Settings
) -> None:
    text = (message.text or "").strip()
    if not DESCRIPTION_LEN[0] <= len(text) <= DESCRIPTION_LEN[1]:
        await message.answer(
            texts.ERR_DESCRIPTION.format(min=DESCRIPTION_LEN[0], max=DESCRIPTION_LEN[1])
        )
        return
    await state.update_data(description=text)
    await _ask_next(bot, message, state, OrderForm.description, settings)


# ---------- файлы ----------


@router.message(OrderForm.files, F.photo | F.document)
async def add_file(message: Message, state: FSMContext, bot: Bot) -> None:
    if message.photo:
        file_id, kind = message.photo[-1].file_id, "photo"
    elif message.document:
        file_id, kind = message.document.file_id, "document"
    else:
        return
    user_id = message.from_user.id if message.from_user else message.chat.id

    # Альбом приходит несколькими апдейтами параллельно — сериализуем запись
    async with user_lock(user_id):
        data = await state.get_data()
        files = list(data.get("files", []))
        album_seen = message.media_group_id is not None and message.media_group_id in data.get(
            "albums", []
        )
        if len(files) >= MAX_FILES:
            if not album_seen:
                await message.answer(texts.FILES_LIMIT.format(limit=MAX_FILES))
            return
        files.append([file_id, kind])
        albums = list(data.get("albums", []))
        if message.media_group_id and not album_seen:
            albums.append(message.media_group_id)
        await state.update_data(files=files, albums=albums)

    if album_seen:
        return  # на альбом отвечаем один раз
    if message.media_group_id:
        await asyncio.sleep(ALBUM_SETTLE_SECONDS)

    async with user_lock(user_id):
        if await state.get_state() != OrderForm.files.state:
            return
        await _close_prompt(bot, message.chat.id, state)
        count = len((await state.get_data()).get("files", []))
        sent = await message.answer(
            texts.FILE_ADDED.format(count=count), reply_markup=inline.form_files(count)
        )
        await state.update_data(prompt_id=sent.message_id)


@router.callback_query(OrderForm.files, FormCb.filter(F.action == "files_done"))
async def files_done(
    callback: CallbackQuery, state: FSMContext, bot: Bot, settings: Settings
) -> None:
    msg = _cb_message(callback)
    if msg is None:
        await callback.answer(texts.STALE_BUTTON)
        return
    count = len((await state.get_data()).get("files", []))
    await _mark_choice(callback, f"Файлов: {count}" if count else "Без файлов")
    await state.update_data(prompt_id=None)
    await _ask(bot, msg, state, OrderForm.confirm, settings)
    await callback.answer()


# ---------- отправка ----------


async def _post_files(bot: Bot, session: AsyncSession, settings: Settings, order_id: int) -> None:
    for file in await repo.list_order_files(session, order_id):

        async def send(
            thread_id: int, file_id: str = file.file_id, kind: str = file.kind
        ) -> object:
            if kind == "photo":
                return await bot.send_photo(
                    settings.admin_group_id, file_id, message_thread_id=thread_id
                )
            return await bot.send_document(
                settings.admin_group_id, file_id, message_thread_id=thread_id
            )

        try:
            await call_in_order_thread(bot, session, settings, order_id, send)
        except TelegramAPIError:
            logger.exception("Cannot post file of order %s", order_id)


@router.callback_query(OrderForm.confirm, FormCb.filter(F.action == "submit"))
async def submit(
    callback: CallbackQuery,
    state: FSMContext,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
    db_user: User,
) -> None:
    msg = _cb_message(callback)
    async with user_lock(db_user.id):  # защита от двойного нажатия
        if msg is None or await state.get_state() != OrderForm.confirm.state:
            await callback.answer(texts.STALE_BUTTON)
            return
        data = await state.get_data()
        await state.clear()

    wt = get_work_type(data["work_type"])
    deadline = date.fromisoformat(data["deadline"])
    days_left = (deadline - today(settings.timezone)).days
    order = await repo.create_order(
        session,
        user_id=db_user.id,
        work_type=wt.code,
        topic=data["topic"],
        volume=data.get("volume"),
        deadline=deadline,
        description=data["description"],
        estimate=estimate(wt, data.get("volume"), days_left),
        files=[(fid, kind) for fid, kind in data.get("files", [])],
    )
    await repo.set_active_order(session, db_user.id, order.id)
    logger.info("Order %s created by %s", order.id, db_user.id)

    await _mark_choice(callback, "Заявка отправлена")
    await msg.answer(texts.ORDER_SUBMITTED.format(id=order.id), reply_markup=main_menu())
    await callback.answer()

    await refresh_card(bot, session, settings, order.id)
    await _post_files(bot, session, settings, order.id)

    fresh = await repo.get_order(session, order.id)
    if fresh is None or fresh.thread_id is None:
        # Группа не настроена — хотя бы сообщим исполнителю в личку
        with suppress(TelegramAPIError):
            await bot.send_message(
                settings.admin_id,
                f"⚠️ Новый заказ #{order.id}, но тему в группе создать не удалось. "
                "Проверьте ADMIN_GROUP_ID, включены ли темы и права бота.",
            )


# ---------- неверный ввод (регистрируются последними) ----------

_WRONG_INPUT: dict[State, str] = {
    OrderForm.work_type: texts.ERR_USE_BUTTONS,
    OrderForm.topic: texts.ERR_TOPIC.format(min=TOPIC_LEN[0], max=TOPIC_LEN[1]),
    OrderForm.description: texts.ERR_DESCRIPTION.format(
        min=DESCRIPTION_LEN[0], max=DESCRIPTION_LEN[1]
    ),
    OrderForm.files: texts.ERR_FILES,
    OrderForm.confirm: texts.ERR_USE_BUTTONS,
}


@router.message(StateFilter(OrderForm))
async def wrong_input(message: Message, state: FSMContext, settings: Settings) -> None:
    current = await state.get_state()
    if current == OrderForm.volume.state:
        wt = get_work_type(str((await state.get_data()).get("work_type", "other")))
        await message.answer(texts.ERR_VOLUME.format(max=wt.max_volume))
    elif current == OrderForm.deadline.state:
        example = (today(settings.timezone) + timedelta(days=7)).strftime("%d.%m")
        await message.answer(texts.ERR_DEADLINE.format(example=example))
    else:
        step = next((s for s in _WRONG_INPUT if s.state == current), OrderForm.confirm)
        await message.answer(_WRONG_INPUT[step])
