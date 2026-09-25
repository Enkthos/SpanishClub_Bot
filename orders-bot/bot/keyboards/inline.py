from urllib.parse import quote

from aiogram.filters.callback_data import CallbackData
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from bot.callbacks import (
    AdminOrderCb,
    ClientOrderCb,
    FormCb,
    OfferCb,
    PaymentCheckCb,
    PricePreviewCb,
    RelayFileCb,
)
from bot.db.models import Order
from bot.services.order_flow import (
    ADMIN_CANCELLABLE,
    AWAITING_PAYMENT,
    CLIENT_CANCELLABLE,
    REPRICEABLE,
    TERMINAL,
    OrderStatus,
)
from bot.services.pricing import WORK_TYPES, WorkType
from bot.views import order_button_label

S = OrderStatus
Rows = list[list[InlineKeyboardButton]]


def _btn(text: str, cb: CallbackData) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=cb.pack())


def _markup(rows: Rows) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[row for row in rows if row])


# ---------- анкета ----------


def _form_nav(back: bool = True) -> list[InlineKeyboardButton]:
    row = [_btn("❌ Отмена", FormCb(action="cancel"))]
    if back:
        row.insert(0, _btn("◀️ Назад", FormCb(action="back")))
    return row


def form_work_types() -> InlineKeyboardMarkup:
    buttons = [_btn(wt.label, FormCb(action="type", value=wt.code)) for wt in WORK_TYPES.values()]
    rows = [buttons[i : i + 2] for i in range(0, len(buttons), 2)]
    return _markup([*rows, _form_nav(back=False)])


def form_nav() -> InlineKeyboardMarkup:
    return _markup([_form_nav()])


def form_volume(work_type: WorkType) -> InlineKeyboardMarkup:
    presets = [_btn(str(n), FormCb(action="vol", value=str(n))) for n in work_type.volume_presets]
    return _markup([presets, _form_nav()])


DEADLINE_PRESETS = (("Завтра", 1), ("Через 3 дня", 3), ("Через неделю", 7), ("Через 2 недели", 14))


def form_deadline() -> InlineKeyboardMarkup:
    buttons = [
        _btn(title, FormCb(action="dl", value=str(days))) for title, days in DEADLINE_PRESETS
    ]
    return _markup([buttons[:2], buttons[2:], _form_nav()])


def form_files(count: int) -> InlineKeyboardMarkup:
    title = f"✅ Готово ({count})" if count else "➡️ Пропустить"
    return _markup([[_btn(title, FormCb(action="files_done"))], _form_nav()])


def form_confirm() -> InlineKeyboardMarkup:
    return _markup([[_btn("✅ Отправить заявку", FormCb(action="submit"))], _form_nav()])


# ---------- клиент ----------


def my_orders(orders: list[Order]) -> InlineKeyboardMarkup:
    return _markup(
        [[_btn(order_button_label(o), ClientOrderCb(action="view", order_id=o.id))] for o in orders]
    )


def client_order(order: Order, has_offer: bool) -> InlineKeyboardMarkup:
    status, oid = S(order.status), order.id
    rows: Rows = []
    if status == S.AWAITING_AGREEMENT and has_offer:
        rows.append([_btn("💰 Посмотреть цену", ClientOrderCb(action="offer", order_id=oid))])
    if status in AWAITING_PAYMENT:
        rows.append([_btn("💳 Оплатить", ClientOrderCb(action="pay_info", order_id=oid))])
    if status == S.DELIVERED:
        rows.append([_btn("🏁 Принять работу", ClientOrderCb(action="accept_work", order_id=oid))])
    if status not in TERMINAL:
        rows.append([_btn("💬 Написать по заказу", ClientOrderCb(action="chat", order_id=oid))])
    if status in CLIENT_CANCELLABLE:
        rows.append([_btn("❌ Отменить заказ", ClientOrderCb(action="cancel", order_id=oid))])
    rows.append([_btn("◀️ К списку", ClientOrderCb(action="list"))])
    return _markup(rows)


def client_cancel_confirm(order_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn("Да, отменить", ClientOrderCb(action="cancel_yes", order_id=order_id)),
                _btn("Нет", ClientOrderCb(action="view", order_id=order_id)),
            ]
        ]
    )


def offer(offer_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn("✅ Согласен", OfferCb(action="accept", offer_id=offer_id)),
                _btn("💬 Обсудить", OfferCb(action="talk", offer_id=offer_id)),
            ],
            [_btn("❌ Отказаться", OfferCb(action="decline", offer_id=offer_id))],
        ]
    )


def offer_decline_confirm(offer_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn("Да, отказаться", OfferCb(action="decline_yes", offer_id=offer_id)),
                _btn("◀️ Назад", OfferCb(action="back", offer_id=offer_id)),
            ]
        ]
    )


def pay(order_id: int) -> InlineKeyboardMarkup:
    return _markup([[_btn("✅ Я оплатил", ClientOrderCb(action="paid", order_id=order_id))]])


def receipt_cancel(order_id: int) -> InlineKeyboardMarkup:
    return _markup([[_btn("❌ Отмена", ClientOrderCb(action="receipt_cancel", order_id=order_id))]])


def accept_work(order_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [[_btn("🏁 Принять работу", ClientOrderCb(action="accept_work", order_id=order_id))]]
    )


def referral_share(link: str) -> InlineKeyboardMarkup:
    text = quote("Заказываю здесь отчёты и презентации — по ссылке скидка на первый заказ 🎁")
    url = f"https://t.me/share/url?url={quote(link)}&text={text}"
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="📤 Поделиться ссылкой", url=url)]]
    )


# ---------- исполнитель ----------


def admin_card(order: Order) -> InlineKeyboardMarkup:
    status, oid = S(order.status), order.id

    def cb(action: str) -> AdminOrderCb:
        return AdminOrderCb(action=action, order_id=oid)

    rows: Rows = []
    if status == S.NEW:
        row = [_btn("💰 Назначить цену", cb("price"))]
        if order.estimate_min:
            row.append(_btn("💡 Взять по оценке", cb("estimate")))
        rows.append(row)
    elif status in REPRICEABLE:
        rows.append([_btn("💰 Изменить цену", cb("price"))])
    if status == S.IN_PROGRESS:
        if order.is_fully_paid:
            rows.append([_btn("📎 Работа сдана", cb("deliver"))])
        else:
            rows.append([_btn("💳 Запросить остаток", cb("remainder"))])
    if status == S.PAID:
        rows.append([_btn("📎 Работа сдана", cb("deliver"))])
    if status == S.DELIVERED:
        rows.append([_btn("🏁 Закрыть заказ", cb("close"))])
    if status in ADMIN_CANCELLABLE:
        rows.append([_btn("❌ Отменить заказ", cb("cancel"))])
    return _markup(rows)


def admin_cancel_confirm(order_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn("Да, отменить", AdminOrderCb(action="cancel_yes", order_id=order_id)),
                _btn("Нет", AdminOrderCb(action="cancel_no", order_id=order_id)),
            ]
        ]
    )


def price_input_cancel(order_id: int) -> InlineKeyboardMarkup:
    return _markup([[_btn("✖️ Отмена", PricePreviewCb(action="abort", order_id=order_id))]])


def price_preview(order_id: int, price: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn(
                    "✅ Отправить клиенту",
                    PricePreviewCb(action="send", order_id=order_id, price=price),
                )
            ],
            [
                _btn("✏️ Другая цена", PricePreviewCb(action="retry", order_id=order_id)),
                _btn("✖️ Отмена", PricePreviewCb(action="abort", order_id=order_id)),
            ],
        ]
    )


def payment_check(payment_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn("✅ Подтвердить", PaymentCheckCb(action="ok", payment_id=payment_id)),
                _btn("❌ Не пришло", PaymentCheckCb(action="no", payment_id=payment_id)),
            ]
        ]
    )


def relay_file_confirm(order_id: int, message_id: int) -> InlineKeyboardMarkup:
    return _markup(
        [
            [
                _btn(
                    "📤 Отправить",
                    RelayFileCb(action="send", order_id=order_id, message_id=message_id),
                ),
                _btn(
                    "✖️ Не отправлять",
                    RelayFileCb(action="drop", order_id=order_id, message_id=message_id),
                ),
            ]
        ]
    )
