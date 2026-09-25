"""Деньги: скидки, реферальные уровни, предоплата. Все суммы — целые рубли."""

import math
import re
from dataclasses import dataclass

from bot.utils import plural

MIN_PRICE = 100
MAX_PRICE = 1_000_000

PREPAY_NEW_PERCENT = 50
PREPAY_RETURNING_PERCENT = 25
FULL_PREPAY_BELOW = 1000  # итог меньше этой суммы — 100% предоплата
PREPAY_ROUND_STEP = 10

# (засчитанных друзей, скидка %) — по убыванию
REFERRAL_TIERS: tuple[tuple[int, int], ...] = ((4, 20), (2, 15), (1, 10))
REFERRAL_MIN_ORDER = 500  # заказ друга засчитывается от этой суммы
FRIEND_FIRST_ORDER_DISCOUNT = 5

FRIENDS_FORMS = ("друг", "друга", "друзей")


def referral_tier_discount(qualified: int) -> int:
    for need, percent in REFERRAL_TIERS:
        if qualified >= need:
            return percent
    return 0


def next_referral_tier(qualified: int) -> tuple[int, int] | None:
    """(сколько ещё друзей нужно, какая будет скидка) или None на максимуме."""
    for need, percent in reversed(REFERRAL_TIERS):
        if qualified < need:
            return need - qualified, percent
    return None


def pick_discount(qualified_referrals: int, is_invited_first_order: bool) -> tuple[int, str]:
    """Скидки не суммируются — берётся максимальная. Возвращает (процент, причина)."""
    tier = referral_tier_discount(qualified_referrals)
    friend = FRIEND_FIRST_ORDER_DISCOUNT if is_invited_first_order else 0
    if tier and tier >= friend:
        n = qualified_referrals
        return tier, f"реферальная — {n} {plural(n, FRIENDS_FORMS)}"
    if friend:
        return friend, "первый заказ по приглашению"
    return 0, ""


def prepay_percent(final_price: int, is_returning: bool) -> int:
    if final_price < FULL_PREPAY_BELOW:
        return 100
    return PREPAY_RETURNING_PERCENT if is_returning else PREPAY_NEW_PERCENT


@dataclass(frozen=True)
class Quote:
    base: int
    discount_percent: int
    final: int
    prepay_percent: int
    prepay: int

    @property
    def discount_amount(self) -> int:
        return self.base - self.final

    @property
    def remainder(self) -> int:
        return self.final - self.prepay


def make_quote(base: int, discount_percent: int, is_returning: bool) -> Quote:
    discount = base * discount_percent // 100  # округление в пользу клиента
    final = base - discount
    percent = prepay_percent(final, is_returning)
    if percent >= 100:
        prepay = final
    else:
        step = PREPAY_ROUND_STEP
        prepay = min(final, math.ceil(final * percent / 100 / step) * step)
    return Quote(base, discount_percent, final, percent, prepay)


_PRICE_RE = re.compile(r"^\s*(\d[\d\s  ]*)\s*(?:₽|р\.?|руб\.?|рублей|rub)?\s*$", re.IGNORECASE)


def parse_price(text: str | None) -> int | None:
    match = _PRICE_RE.match(text or "")
    if not match:
        return None
    value = int(re.sub(r"\D", "", match[1]))
    return value if MIN_PRICE <= value <= MAX_PRICE else None


def fmt_rub(amount: int) -> str:
    return f"{amount:,}".replace(",", " ") + " ₽"
