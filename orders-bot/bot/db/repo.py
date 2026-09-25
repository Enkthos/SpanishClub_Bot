"""Доступ к данным. Переходы статусов — условным UPDATE (защита от гонок и повторных нажатий)."""

import secrets
from collections.abc import Iterable
from datetime import date
from typing import Any, cast

from sqlalchemy import CursorResult, Result, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ColumnElement

from bot.db.models import (
    Order,
    OrderFile,
    Payment,
    PaymentKind,
    PaymentStatus,
    PriceOffer,
    User,
    utcnow,
)
from bot.services.money import REFERRAL_MIN_ORDER, Quote
from bot.services.order_flow import AGREED, TERMINAL, OrderStatus, sources_for

S = OrderStatus


def _rowcount(result: Result[Any]) -> int:
    return cast(CursorResult[Any], result).rowcount


# ---------- users ----------


async def get_user(session: AsyncSession, user_id: int) -> User | None:
    return await session.get(User, user_id, populate_existing=True)


async def upsert_user(
    session: AsyncSession, user_id: int, username: str | None, full_name: str
) -> tuple[User, bool]:
    """Возвращает (пользователь, создан_сейчас)."""
    user = await get_user(session, user_id)
    if user is not None:
        if (user.username, user.full_name, user.is_blocked) != (username, full_name, False):
            user.username, user.full_name, user.is_blocked = username, full_name, False
            await session.commit()
        return user, False

    user = User(id=user_id, username=username, full_name=full_name, ref_code=secrets.token_hex(4))
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        # Параллельный апдейт того же пользователя успел создать запись
        await session.rollback()
        existing = await get_user(session, user_id)
        if existing is None:
            raise
        return existing, False
    return user, True


async def get_user_by_ref_code(session: AsyncSession, code: str) -> User | None:
    return await session.scalar(select(User).where(User.ref_code == code))


async def set_referrer(session: AsyncSession, user_id: int, referrer_id: int) -> bool:
    if user_id == referrer_id:
        return False
    result = await session.execute(
        update(User)
        .where(User.id == user_id, User.referrer_id.is_(None))
        .values(referrer_id=referrer_id)
    )
    await session.commit()
    return _rowcount(result) == 1


async def set_active_order(session: AsyncSession, user_id: int, order_id: int | None) -> None:
    await session.execute(update(User).where(User.id == user_id).values(active_order_id=order_id))
    await session.commit()


async def set_support_thread(session: AsyncSession, user_id: int, thread_id: int | None) -> None:
    await session.execute(
        update(User).where(User.id == user_id).values(support_thread_id=thread_id)
    )
    await session.commit()


async def get_user_by_support_thread(session: AsyncSession, thread_id: int) -> User | None:
    return await session.scalar(select(User).where(User.support_thread_id == thread_id))


async def set_blocked(session: AsyncSession, user_id: int, blocked: bool = True) -> None:
    await session.execute(update(User).where(User.id == user_id).values(is_blocked=blocked))
    await session.commit()


# ---------- orders ----------


async def create_order(
    session: AsyncSession,
    *,
    user_id: int,
    work_type: str,
    topic: str,
    volume: int | None,
    deadline: date,
    description: str,
    estimate: tuple[int, int] | None,
    files: Iterable[tuple[str, str]] = (),
) -> Order:
    order = Order(
        user_id=user_id,
        work_type=work_type,
        topic=topic,
        volume=volume,
        deadline=deadline,
        description=description,
        status=S.NEW,
        estimate_min=estimate[0] if estimate else None,
        estimate_max=estimate[1] if estimate else None,
        discount_percent=0,
        paid_amount=0,
    )
    session.add(order)
    await session.flush()
    session.add_all(OrderFile(order_id=order.id, file_id=fid, kind=kind) for fid, kind in files)
    await session.commit()
    return order


async def get_order(session: AsyncSession, order_id: int) -> Order | None:
    return await session.get(Order, order_id, populate_existing=True)


async def get_order_by_thread(session: AsyncSession, thread_id: int) -> Order | None:
    return await session.scalar(select(Order).where(Order.thread_id == thread_id))


async def list_order_files(session: AsyncSession, order_id: int) -> list[OrderFile]:
    rows = await session.scalars(
        select(OrderFile).where(OrderFile.order_id == order_id).order_by(OrderFile.id)
    )
    return list(rows)


async def list_user_orders(session: AsyncSession, user_id: int, limit: int = 10) -> list[Order]:
    rows = await session.scalars(
        select(Order).where(Order.user_id == user_id).order_by(Order.id.desc()).limit(limit)
    )
    return list(rows)


async def list_active_orders(session: AsyncSession) -> list[Order]:
    rows = await session.scalars(
        select(Order).where(Order.status.not_in(list(TERMINAL))).order_by(Order.id)
    )
    return list(rows)


async def set_order_thread(session: AsyncSession, order_id: int, thread_id: int | None) -> None:
    await session.execute(
        update(Order).where(Order.id == order_id).values(thread_id=thread_id, card_message_id=None)
    )
    await session.commit()


async def set_card_message(session: AsyncSession, order_id: int, message_id: int | None) -> None:
    await session.execute(
        update(Order).where(Order.id == order_id).values(card_message_id=message_id)
    )
    await session.commit()


FULLY_PAID: tuple[ColumnElement[bool], ...] = (
    Order.final_price.is_not(None),
    Order.paid_amount >= Order.final_price,
)


async def transition(
    session: AsyncSession,
    order_id: int,
    to: OrderStatus,
    *,
    allowed_from: Iterable[OrderStatus] | None = None,
    extra_where: Iterable[ColumnElement[bool]] = (),
    commit: bool = True,
    **values: Any,
) -> bool:
    """Атомарный переход: сработает, только если текущий статус допустим."""
    sources = sources_for(to)
    if allowed_from is not None:
        sources = sources & frozenset(allowed_from)
    if not sources:
        return False
    result = await session.execute(
        update(Order)
        .where(Order.id == order_id, Order.status.in_(list(sources)), *extra_where)
        .values(status=to, updated_at=utcnow(), **values)
    )
    ok = _rowcount(result) == 1
    if commit:
        await session.commit()
    return ok


async def cancel_order(
    session: AsyncSession, order_id: int, allowed_from: Iterable[OrderStatus]
) -> bool:
    ok = await transition(session, order_id, S.CANCELLED, allowed_from=allowed_from, commit=False)
    if ok:
        await session.execute(
            update(PriceOffer).where(PriceOffer.order_id == order_id).values(is_active=False)
        )
        await session.commit()
    else:
        await session.rollback()
    return ok


async def request_remainder(session: AsyncSession, order_id: int) -> bool:
    return await transition(
        session,
        order_id,
        S.AWAITING_FINAL_PAY,
        allowed_from={S.IN_PROGRESS},
        extra_where=(Order.final_price.is_not(None), Order.paid_amount < Order.final_price),
    )


async def mark_delivered(session: AsyncSession, order_id: int) -> bool:
    return await transition(session, order_id, S.DELIVERED, extra_where=FULLY_PAID)


# ---------- offers ----------


async def create_offer(
    session: AsyncSession, order_id: int, quote: Quote
) -> tuple[PriceOffer, list[PriceOffer]] | None:
    """Новое предложение цены. Возвращает (новое, деактивированные старые)."""
    old = list(
        await session.scalars(
            select(PriceOffer).where(PriceOffer.order_id == order_id, PriceOffer.is_active)
        )
    )
    ok = await transition(
        session,
        order_id,
        S.AWAITING_AGREEMENT,
        commit=False,
        base_price=quote.base,
        discount_percent=quote.discount_percent,
        final_price=quote.final,
        prepay_percent=quote.prepay_percent,
        prepay_amount=quote.prepay,
    )
    if not ok:
        await session.rollback()
        return None
    for offer in old:
        offer.is_active = False
    new = PriceOffer(
        order_id=order_id,
        base_price=quote.base,
        discount_percent=quote.discount_percent,
        final_price=quote.final,
        prepay_percent=quote.prepay_percent,
        prepay_amount=quote.prepay,
        is_active=True,
    )
    session.add(new)
    await session.commit()
    return new, old


async def get_offer(session: AsyncSession, offer_id: int) -> PriceOffer | None:
    return await session.get(PriceOffer, offer_id, populate_existing=True)


async def get_active_offer(session: AsyncSession, order_id: int) -> PriceOffer | None:
    return await session.scalar(
        select(PriceOffer)
        .where(PriceOffer.order_id == order_id, PriceOffer.is_active)
        .order_by(PriceOffer.id.desc())
    )


async def set_offer_message(session: AsyncSession, offer_id: int, message_id: int) -> None:
    await session.execute(
        update(PriceOffer).where(PriceOffer.id == offer_id).values(client_message_id=message_id)
    )
    await session.commit()


async def _consume_offer(session: AsyncSession, offer_id: int, to: OrderStatus) -> Order | None:
    offer = await get_offer(session, offer_id)
    if offer is None or not offer.is_active:
        return None
    result = await session.execute(
        update(PriceOffer)
        .where(PriceOffer.id == offer_id, PriceOffer.is_active)
        .values(is_active=False)
    )
    ok = _rowcount(result) == 1 and await transition(
        session, offer.order_id, to, allowed_from={S.AWAITING_AGREEMENT}, commit=False
    )
    if not ok:
        await session.rollback()
        return None
    await session.commit()
    return await get_order(session, offer.order_id)


async def accept_offer(session: AsyncSession, offer_id: int) -> Order | None:
    return await _consume_offer(session, offer_id, S.AWAITING_PREPAY)


async def decline_offer(session: AsyncSession, offer_id: int) -> Order | None:
    return await _consume_offer(session, offer_id, S.CANCELLED)


# ---------- payments ----------


async def create_payment(
    session: AsyncSession, order: Order, receipt_file_id: str, is_photo: bool
) -> Payment | None:
    """Чек от клиента: заказ уходит на проверку оплаты. `order` — свежий из БД."""
    if order.status == S.AWAITING_PREPAY:
        kind, to, amount = PaymentKind.PREPAY, S.PREPAY_CHECK, order.prepay_amount or 0
    elif order.status == S.AWAITING_FINAL_PAY:
        kind, to, amount = PaymentKind.FINAL, S.FINAL_CHECK, order.remainder
    else:
        return None
    ok = await transition(
        session, order.id, to, allowed_from={OrderStatus(order.status)}, commit=False
    )
    if not ok or amount <= 0:
        await session.rollback()
        return None
    payment = Payment(
        order_id=order.id,
        kind=kind,
        amount=amount,
        status=PaymentStatus.PENDING,
        receipt_file_id=receipt_file_id,
        receipt_is_photo=is_photo,
    )
    session.add(payment)
    await session.commit()
    return payment


async def get_payment(session: AsyncSession, payment_id: int) -> Payment | None:
    return await session.get(Payment, payment_id, populate_existing=True)


async def set_payment_admin_message(
    session: AsyncSession, payment_id: int, message_id: int
) -> None:
    await session.execute(
        update(Payment).where(Payment.id == payment_id).values(admin_message_id=message_id)
    )
    await session.commit()


async def resolve_payment(
    session: AsyncSession, payment_id: int, confirm: bool
) -> tuple[Payment, Order] | None:
    payment = await get_payment(session, payment_id)
    if payment is None or payment.status != PaymentStatus.PENDING:
        return None
    result = await session.execute(
        update(Payment)
        .where(Payment.id == payment_id, Payment.status == PaymentStatus.PENDING)
        .values(status=PaymentStatus.CONFIRMED if confirm else PaymentStatus.REJECTED)
    )
    if payment.kind == PaymentKind.PREPAY:
        src, to = S.PREPAY_CHECK, (S.IN_PROGRESS if confirm else S.AWAITING_PREPAY)
    else:
        src, to = S.FINAL_CHECK, (S.PAID if confirm else S.AWAITING_FINAL_PAY)
    values = {"paid_amount": Order.paid_amount + payment.amount} if confirm else {}
    ok = _rowcount(result) == 1 and await transition(
        session, payment.order_id, to, allowed_from={src}, commit=False, **values
    )
    if not ok:
        await session.rollback()
        return None
    await session.commit()
    fresh_payment = await get_payment(session, payment_id)
    order = await get_order(session, payment.order_id)
    assert fresh_payment is not None and order is not None
    return fresh_payment, order


# ---------- referrals & stats ----------


async def count_done_orders(session: AsyncSession, user_id: int) -> int:
    return (
        await session.scalar(
            select(func.count()).where(Order.user_id == user_id, Order.status == S.DONE)
        )
        or 0
    )


async def has_other_agreed_orders(
    session: AsyncSession, user_id: int, order_id: int | None
) -> bool:
    stmt = select(func.count()).where(Order.user_id == user_id, Order.status.in_(list(AGREED)))
    if order_id is not None:
        stmt = stmt.where(Order.id != order_id)
    return bool(await session.scalar(stmt))


def _qualifying_order_filter() -> tuple[ColumnElement[bool], ...]:
    return (Order.status == S.DONE, Order.final_price >= REFERRAL_MIN_ORDER)


async def count_qualified_referrals(session: AsyncSession, referrer_id: int) -> int:
    stmt = (
        select(func.count(func.distinct(User.id)))
        .join(Order, Order.user_id == User.id)
        .where(User.referrer_id == referrer_id, *_qualifying_order_filter())
    )
    return await session.scalar(stmt) or 0


async def count_invited(session: AsyncSession, referrer_id: int) -> int:
    return await session.scalar(select(func.count()).where(User.referrer_id == referrer_id)) or 0


async def count_qualifying_orders(session: AsyncSession, user_id: int) -> int:
    return (
        await session.scalar(
            select(func.count()).where(Order.user_id == user_id, *_qualifying_order_filter())
        )
        or 0
    )


async def get_stats(session: AsyncSession) -> dict[str, int]:
    users = await session.scalar(select(func.count()).select_from(User)) or 0
    rows = await session.execute(select(Order.status, func.count()).group_by(Order.status))
    by_status: dict[str, int] = {status: count for status, count in rows.tuples()}
    revenue = await session.scalar(select(func.coalesce(func.sum(Order.paid_amount), 0))) or 0
    return {
        "users": users,
        "orders": sum(by_status.values()),
        "active": sum(n for st, n in by_status.items() if st not in TERMINAL),
        "done": by_status.get(S.DONE, 0),
        "cancelled": by_status.get(S.CANCELLED, 0),
        "revenue": revenue,
    }
