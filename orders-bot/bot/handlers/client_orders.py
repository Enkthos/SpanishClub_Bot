"""Мои заказы, согласование цены, оплата, приёмка работы."""

import logging
from contextlib import suppress

from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message
from sqlalchemy.ext.asyncio import AsyncSession

from bot import texts, views
from bot.callbacks import ClientOrderCb, OfferCb
from bot.config import Settings
from bot.db import repo
from bot.db.models import Order, PaymentKind, PriceOffer, User
from bot.keyboards import inline
from bot.keyboards.reply import main_menu
from bot.services.clients import on_order_done
from bot.services.money import fmt_rub
from bot.services.notify import edit_text
from bot.services.order_flow import (
    AWAITING_PAYMENT,
    CLIENT_CANCELLABLE,
    TERMINAL,
    OrderStatus,
)
from bot.services.topics import call_in_order_thread, post_to_order, refresh_card
from bot.states import ClientReceipt
from bot.utils import today

logger = logging.getLogger(__name__)
S = OrderStatus

router = Router(name="client_orders")
router.message.filter(F.chat.type == ChatType.PRIVATE)
router.callback_query.filter(F.message.chat.type == ChatType.PRIVATE)


def _msg(callback: CallbackQuery) -> Message | None:
    return callback.message if isinstance(callback.message, Message) else None


async def _own_order(session: AsyncSession, callback: CallbackQuery, order_id: int) -> Order | None:
    order = await repo.get_order(session, order_id)
    if order is None or order.user_id != callback.from_user.id:
        await callback.answer(texts.NOT_FOUND, show_alert=True)
        return None
    return order


async def _drop_markup(callback: CallbackQuery) -> None:
    if msg := _msg(callback):
        with suppress(TelegramBadRequest):
            await msg.edit_reply_markup(reply_markup=None)


# ---------- список и карточка ----------


@router.message(F.text == texts.BTN_MY_ORDERS, StateFilter("*"))
@router.message(Command("orders"), StateFilter("*"))
async def my_orders(
    message: Message, state: FSMContext, session: AsyncSession, db_user: User
) -> None:
    await state.clear()
    orders = await repo.list_user_orders(session, db_user.id)
    if not orders:
        await message.answer(texts.NO_ORDERS, reply_markup=main_menu())
        return
    await message.answer(texts.MY_ORDERS_TITLE, reply_markup=inline.my_orders(orders))


@router.callback_query(ClientOrderCb.filter(F.action == "list"))
async def cb_list(callback: CallbackQuery, session: AsyncSession) -> None:
    msg = _msg(callback)
    if msg:
        orders = await repo.list_user_orders(session, callback.from_user.id)
        if orders:
            await edit_text(msg, texts.MY_ORDERS_TITLE, inline.my_orders(orders))
        else:
            await edit_text(msg, texts.NO_ORDERS)
    await callback.answer()


async def _show_card(msg: Message, session: AsyncSession, order: Order, settings: Settings) -> None:
    has_offer = await repo.get_active_offer(session, order.id) is not None
    await edit_text(
        msg,
        views.client_order_card(order, today(settings.timezone)),
        inline.client_order(order, has_offer),
    )


@router.callback_query(ClientOrderCb.filter(F.action == "view"))
async def cb_view(
    callback: CallbackQuery, callback_data: ClientOrderCb, session: AsyncSession, settings: Settings
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    if order and (msg := _msg(callback)):
        await _show_card(msg, session, order, settings)
        await callback.answer()


@router.callback_query(ClientOrderCb.filter(F.action == "chat"))
async def cb_chat(
    callback: CallbackQuery, callback_data: ClientOrderCb, session: AsyncSession
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    if order is None:
        return
    if order.status in TERMINAL:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        return
    await repo.set_active_order(session, order.user_id, order.id)
    if msg := _msg(callback):
        await msg.answer(texts.CHAT_ORDER.format(id=order.id), reply_markup=main_menu())
    await callback.answer()


# ---------- отмена ----------


@router.callback_query(ClientOrderCb.filter(F.action == "cancel"))
async def cb_cancel(
    callback: CallbackQuery, callback_data: ClientOrderCb, session: AsyncSession, settings: Settings
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None:
        return
    if order.status not in CLIENT_CANCELLABLE:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        await _show_card(msg, session, order, settings)
        return
    text = views.client_order_card(order, today(settings.timezone))
    confirm = texts.CLIENT_CANCEL_CONFIRM.format(id=order.id)
    await edit_text(msg, f"{text}\n\n{confirm}", inline.client_cancel_confirm(order.id))
    await callback.answer()


@router.callback_query(ClientOrderCb.filter(F.action == "cancel_yes"))
async def cb_cancel_yes(
    callback: CallbackQuery,
    callback_data: ClientOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None:
        return
    if not await repo.cancel_order(session, order.id, CLIENT_CANCELLABLE):
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
    else:
        await callback.answer(texts.CLIENT_CANCELLED.format(id=order.id))
        await post_to_order(bot, session, settings, order.id, texts.EVT_CLIENT_CANCELLED)
        await refresh_card(bot, session, settings, order.id)
    fresh = await repo.get_order(session, order.id)
    if fresh:
        await _show_card(msg, session, fresh, settings)


# ---------- предложение цены ----------


async def _offer_context(
    session: AsyncSession, callback: CallbackQuery, offer_id: int
) -> tuple[PriceOffer, Order] | None:
    offer = await repo.get_offer(session, offer_id)
    order = await repo.get_order(session, offer.order_id) if offer else None
    if offer is None or order is None or order.user_id != callback.from_user.id:
        await callback.answer(texts.NOT_FOUND, show_alert=True)
        return None
    if not offer.is_active or order.status != S.AWAITING_AGREEMENT:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        await _drop_markup(callback)
        return None
    return offer, order


@router.callback_query(ClientOrderCb.filter(F.action == "offer"))
async def cb_show_offer(
    callback: CallbackQuery, callback_data: ClientOrderCb, session: AsyncSession
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None:
        return
    offer = await repo.get_active_offer(session, order.id)
    if offer is None or order.status != S.AWAITING_AGREEMENT:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        return
    sent = await msg.answer(views.offer_text(order, offer), reply_markup=inline.offer(offer.id))
    await repo.set_offer_message(session, offer.id, sent.message_id)
    await callback.answer()


@router.callback_query(OfferCb.filter(F.action == "accept"))
async def offer_accept(
    callback: CallbackQuery,
    callback_data: OfferCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    ctx = await _offer_context(session, callback, callback_data.offer_id)
    msg = _msg(callback)
    if ctx is None or msg is None:
        return
    offer, _ = ctx
    order = await repo.accept_offer(session, offer.id)
    if order is None:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        await _drop_markup(callback)
        return

    await edit_text(msg, views.offer_text(order, offer) + texts.OFFER_ACCEPTED_MARK)
    await msg.answer(
        views.payment_text(order, order.prepay_amount or 0, is_final=False, settings=settings),
        reply_markup=inline.pay(order.id),
    )
    await repo.set_active_order(session, order.user_id, order.id)
    await callback.answer("Отлично! 🙌")
    await post_to_order(bot, session, settings, order.id, texts.EVT_CLIENT_ACCEPTED)
    await refresh_card(bot, session, settings, order.id)


@router.callback_query(OfferCb.filter(F.action == "talk"))
async def offer_talk(
    callback: CallbackQuery,
    callback_data: OfferCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    ctx = await _offer_context(session, callback, callback_data.offer_id)
    msg = _msg(callback)
    if ctx is None or msg is None:
        return
    _, order = ctx
    await repo.set_active_order(session, order.user_id, order.id)
    await msg.answer(texts.OFFER_TALK)
    await callback.answer()
    await post_to_order(bot, session, settings, order.id, texts.EVT_CLIENT_TALK)


@router.callback_query(OfferCb.filter(F.action.in_({"decline", "back"})))
async def offer_decline_toggle(
    callback: CallbackQuery, callback_data: OfferCb, session: AsyncSession
) -> None:
    ctx = await _offer_context(session, callback, callback_data.offer_id)
    msg = _msg(callback)
    if ctx is None or msg is None:
        return
    offer, order = ctx
    text = views.offer_text(order, offer)
    if callback_data.action == "decline":
        await edit_text(
            msg, text + texts.OFFER_DECLINE_CONFIRM, inline.offer_decline_confirm(offer.id)
        )
    else:
        await edit_text(msg, text, inline.offer(offer.id))
    await callback.answer()


@router.callback_query(OfferCb.filter(F.action == "decline_yes"))
async def offer_decline(
    callback: CallbackQuery,
    callback_data: OfferCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    ctx = await _offer_context(session, callback, callback_data.offer_id)
    msg = _msg(callback)
    if ctx is None or msg is None:
        return
    offer, _ = ctx
    order = await repo.decline_offer(session, offer.id)
    if order is None:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        await _drop_markup(callback)
        return
    await edit_text(msg, views.offer_text(order, offer) + texts.OFFER_DECLINED_MARK)
    await msg.answer(texts.CLIENT_CANCELLED.format(id=order.id), reply_markup=main_menu())
    await callback.answer()
    await post_to_order(bot, session, settings, order.id, texts.EVT_CLIENT_DECLINED)
    await refresh_card(bot, session, settings, order.id)


# ---------- оплата ----------


@router.callback_query(ClientOrderCb.filter(F.action == "pay_info"))
async def cb_pay_info(
    callback: CallbackQuery, callback_data: ClientOrderCb, session: AsyncSession, settings: Settings
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None:
        return
    if order.status not in AWAITING_PAYMENT:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        return
    is_final = order.status == S.AWAITING_FINAL_PAY
    amount = order.remainder if is_final else (order.prepay_amount or 0)
    await msg.answer(
        views.payment_text(order, amount, is_final, settings), reply_markup=inline.pay(order.id)
    )
    await callback.answer()


@router.callback_query(ClientOrderCb.filter(F.action == "paid"))
async def cb_paid(
    callback: CallbackQuery, callback_data: ClientOrderCb, state: FSMContext, session: AsyncSession
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None:
        return
    if order.status not in AWAITING_PAYMENT:
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        await _drop_markup(callback)
        return
    await state.set_state(ClientReceipt.waiting)
    await state.update_data(order_id=order.id)
    await msg.answer(
        texts.RECEIPT_ASK.format(id=order.id), reply_markup=inline.receipt_cancel(order.id)
    )
    await callback.answer()


@router.callback_query(ClientOrderCb.filter(F.action == "receipt_cancel"))
async def cb_receipt_cancel(callback: CallbackQuery, state: FSMContext) -> None:
    if await state.get_state() == ClientReceipt.waiting.state:
        await state.clear()
    if msg := _msg(callback):
        await edit_text(msg, texts.RECEIPT_CANCELLED)
    await callback.answer()


@router.message(ClientReceipt.waiting, F.photo | F.document)
async def receive_receipt(
    message: Message,
    state: FSMContext,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
    db_user: User,
) -> None:
    order_id = (await state.get_data()).get("order_id")
    await state.clear()
    order = await repo.get_order(session, order_id) if order_id else None
    if order is None or order.user_id != db_user.id:
        await message.answer(texts.STALE_BUTTON, reply_markup=main_menu())
        return

    is_photo = bool(message.photo)
    file_id = message.photo[-1].file_id if message.photo else message.document.file_id  # type: ignore[union-attr]
    payment = await repo.create_payment(session, order, file_id, is_photo)
    if payment is None:
        await message.answer(texts.STALE_BUTTON, reply_markup=main_menu())
        return
    await message.answer(texts.RECEIPT_SENT, reply_markup=main_menu())

    kind = texts.KIND_PREPAY if payment.kind == PaymentKind.PREPAY else texts.KIND_FINAL
    caption = texts.EVT_RECEIPT.format(kind=kind, amount=fmt_rub(payment.amount), id=order.id)
    markup = inline.payment_check(payment.id)

    async def send(thread_id: int) -> Message:
        if is_photo:
            return await bot.send_photo(
                settings.admin_group_id,
                file_id,
                caption=caption,
                message_thread_id=thread_id,
                reply_markup=markup,
            )
        return await bot.send_document(
            settings.admin_group_id,
            file_id,
            caption=caption,
            message_thread_id=thread_id,
            reply_markup=markup,
        )

    try:
        sent = await call_in_order_thread(bot, session, settings, order.id, send)
    except TelegramAPIError:
        logger.exception("Cannot post receipt of order %s", order.id)
        sent = None
    if sent is not None:
        await repo.set_payment_admin_message(session, payment.id, sent.message_id)
    await refresh_card(bot, session, settings, order.id)


@router.message(ClientReceipt.waiting)
async def receipt_wrong(message: Message, state: FSMContext) -> None:
    order_id = (await state.get_data()).get("order_id", 0)
    await message.answer(texts.RECEIPT_WRONG, reply_markup=inline.receipt_cancel(order_id))


# ---------- приёмка ----------


@router.callback_query(ClientOrderCb.filter(F.action == "accept_work"))
async def cb_accept_work(
    callback: CallbackQuery,
    callback_data: ClientOrderCb,
    bot: Bot,
    session: AsyncSession,
    settings: Settings,
) -> None:
    order = await _own_order(session, callback, callback_data.order_id)
    msg = _msg(callback)
    if order is None or msg is None:
        return
    if not await repo.transition(session, order.id, S.DONE, allowed_from={S.DELIVERED}):
        await callback.answer(texts.STALE_BUTTON, show_alert=True)
        await _drop_markup(callback)
        return
    await _drop_markup(callback)
    await msg.answer(texts.WORK_ACCEPTED.format(id=order.id), reply_markup=main_menu())
    await callback.answer()
    fresh = await repo.get_order(session, order.id)
    if fresh:
        await on_order_done(bot, session, fresh)
    await post_to_order(bot, session, settings, order.id, texts.EVT_CLIENT_ACCEPTED_WORK)
    await refresh_card(bot, session, settings, order.id)
