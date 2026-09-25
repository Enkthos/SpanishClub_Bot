from itertools import pairwise

from bot.services.order_flow import (
    ADMIN_CANCELLABLE,
    REPRICEABLE,
    STATUS_INFO,
    TERMINAL,
    TRANSITIONS,
    OrderStatus,
    can_transition,
    sources_for,
)

S = OrderStatus


def test_every_status_described() -> None:
    assert set(TRANSITIONS) == set(S)
    assert set(STATUS_INFO) == set(S)


def test_terminal_has_no_exits() -> None:
    for status in TERMINAL:
        assert not TRANSITIONS[status]


def test_happy_path() -> None:
    path = [
        S.NEW,
        S.AWAITING_AGREEMENT,
        S.AWAITING_PREPAY,
        S.PREPAY_CHECK,
        S.IN_PROGRESS,
        S.AWAITING_FINAL_PAY,
        S.FINAL_CHECK,
        S.PAID,
        S.DELIVERED,
        S.DONE,
    ]
    for src, dst in pairwise(path):
        assert can_transition(src, dst), (src, dst)


def test_forbidden_jumps() -> None:
    assert not can_transition(S.NEW, S.IN_PROGRESS)
    assert not can_transition(S.AWAITING_FINAL_PAY, S.DELIVERED)
    assert not can_transition(S.DELIVERED, S.CANCELLED)
    assert not can_transition(S.DONE, S.CANCELLED)


def test_derived_sets() -> None:
    assert sources_for(S.DONE) == {S.DELIVERED}
    assert {S.NEW, S.AWAITING_AGREEMENT, S.AWAITING_PREPAY} == REPRICEABLE
    assert S.DELIVERED not in ADMIN_CANCELLABLE and S.PAID in ADMIN_CANCELLABLE
