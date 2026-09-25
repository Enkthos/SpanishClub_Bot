from datetime import date

import pytest

from bot.services.pricing import (
    WORK_TYPES,
    estimate,
    estimate_mid,
    get_work_type,
    parse_deadline,
    urgency_multiplier,
)
from bot.utils import plural

TODAY = date(2026, 9, 12)


@pytest.mark.parametrize(("days", "mult"), [(0, 1.5), (1, 1.5), (2, 1.25), (3, 1.25), (4, 1.0)])
def test_urgency(days: int, mult: float) -> None:
    assert urgency_multiplier(days) == mult


def test_estimate_uses_min_price_and_rounds() -> None:
    wt = WORK_TYPES["presentation"]  # 120/слайд, минимум 1000
    low, high = estimate(wt, 5, days_left=10)  # type: ignore[misc]
    assert (low, high) == (850, 1150)
    assert low % 50 == 0 and high % 50 == 0


def test_estimate_urgency_applied() -> None:
    wt = WORK_TYPES["presentation"]
    normal = estimate(wt, 20, days_left=10)
    urgent = estimate(wt, 20, days_left=1)
    assert normal and urgent and urgent[0] > normal[0]


def test_estimate_other_is_none() -> None:
    assert estimate(WORK_TYPES["other"], None, 5) is None
    assert estimate(WORK_TYPES["report"], None, 5) is None


def test_estimate_mid() -> None:
    assert estimate_mid(850, 1150) == 1000


def test_unknown_work_type_falls_back() -> None:
    assert get_work_type("nope").code == "other"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("20.09", date(2026, 9, 20)),
        ("12.09", date(2026, 9, 12)),  # сегодня — можно
        ("25/12/2026", date(2026, 12, 25)),
        ("01.03.27", date(2027, 3, 1)),
        ("10.01", date(2027, 1, 10)),  # без года и в прошлом — следующий год
        ("11.09.2026", None),  # явная прошедшая дата
        ("31.02", None),
        ("20.09.2030", None),  # дальше года
        ("завтра", None),
        ("", None),
    ],
)
def test_parse_deadline(text: str, expected: date | None) -> None:
    assert parse_deadline(text, TODAY) == expected


@pytest.mark.parametrize(
    ("n", "form"),
    [
        (1, "слайд"),
        (2, "слайда"),
        (5, "слайдов"),
        (11, "слайдов"),
        (21, "слайд"),
        (22, "слайда"),
        (112, "слайдов"),
    ],
)
def test_plural(n: int, form: str) -> None:
    assert plural(n, ("слайд", "слайда", "слайдов")) == form
