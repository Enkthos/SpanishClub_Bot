"""Действия исполнителя: цена, оплата, сдача, отмена, списки."""

import logging
from contextlib import suppress
from html import escape

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message
from sqlalchemy.ext.asyncio import AsyncSession

from bot import texts, views
from bot.callbacks import AdminOrderCb, PaymentCheckCb, PricePreviewCb, RelayFileCb
from bot.config import Settings
from bot.db import repo
from bot.db.models import PaymentKind
from bot.filters import IsAdmin
from bot.keyboards import inline
from bot.keyboards.reply import main_menu
from bot.services.clients import load_terms, on_order_done
from bot.services.money import MAX_PRICE, MIN_PRICE, fmt_rub, make_quote, parse_price
from bot.services.notify import copy_to_user, edit_text, send_to_user
from bot.services.order_flow import (
    ADMIN_CANCELLABLE,
    REPRICEABLE,
    OrderStatus,
    admin_status,
)
from bot.services.pricing import estimate_mid, get_work_type
from bot.services.topics import post_to_order, refresh_card
from bot.states import AdminPrice
from bot.views import truncate

logger = logging.getLogger(__name__)
S = OrderStatus

router = Router(name="admin")
router.message.filter(IsAdmin())
router.callback_query.filter(IsAdmin())

MESSAGE_LIMIT = 4000


def _msg(callback: CallbackQuery) -> Message | None:
    return callback.message if isinstance(callback.message, Message) else None


def topic_link(group_id: int, thread_id: int | None) -> str | None:
    if thread_id is None:
        return None
    return f"https://t.me/c/{str(group_id).removeprefix('-100')}/{thread_id}"


def _chunks(lines: list[str]) -> list[str]:
    chunks, current = [], ""
    for line in lines:
        if len(current) + len(line) + 1 > MESSAGE_LIMIT:
            chunks.append(current)
            current = ""
        current += line + "\n"
    return [*chunks, current] if current else chunks


# ---------- команды ----------


@router.message(Command("orders"))
async def cmd_orders(message: Message, session: AsyncSession, settings: Settings) -> None:
    orders = await repo.list_active_orders(session)
    if not orders:
        await message.answer("Активных заказов нет 🎉")
        return
    lines = [f"📋 <b>Активные заказы: {len(orders)}</b>", ""]
    for o in orders:
        link = topic_link(settings.admin_group_id, o.thread_id)
        title = f'<a href="{link}">#{o.id}</a>' if link else f"#{o.id}"
        wt = get_work_type(o.work_type)
        lines.append(
            f"{title} · {wt.title} · {escape(truncate(o.topic, 40))}\n    {admin_status(o.status)}"
        )
    for chunk in _chunks(lines):
        await message.answer(chunk)


@router.message(Command("stats"))
async def cmd_stats(message: Message, session: AsyncSession) -> None:
    s = await repo.get_stats(session)
    await message.answer(
        "📊 <b>Статистика</b>\n\n"
        f"Пользователей: {s['users']}\n"
        f"Заказов всего: {s['orders']}\n"
        f"В работе: {s['active']}\n"
        f"Выполнено: {s['done']}\n"
        f"Отменено: {s['cancelled']}\n"
        f"Получено оплат: <b>{fmt_rub(s['revenue'])}</b>"
    )


# ---------- цена ----------


async def _send_preview(
    target: Message, session: AsyncSession, order_id: int, price: int, *, edit: bool = False
) -> None:
    order = await repo.get_order(session, order_id)
    user = await repo.get_user(session, order.user_id) if order else None
    if order is None or user is None or order.status not in REPRICEABLE:
        await target.answer(texts.ADMIN_CANT_REPRICE)
        return
    terms = await load_terms(session, user, order.id)
    quote = make_quote(price, terms.discount_percent, terms.is_returning)
    text = views.price_preview(order, quote, terms)
    markup = inline.price_preview(order.id, price)
    if edit:
        await edit_text(target, text, markup)
    else:
        await target.answer(text, reply_markup=markup)


async def _start_price_input(
    target: Message, state: FSMContext, order_id: int, *, edit: bool
) -> None:
    await state.set_state(AdminPrice.waiting)
    await state.update_data(order_id=order_id)
    text = texts.ADMIN_PRICE_ASK.format(id=order_id)
    markup = inline.price_input_cancel(order_id)
    if edit:
        await edit_text(target, text, markup)
    else:
        await target.answer(text, reply_markup=markup)


@router.callback_query(AdminOrderCb.filter(F.action.in_({"price", "estimate"})))
async def card_price(
    callback: CallbackQuery, callback_data: AdminOrderCb, state: FSMContext, session: AsyncSession
) -> None:
    order = await repo.get_order(session, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None or order.status not in REPRICEABLE:
        await callback.answer(texts.ADMIN_CANT_REPRICE, show_alert=True)
        return
    if callback_data.action == "estimate" and order.estimate_min and order.estimate_max:
        price = estimate_mid(order.estimate_min, order.estimate_max)
        await _send_preview(msg, session, order.id, price)
    else:
        await _start_price_input(msg, state, order.id, edit=False)
    await callback.answer()


@router.message(AdminPrice.waiting, F.text)
async def enter_price(message: Message, state: FSMContext, session: AsyncSession) -> None:
    price = parse_price(message.text)
    if price is None:
        await message.answer(
            texts.ADMIN_PRICE_WRONG.format(min=fmt_rub(MIN_PRICE), max=fmt_rub(MAX_PRICE))
        )
        return
    order_id = (await state.get_data()).get("order_id")
    await state.clear()
    if order_id:
        await _send_preview(message, session, order_id, price)


@router.message(AdminPrice.waiting)
async def enter_price_wrong(message: Message) -> None:
    await message.answer(
        texts.ADMIN_PRICE_WRONG.format(min=fmt_rub(MIN_PRICE), max=fmt_rub(MAX_PRICE))
    )


@router.callback_query(PricePreviewCb.filter(F.action == "abort"))
async def preview_abort(callback: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    if msg := _msg(callback):
        await edit_text(msg, texts.ADMIN_PRICE_CANCELLED)
    await callback.answer()


@router.callback_query(PricePreviewCb.filter(F.action == "retry"))
async def preview_retry(
    callback: CallbackQuery, callback_data: PricePreviewCb, state: FSMContext
) -> None:
    if msg := _msg(callback):
        await _start_price_input(msg, state, callback_data.order_id, edit=True)
    await callback.answer()


@router.callback_query(PricePreviewCb.filter(F.action == "send"))
async def preview_send(
    callback: CallbackQuery,
    callback_data: PricePreviewCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    msg = _msg(callback)
    order = await repo.get_order(session, callback_data.order_id)
    user = await repo.get_user(session, order.user_id) if order else None
    if msg is None or order is None or user is None:
        await callback.answer(texts.NOT_FOUND, show_alert=True)
        return

    terms = await load_terms(session, user, order.id)
    quote = make_quote(callback_data.price, terms.discount_percent, terms.is_returning)
    created = await repo.create_offer(session, order.id, quote)
    if created is None:
        await callback.answer(texts.ADMIN_CANT_REPRICE, show_alert=True)
        await edit_text(msg, msg.html_text)
        return
    offer, old_offers = created
    fresh = await repo.get_order(session, order.id)
    assert fresh is not None

    sent = await send_to_user(
        bot, session, user.id, views.offer_text(fresh, offer), reply_markup=inline.offer(offer.id)
    )
    if sent is not None:
        await repo.set_offer_message(session, offer.id, sent.message_id)
        await repo.set_active_order(session, user.id, order.id)
    for old in old_offers:
        if old.client_message_id:
            with suppress(TelegramAPIError):
                await bot.edit_message_text(
                    chat_id=user.id,
                    message_id=old.client_message_id,
                    text=views.offer_text(fresh, old) + texts.OFFER_OUTDATED_MARK,
                )

    result = texts.ADMIN_PRICE_SENT if sent else texts.ADMIN_CLIENT_BLOCKED
    await edit_text(msg, f"{msg.html_text}\n\n<b>{result}</b>")
    await callback.answer()
    await refresh_card(bot, session, settings, order.id)


# ---------- отмена ----------


@router.callback_query(AdminOrderCb.filter(F.action == "cancel"))
async def card_cancel(callback: CallbackQuery, callback_data: AdminOrderCb) -> None:
    msg = _msg(callback)
    if msg:
        with suppress(TelegramBadRequest):
            await msg.edit_reply_markup(
                reply_markup=inline.admin_cancel_confirm(callback_data.order_id)
            )
    await callback.answer(texts.ADMIN_CANCEL_CONFIRM.format(id=callback_data.order_id))


@router.callback_query(AdminOrderCb.filter(F.action == "cancel_no"))
async def card_cancel_no(
    callback: CallbackQuery,
    callback_data: AdminOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    await refresh_card(bot, session, settings, callback_data.order_id)
    await callback.answer()


@router.callback_query(AdminOrderCb.filter(F.action == "cancel_yes"))
async def card_cancel_yes(
    callback: CallbackQuery,
    callback_data: AdminOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    order_id = callback_data.order_id
    order = await repo.get_order(session, order_id)
    if order is None or not await repo.cancel_order(session, order_id, ADMIN_CANCELLABLE):
        await callback.answer(texts.ADMIN_STATUS_CHANGED, show_alert=True)
    else:
        sent = await send_to_user(
            bot,
            session,
            order.user_id,
            texts.ORDER_CANCELLED_BY_ADMIN.format(id=order_id),
            reply_markup=main_menu(),
        )
        await post_to_order(
            bot,
            session,
            settings,
            order_id,
            texts.EVT_CANCELLED if sent else texts.ADMIN_CLIENT_BLOCKED,
        )
        await callback.answer()
    await refresh_card(bot, session, settings, order_id)


# ---------- работа и оплата ----------


@router.callback_query(AdminOrderCb.filter(F.action == "remainder"))
async def card_remainder(
    callback: CallbackQuery,
    callback_data: AdminOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    order_id = callback_data.order_id
    if not await repo.request_remainder(session, order_id):
        await callback.answer(texts.ADMIN_STATUS_CHANGED, show_alert=True)
        await refresh_card(bot, session, settings, order_id)
        return
    order = await repo.get_order(session, order_id)
    assert order is not None
    text = (
        texts.REMAINDER_REQUEST.format(id=order_id)
        + "\n\n"
        + views.payment_text(order, order.remainder, is_final=True, settings=settings)
    )
    sent = await send_to_user(bot, session, order.user_id, text, reply_markup=inline.pay(order_id))
    await callback.answer()
    await post_to_order(
        bot,
        session,
        settings,
        order_id,
        texts.EVT_REMAINDER_SENT if sent else texts.ADMIN_CLIENT_BLOCKED,
    )
    await refresh_card(bot, session, settings, order_id)


@router.callback_query(AdminOrderCb.filter(F.action == "deliver"))
async def card_deliver(
    callback: CallbackQuery,
    callback_data: AdminOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    order_id = callback_data.order_id
    order = await repo.get_order(session, order_id)
    if order is None or not await repo.mark_delivered(session, order_id):
        await callback.answer(texts.ADMIN_STATUS_CHANGED, show_alert=True)
        await refresh_card(bot, session, settings, order_id)
        return
    sent = await send_to_user(
        bot,
        session,
        order.user_id,
        texts.WORK_DELIVERED.format(id=order_id),
        reply_markup=inline.accept_work(order_id),
    )
    await callback.answer()
    await post_to_order(
        bot,
        session,
        settings,
        order_id,
        texts.EVT_DELIVERED if sent else texts.ADMIN_CLIENT_BLOCKED,
    )
    await refresh_card(bot, session, settings, order_id)


@router.callback_query(AdminOrderCb.filter(F.action == "close"))
async def card_close(
    callback: CallbackQuery,
    callback_data: AdminOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    order_id = callback_data.order_id
    if not await repo.transition(session, order_id, S.DONE, allowed_from={S.DELIVERED}):
        await callback.answer(texts.ADMIN_STATUS_CHANGED, show_alert=True)
        await refresh_card(bot, session, settings, order_id)
        return
    order = await repo.get_order(session, order_id)
    assert order is not None
    await on_order_done(bot, session, order)
    await send_to_user(
        bot,
        session,
        order.user_id,
        texts.ORDER_CLOSED_BY_ADMIN.format(id=order_id),
        reply_markup=main_menu(),
    )
    await callback.answer()
    await post_to_order(bot, session, settings, order_id, texts.EVT_CLOSED)
    await refresh_card(bot, session, settings, order_id)


@router.callback_query(PaymentCheckCb.filter())
async def payment_check(
    callback: CallbackQuery,
    callback_data: PaymentCheckCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    confirm = callback_data.action == "ok"
    msg = _msg(callback)
    result = await repo.resolve_payment(session, callback_data.payment_id, confirm)
    if result is None:
        await callback.answer(texts.ADMIN_STATUS_CHANGED, show_alert=True)
        if msg:
            with suppress(TelegramBadRequest):
                await msg.edit_reply_markup(reply_markup=None)
        return
    payment, order = result

    if msg:
        mark = texts.EVT_PAYMENT_OK if confirm else texts.EVT_PAYMENT_NO
        with suppress(TelegramBadRequest):
            await msg.edit_caption(caption=msg.html_text + mark, reply_markup=None)

    if confirm:
        template = (
            texts.PREPAY_CONFIRMED if payment.kind == PaymentKind.PREPAY else texts.FINAL_CONFIRMED
        )
        await send_to_user(bot, session, order.user_id, template.format(id=order.id))
    else:
        await send_to_user(
            bot,
            session,
            order.user_id,
            texts.PAYMENT_REJECTED.format(id=order.id),
            reply_markup=inline.pay(order.id),
        )
    await callback.answer()
    await refresh_card(bot, session, settings, order.id)


# ---------- файл для неоплаченного заказа ----------


@router.callback_query(RelayFileCb.filter())
async def relay_file(
    callback: CallbackQuery,
    callback_data: RelayFileCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    msg = _msg(callback)
    if msg is None:
        await callback.answer()
        return
    if callback_data.action != "send":
        await edit_text(msg, texts.RELAY_FILE_DROPPED)
        await callback.answer()
        return
    order = await repo.get_order(session, callback_data.order_id)
    if order is None:
        await callback.answer(texts.NOT_FOUND, show_alert=True)
        return
    ok = await copy_to_user(
        bot, session, order.user_id, settings.admin_group_id, callback_data.message_id
    )
    await edit_text(msg, texts.RELAY_FILE_SENT if ok else texts.ADMIN_CLIENT_BLOCKED)
    await callback.answer()
