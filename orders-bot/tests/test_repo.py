from collections.abc import AsyncIterator
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from bot.db import repo
from bot.db.models import Base, Order
from bot.services.money import make_quote
from bot.services.order_flow import OrderStatus

S = OrderStatus


@pytest.fixture
async def session(tmp_path: Path) -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        yield s
    await engine.dispose()


async def _order(session: AsyncSession, user_id: int = 1) -> Order:
    await repo.upsert_user(session, user_id, None, f"User {user_id}")
    return await repo.create_order(
        session,
        user_id=user_id,
        work_type="presentation",
        topic="Тема",
        volume=10,
        deadline=date(2026, 9, 20),
        description="Описание задания",
        estimate=(1000, 1400),
        files=[("file-1", "document")],
    )


async def _status(session: AsyncSession, order_id: int) -> str:
    order = await repo.get_order(session, order_id)
    assert order is not None
    return order.status


async def test_upsert_user(session: AsyncSession) -> None:
    user, created = await repo.upsert_user(session, 10, "a", "A")
    assert created and user.ref_code
    again, created_again = await repo.upsert_user(session, 10, "b", "B")
    assert not created_again and again.username == "b"


async def test_set_referrer_once_and_not_self(session: AsyncSession) -> None:
    await repo.upsert_user(session, 1, None, "A")
    await repo.upsert_user(session, 2, None, "B")
    await repo.upsert_user(session, 3, None, "C")
    assert not await repo.set_referrer(session, 1, 1)
    assert await repo.set_referrer(session, 2, 1)
    assert not await repo.set_referrer(session, 2, 3)


async def test_offer_accept_is_idempotent(session: AsyncSession) -> None:
    order = await _order(session)
    created = await repo.create_offer(session, order.id, make_quote(2000, 0, False))
    assert created
    offer, _ = created
    assert await repo.accept_offer(session, offer.id)
    assert await repo.accept_offer(session, offer.id) is None
    assert await _status(session, order.id) == S.AWAITING_PREPAY


async def test_reprice_invalidates_old_offer(session: AsyncSession) -> None:
    order = await _order(session)
    first = await repo.create_offer(session, order.id, make_quote(2000, 0, False))
    second = await repo.create_offer(session, order.id, make_quote(1800, 0, False))
    assert first and second
    assert [o.id for o in second[1]] == [first[0].id]
    assert await repo.accept_offer(session, first[0].id) is None
    accepted = await repo.accept_offer(session, second[0].id)
    assert accepted and accepted.final_price == 1800


async def test_cannot_offer_after_payment_started(session: AsyncSession) -> None:
    order = await _order(session)
    created = await repo.create_offer(session, order.id, make_quote(2000, 0, False))
    assert created
    fresh = await repo.accept_offer(session, created[0].id)
    assert fresh
    assert await repo.create_payment(session, fresh, "receipt", True)
    assert await repo.create_offer(session, order.id, make_quote(1000, 0, False)) is None


async def test_full_payment_flow(session: AsyncSession) -> None:
    order = await _order(session)
    created = await repo.create_offer(session, order.id, make_quote(2000, 0, False))
    assert created
    fresh = await repo.accept_offer(session, created[0].id)
    assert fresh

    # До полной оплаты сдать работу нельзя
    prepay = await repo.create_payment(session, fresh, "r1", True)
    assert prepay and prepay.amount == 1000
    assert await repo.resolve_payment(session, prepay.id, confirm=True)
    assert await repo.resolve_payment(session, prepay.id, confirm=True) is None
    assert not await repo.mark_delivered(session, order.id)

    assert await repo.request_remainder(session, order.id)
    fresh = await repo.get_order(session, order.id)
    assert fresh and fresh.remainder == 1000
    final = await repo.create_payment(session, fresh, "r2", False)
    assert final

    # Отклонённый чек возвращает к ожиданию оплаты
    assert await repo.resolve_payment(session, final.id, confirm=False)
    assert await _status(session, order.id) == S.AWAITING_FINAL_PAY
    fresh = await repo.get_order(session, order.id)
    assert fresh
    final = await repo.create_payment(session, fresh, "r3", False)
    assert final
    resolved = await repo.resolve_payment(session, final.id, confirm=True)
    assert resolved and resolved[1].paid_amount == 2000 and resolved[1].status == S.PAID

    assert await repo.mark_delivered(session, order.id)
    assert await repo.transition(session, order.id, S.DONE)
    assert not await repo.cancel_order(session, order.id, {S.DONE})


async def test_referral_counting(session: AsyncSession) -> None:
    await repo.upsert_user(session, 100, None, "Referrer")
    cheap = await _order(session, user_id=2)
    good = await _order(session, user_id=3)
    for uid in (2, 3):
        await repo.set_referrer(session, uid, 100)
    for order, price in ((cheap, 400), (good, 600)):
        # Статус выставляем напрямую: здесь проверяется подсчёт, а не переходы
        order_obj = await repo.get_order(session, order.id)
        assert order_obj
        order_obj.status, order_obj.final_price = S.DONE, price
        await session.commit()

    assert await repo.count_invited(session, 100) == 2
    assert await repo.count_qualified_referrals(session, 100) == 1
    assert await repo.count_qualifying_orders(session, 3) == 1
    assert await repo.count_qualifying_orders(session, 2) == 0


async def test_has_other_agreed_orders(session: AsyncSession) -> None:
    order = await _order(session)
    assert not await repo.has_other_agreed_orders(session, 1, order.id)
    created = await repo.create_offer(session, order.id, make_quote(2000, 0, False))
    assert created and await repo.accept_offer(session, created[0].id)
    second = await _order(session)
    assert await repo.has_other_agreed_orders(session, 1, second.id)
    assert not await repo.has_other_agreed_orders(session, 1, order.id)
