"""Прайс и расчёт ориентировочной цены. Оценку видит только исполнитель.

Цены ниже — заглушки: поправьте под себя.
"""

import re
from dataclasses import dataclass
from datetime import date

ESTIMATE_SPREAD = 0.15  # вилка ±15%
ROUND_STEP = 50
# (дней до срока включительно, множитель)
URGENCY: tuple[tuple[int, float], ...] = ((1, 1.5), (3, 1.25))
MAX_DEADLINE_DAYS = 365


@dataclass(frozen=True)
class WorkType:
    code: str
    title: str
    emoji: str
    unit_forms: tuple[str, str, str] | None = None  # слайд / слайда / слайдов
    unit_price: int = 0
    min_price: int = 0
    max_volume: int = 0
    volume_presets: tuple[int, ...] = ()

    @property
    def label(self) -> str:
        return f"{self.emoji} {self.title}"

    @property
    def has_volume(self) -> bool:
        return self.unit_forms is not None


_PAGES = ("страница", "страницы", "страниц")

WORK_TYPES: dict[str, WorkType] = {
    wt.code: wt
    for wt in (
        WorkType(
            "presentation",
            "Презентация",
            "🎞",
            ("слайд", "слайда", "слайдов"),
            unit_price=120,
            min_price=1000,
            max_volume=200,
            volume_presets=(10, 15, 20, 30),
        ),
        WorkType(
            "report",
            "Отчёт",
            "📊",
            _PAGES,
            unit_price=180,
            min_price=1500,
            max_volume=300,
            volume_presets=(10, 20, 30, 50),
        ),
        WorkType(
            "referat",
            "Реферат",
            "📚",
            _PAGES,
            unit_price=150,
            min_price=1200,
            max_volume=100,
            volume_presets=(10, 15, 20, 30),
        ),
        WorkType(
            "doklad",
            "Доклад",
            "🎤",
            _PAGES,
            unit_price=150,
            min_price=800,
            max_volume=60,
            volume_presets=(3, 5, 10, 15),
        ),
        WorkType(
            "essay",
            "Эссе",
            "✍️",
            _PAGES,
            unit_price=200,
            min_price=800,
            max_volume=50,
            volume_presets=(2, 3, 5, 10),
        ),
        WorkType("other", "Другое", "🧩"),
    )
}


def get_work_type(code: str) -> WorkType:
    return WORK_TYPES.get(code, WORK_TYPES["other"])


def urgency_multiplier(days_left: int) -> float:
    for max_days, multiplier in URGENCY:
        if days_left <= max_days:
            return multiplier
    return 1.0


def _round(value: float) -> int:
    return max(ROUND_STEP, round(value / ROUND_STEP) * ROUND_STEP)


def estimate(work_type: WorkType, volume: int | None, days_left: int) -> tuple[int, int] | None:
    """Вилка цены или None, если оценить автоматически нельзя."""
    if not work_type.has_volume or not volume:
        return None
    base = max(work_type.unit_price * volume, work_type.min_price) * urgency_multiplier(days_left)
    return _round(base * (1 - ESTIMATE_SPREAD)), _round(base * (1 + ESTIMATE_SPREAD))


def estimate_mid(low: int, high: int) -> int:
    return _round((low + high) / 2)


_DATE_RE = re.compile(r"^\s*(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?\s*$")


def parse_deadline(text: str, today: date) -> date | None:
    """'25.09', '25.09.26', '25/09/2026'. Без года — ближайшая будущая дата."""
    match = _DATE_RE.match(text or "")
    if not match:
        return None
    day, month, year_raw = int(match[1]), int(match[2]), match[3]
    year = today.year if year_raw is None else int(year_raw)
    if year_raw is not None and len(year_raw) == 2:
        year += 2000
    try:
        result = date(year, month, day)
        if year_raw is None and result < today:
            result = date(year + 1, month, day)
    except ValueError:
        return None
    if result < today or (result - today).days > MAX_DEADLINE_DAYS:
        return None
    return result
