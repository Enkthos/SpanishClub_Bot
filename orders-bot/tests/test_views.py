from datetime import date

from bot.config import Settings
from bot.db.models import Order, PriceOffer, User
from bot.keyboards import inline
from bot.services.clients import ClientTerms
from bot.services.money import make_quote
from bot.services.order_flow import OrderStatus
from bot.views import (
    admin_card,
    client_order_card,
    form_summary,
    offer_text,
    payment_text,
    price_preview,
    referral_text,
)

TODAY = date(2026, 9, 12)
S = OrderStatus


def _user() -> User:
    return User(
        id=42,
        username="client",
        full_name="<b>Hacker</b>",
        ref_code="abcd1234",
        referrer_id=7,
        is_blocked=False,
    )


def _order(status: OrderStatus = S.NEW, **kw: object) -> Order:
    fields: dict[str, object] = dict(
        id=17,
        user_id=42,
        work_type="presentation",
        topic="Тема <script>",
        volume=15,
        deadline=date(2026, 9, 14),
        description="Описание & детали",
        status=status,
        estimate_min=1500,
        estimate_max=2050,
        discount_percent=0,
        paid_amount=0,
    )
    fields.update(kw)
    return Order(**fields)


TERMS = ClientTerms(
    discount_percent=10,
    discount_reason="реферальная — 1 друг",
    is_returning=False,
    done_orders=0,
    qualified_referrals=1,
)


def test_admin_card_escapes_and_shows_estimate() -> None:
    text = admin_card(_order(), _user(), TERMS, TODAY)
    assert "<script>" not in text and "&lt;script&gt;" in text
    assert "&lt;b&gt;Hacker" in text
    assert "15 слайдов" in text and "через 2 дня" in text
    assert "со скидкой" in text


def test_client_card_never_shows_estimate() -> None:
    text = client_order_card(_order(), TODAY)
    assert "1 500" not in text and "Оценка" not in text


def test_offer_and_preview_amounts() -> None:
    quote = make_quote(2000, 10, is_returning=False)
    order = _order(
        S.AWAITING_AGREEMENT,
        base_price=2000,
        discount_percent=10,
        final_price=1800,
        prepay_percent=50,
        prepay_amount=900,
    )
    offer = PriceOffer(
        id=1,
        order_id=17,
        base_price=2000,
        discount_percent=10,
        final_price=1800,
        prepay_percent=50,
        prepay_amount=900,
        is_active=True,
    )
    text = offer_text(order, offer)
    # fmt_rub использует неразрывные пробелы, чтобы сумма не переносилась
    assert "1 800 ₽" in text and "900 ₽" in text
    assert "−200 ₽" in price_preview(order, quote, TERMS)


def test_payment_text_titles() -> None:
    settings = Settings(
        bot_token="1:x",
        admin_id=1,
        admin_group_id=-100,
        payment_phone="+7 900",
        payment_bank="Банк",
        payment_recipient="И.",
    )
    full = _order(S.AWAITING_PREPAY, final_price=900, prepay_percent=100, prepay_amount=900)
    assert "Оплата по заказу" in payment_text(full, 900, False, settings)
    part = _order(S.AWAITING_PREPAY, final_price=2000, prepay_percent=50, prepay_amount=1000)
    assert "Предоплата" in payment_text(part, 1000, False, settings)
    assert "Оплата остатка" in payment_text(part, 1000, True, settings)


def test_referral_progress() -> None:
    assert "Ещё 1 друг — и скидка 15%" in referral_text("https://t.me/b?start=ref_x", 1, 3)
    assert "максимальная" in referral_text("https://t.me/b?start=ref_x", 4, 4)


def test_form_summary() -> None:
    data = {
        "work_type": "other",
        "topic": "T",
        "deadline": "2026-09-20",
        "description": "desc",
        "files": [["f", "photo"]],
    }
    text = form_summary(data, TODAY)
    assert "Объём" not in text and "Файлов: 1" in text


def test_admin_keyboard_by_status() -> None:
    def actions(order: Order) -> list[str]:
        markup = inline.admin_card(order)
        return [
            b.callback_data.split(":")[1]
            for row in markup.inline_keyboard
            for b in row
            if b.callback_data
        ]

    assert actions(_order(S.NEW)) == ["price", "estimate", "cancel"]
    assert "remainder" in actions(_order(S.IN_PROGRESS, final_price=2000, paid_amount=1000))
    assert "deliver" in actions(_order(S.IN_PROGRESS, final_price=900, paid_amount=900))
    assert actions(_order(S.DELIVERED)) == ["close"]
    assert actions(_order(S.DONE)) == []
