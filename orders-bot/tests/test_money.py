import pytest

from bot.services.money import (
    fmt_rub,
    make_quote,
    next_referral_tier,
    parse_price,
    pick_discount,
    prepay_percent,
    referral_tier_discount,
)


@pytest.mark.parametrize(("n", "pct"), [(0, 0), (1, 10), (2, 15), (3, 15), (4, 20), (10, 20)])
def test_referral_tiers(n: int, pct: int) -> None:
    assert referral_tier_discount(n) == pct


def test_next_tier() -> None:
    assert next_referral_tier(0) == (1, 10)
    assert next_referral_tier(1) == (1, 15)
    assert next_referral_tier(2) == (2, 20)
    assert next_referral_tier(3) == (1, 20)
    assert next_referral_tier(4) is None


def test_discounts_do_not_stack() -> None:
    assert pick_discount(0, False) == (0, "")
    assert pick_discount(0, True)[0] == 5
    assert pick_discount(1, True)[0] == 10  # максимум, не 15
    assert pick_discount(4, True)[0] == 20


@pytest.mark.parametrize(
    ("final", "returning", "pct"),
    [(999, False, 100), (1000, False, 50), (1000, True, 25), (500, True, 100)],
)
def test_prepay_percent(final: int, returning: bool, pct: int) -> None:
    assert prepay_percent(final, returning) == pct


def test_quote_with_discount() -> None:
    q = make_quote(2000, 10, is_returning=False)
    assert (q.final, q.discount_amount, q.prepay_percent, q.prepay, q.remainder) == (
        1800,
        200,
        50,
        900,
        900,
    )


def test_quote_prepay_rounds_up_to_10() -> None:
    q = make_quote(1333, 0, is_returning=True)  # 25% = 333.25
    assert q.prepay == 340
    assert q.prepay + q.remainder == q.final


def test_quote_discount_can_trigger_full_prepay() -> None:
    q = make_quote(1100, 10, is_returning=False)  # итог 990 < 1000
    assert q.final == 990 and q.prepay == 990 and q.remainder == 0


@pytest.mark.parametrize(
    ("text", "value"),
    [
        ("2000", 2000),
        ("2 000", 2000),
        ("2 000 ₽", 2000),
        ("1500р", 1500),
        ("3000 руб.", 3000),
        ("  750 ", 750),
        ("99", None),
        ("abc", None),
        ("2000$", None),
        ("-500", None),
        ("", None),
        (None, None),
        ("10000000", None),
    ],
)
def test_parse_price(text: str | None, value: int | None) -> None:
    assert parse_price(text) == value


def test_fmt_rub() -> None:
    assert fmt_rub(12500) == "12 500 ₽"
