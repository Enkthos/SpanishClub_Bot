"""Условия для конкретного клиента: скидка, статус постоянного, рефералы."""

import logging
from dataclasses import dataclass

from aiogram import Bot
from sqlalchemy.ext.asyncio import AsyncSession

from bot import texts
from bot.db import repo
from bot.db.models import Order, User
from bot.services import money
from bot.services.notify import send_to_user

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ClientTerms:
    discount_percent: int
    discount_reason: str
    is_returning: bool
    done_orders: int
    qualified_referrals: int


async def load_terms(session: AsyncSession, user: User, order_id: int | None) -> ClientTerms:
    qualified = await repo.count_qualified_referrals(session, user.id)
    done = await repo.count_done_orders(session, user.id)
    invited_first = user.referrer_id is not None and not await repo.has_other_agreed_orders(
        session, user.id, order_id
    )
    percent, reason = money.pick_discount(qualified, invited_first)
    return ClientTerms(percent, reason, done > 0, done, qualified)


async def referral_link(bot: Bot, user: User) -> str:
    me = await bot.me()
    return f"https://t.me/{me.username}?start=ref_{user.ref_code}"


async def on_order_done(bot: Bot, session: AsyncSession, order: Order) -> None:
    """Если это первый засчитываемый заказ приглашённого — уведомляем пригласившего."""
    user = await repo.get_user(session, order.user_id)
    if user is None or user.referrer_id is None:
        return
    if (order.final_price or 0) < money.REFERRAL_MIN_ORDER:
        return
    if await repo.count_qualifying_orders(session, user.id) != 1:
        return
    count = await repo.count_qualified_referrals(session, user.referrer_id)
    await send_to_user(
        bot,
        session,
        user.referrer_id,
        texts.REFERRAL_QUALIFIED.format(count=count, percent=money.referral_tier_discount(count)),
    )
    logger.info("Referral qualified: referrer=%s friend=%s", user.referrer_id, user.id)
