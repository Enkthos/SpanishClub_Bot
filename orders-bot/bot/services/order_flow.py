"""Статусы заказа и допустимые переходы — единственный источник правды."""

from enum import StrEnum


class OrderStatus(StrEnum):
    NEW = "new"
    AWAITING_AGREEMENT = "awaiting_agreement"
    AWAITING_PREPAY = "awaiting_prepay"
    PREPAY_CHECK = "prepay_check"
    IN_PROGRESS = "in_progress"
    AWAITING_FINAL_PAY = "awaiting_final_pay"
    FINAL_CHECK = "final_check"
    PAID = "paid"
    DELIVERED = "delivered"
    DONE = "done"
    CANCELLED = "cancelled"


S = OrderStatus

TRANSITIONS: dict[OrderStatus, frozenset[OrderStatus]] = {
    S.NEW: frozenset({S.AWAITING_AGREEMENT, S.CANCELLED}),
    S.AWAITING_AGREEMENT: frozenset({S.AWAITING_AGREEMENT, S.AWAITING_PREPAY, S.CANCELLED}),
    S.AWAITING_PREPAY: frozenset({S.AWAITING_AGREEMENT, S.PREPAY_CHECK, S.CANCELLED}),
    S.PREPAY_CHECK: frozenset({S.IN_PROGRESS, S.AWAITING_PREPAY, S.CANCELLED}),
    # IN_PROGRESS -> DELIVERED только при полной оплате (100% предоплата)
    S.IN_PROGRESS: frozenset({S.AWAITING_FINAL_PAY, S.DELIVERED, S.CANCELLED}),
    S.AWAITING_FINAL_PAY: frozenset({S.FINAL_CHECK, S.CANCELLED}),
    S.FINAL_CHECK: frozenset({S.PAID, S.AWAITING_FINAL_PAY, S.CANCELLED}),
    S.PAID: frozenset({S.DELIVERED, S.CANCELLED}),
    S.DELIVERED: frozenset({S.DONE}),
    S.DONE: frozenset(),
    S.CANCELLED: frozenset(),
}

TERMINAL = frozenset({S.DONE, S.CANCELLED})
CLIENT_CANCELLABLE = frozenset({S.NEW, S.AWAITING_AGREEMENT, S.AWAITING_PREPAY})
AWAITING_PAYMENT = frozenset({S.AWAITING_PREPAY, S.AWAITING_FINAL_PAY})
# Цена согласована — заказ считается «принятым» (для скидки на первый заказ)
AGREED = frozenset(
    {
        S.AWAITING_PREPAY,
        S.PREPAY_CHECK,
        S.IN_PROGRESS,
        S.AWAITING_FINAL_PAY,
        S.FINAL_CHECK,
        S.PAID,
        S.DELIVERED,
        S.DONE,
    }
)


def can_transition(src: OrderStatus, dst: OrderStatus) -> bool:
    return dst in TRANSITIONS[src]


def sources_for(dst: OrderStatus) -> frozenset[OrderStatus]:
    return frozenset(src for src, targets in TRANSITIONS.items() if dst in targets)


REPRICEABLE = sources_for(S.AWAITING_AGREEMENT)
ADMIN_CANCELLABLE = sources_for(S.CANCELLED)

# (эмодзи, для исполнителя, для клиента)
STATUS_INFO: dict[OrderStatus, tuple[str, str, str]] = {
    S.NEW: ("🆕", "Новый — назначьте цену", "Исполнитель оценивает заказ"),
    S.AWAITING_AGREEMENT: ("💬", "Ждёт согласия клиента", "Ждёт вашего решения по цене"),
    S.AWAITING_PREPAY: ("💳", "Ждёт предоплату", "Ожидает предоплату"),
    S.PREPAY_CHECK: ("🔎", "Проверьте предоплату", "Проверяем оплату"),
    S.IN_PROGRESS: ("🛠", "В работе", "В работе"),
    S.AWAITING_FINAL_PAY: ("💳", "Ждёт оплату остатка", "Ожидает оплату остатка"),
    S.FINAL_CHECK: ("🔎", "Проверьте оплату остатка", "Проверяем оплату"),
    S.PAID: ("💰", "Оплачен — сдайте работу", "Оплачен, работа скоро будет у вас"),
    S.DELIVERED: ("📎", "Сдан — ждёт приёмки", "Работа отправлена — примите её"),
    S.DONE: ("✅", "Выполнен", "Выполнен"),
    S.CANCELLED: ("❌", "Отменён", "Отменён"),
}


def status_emoji(status: str) -> str:
    return STATUS_INFO[OrderStatus(status)][0]


def admin_status(status: str) -> str:
    emoji, text, _ = STATUS_INFO[OrderStatus(status)]
    return f"{emoji} {text}"


def client_status(status: str) -> str:
    emoji, _, text = STATUS_INFO[OrderStatus(status)]
    return f"{emoji} {text}"
