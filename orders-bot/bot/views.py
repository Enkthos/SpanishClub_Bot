"""Рендер карточек и сообщений (HTML). Пользовательский ввод всегда экранируется."""

from datetime import date
from html import escape
from typing import Any

from bot import texts
from bot.config import Settings
from bot.db.models import Order, PriceOffer, User
from bot.services.clients import ClientTerms
from bot.services.money import (
    FRIEND_FIRST_ORDER_DISCOUNT,
    FRIENDS_FORMS,
    FULL_PREPAY_BELOW,
    REFERRAL_MIN_ORDER,
    REFERRAL_TIERS,
    Quote,
    fmt_rub,
    make_quote,
    next_referral_tier,
    referral_tier_discount,
)
from bot.services.order_flow import (
    REPRICEABLE,
    OrderStatus,
    admin_status,
    client_status,
    status_emoji,
)
from bot.services.pricing import get_work_type
from bot.utils import fmt_date, plural

S = OrderStatus
SEP = "━━━━━━━━━━━━━━"
DAYS_FORMS = ("день", "дня", "дней")


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def user_link(user: User) -> str:
    name = escape(user.full_name or "Без имени")
    username = f" @{escape(user.username)}" if user.username else ""
    return f'<a href="tg://user?id={user.id}">{name}</a>{username}'


def deadline_text(deadline: date, today: date) -> str:
    days = (deadline - today).days
    if days < 0:
        rel = "просрочен"
    elif days == 0:
        rel = "сегодня"
    elif days == 1:
        rel = "завтра"
    else:
        rel = f"через {days} {plural(days, DAYS_FORMS)}"
    return f"{fmt_date(deadline)} ({rel})"


def volume_text(work_type_code: str, volume: int | None) -> str | None:
    forms = get_work_type(work_type_code).unit_forms
    if not volume or forms is None:
        return None
    return f"{volume} {plural(volume, forms)}"


def _details(
    work_type: str, topic: str, volume: int | None, deadline: date, today: date
) -> list[str]:
    lines = [get_work_type(work_type).label, f"<b>Тема:</b> {escape(topic)}"]
    if vol := volume_text(work_type, volume):
        lines.append(f"<b>Объём:</b> {vol}")
    lines.append(f"<b>Срок:</b> {deadline_text(deadline, today)}")
    return lines


def _description(text: str, limit: int = 1500) -> str:
    return f"<b>Описание:</b>\n<blockquote expandable>{escape(truncate(text, limit))}</blockquote>"


def order_button_label(order: Order) -> str:
    wt = get_work_type(order.work_type)
    return truncate(f"{status_emoji(order.status)} #{order.id} · {wt.title} · {order.topic}", 60)


# ---------- анкета ----------


def form_summary(data: dict[str, Any], today: date) -> str:
    lines = [
        "📋 <b>Проверьте заявку</b>",
        "",
        *_details(
            data["work_type"],
            data["topic"],
            data.get("volume"),
            date.fromisoformat(data["deadline"]),
            today,
        ),
        _description(data["description"], limit=1000),
    ]
    if files := data.get("files"):
        lines.append(f"📎 Файлов: {len(files)}")
    return "\n".join(lines)


# ---------- карточка для исполнителя ----------

ADMIN_HINTS: dict[OrderStatus, str] = {
    S.NEW: "Назначьте цену — клиент ждёт.",
    S.AWAITING_AGREEMENT: "Цена отправлена, ждём ответа клиента.",
    S.AWAITING_PREPAY: "Клиент согласился, ждём предоплату.",
    S.PREPAY_CHECK: "Проверьте поступление и подтвердите чек в теме.",
    S.AWAITING_FINAL_PAY: "Ждём оплату остатка.",
    S.FINAL_CHECK: "Проверьте поступление и подтвердите чек в теме.",
    S.PAID: "Отправьте готовые файлы в эту тему и нажмите «Работа сдана».",
    S.DELIVERED: "Ждём, пока клиент примет работу. Можно закрыть вручную.",
}


def _admin_hint(order: Order) -> str | None:
    if order.status == S.IN_PROGRESS:
        if order.is_fully_paid:
            return "Отправьте готовые файлы в эту тему и нажмите «Работа сдана»."
        return "Когда работа готова — покажите превью и запросите остаток."
    return ADMIN_HINTS.get(S(order.status))


def admin_card(order: Order, user: User, terms: ClientTerms, today: date) -> str:
    lines = [
        f"<b>Заказ #{order.id}</b> · {admin_status(order.status)}",
        SEP,
        *_details(order.work_type, order.topic, order.volume, order.deadline, today),
        _description(order.description),
        SEP,
        f"👤 {user_link(user)}",
    ]
    kind = f"постоянный ({terms.done_orders} выполн.)" if terms.is_returning else "новый"
    if user.referrer_id:
        kind += " · по приглашению"
    lines.append(f"Клиент: {kind}")
    if order.status in REPRICEABLE:
        discount = (
            f"{terms.discount_percent}% ({terms.discount_reason})"
            if terms.discount_percent
            else "нет"
        )
        lines.append(f"Скидка: {discount}")
    if user.is_blocked:
        lines.append("⚠️ Клиент заблокировал бота")

    lines.append(SEP)
    if order.estimate_min and order.estimate_max:
        lines.append(
            f"💡 <b>Оценка:</b> {fmt_rub(order.estimate_min)} – {fmt_rub(order.estimate_max)}"
        )
        if terms.discount_percent and order.status in REPRICEABLE:
            low = make_quote(order.estimate_min, terms.discount_percent, terms.is_returning).final
            high = make_quote(order.estimate_max, terms.discount_percent, terms.is_returning).final
            lines.append(f"      со скидкой: {fmt_rub(low)} – {fmt_rub(high)}")
    else:
        lines.append("💡 Автооценка недоступна — назначьте цену вручную")

    if order.final_price is not None and order.base_price is not None:
        price = f"💰 <b>Цена:</b> {fmt_rub(order.base_price)}"
        if order.discount_percent:
            price += f" − {order.discount_percent}% = <b>{fmt_rub(order.final_price)}</b>"
        lines.append(price)
        lines.append(
            f"💳 Предоплата {order.prepay_percent}%: {fmt_rub(order.prepay_amount or 0)}"
            f" · оплачено: <b>{fmt_rub(order.paid_amount)}</b>"
        )
    if hint := _admin_hint(order):
        lines += [SEP, f"👉 <i>{hint}</i>"]
    return "\n".join(lines)


def price_preview(order: Order, quote: Quote, terms: ClientTerms) -> str:
    if quote.prepay_percent >= 100:
        reason = f"сумма меньше {fmt_rub(FULL_PREPAY_BELOW)}"
    else:
        reason = "постоянный клиент" if terms.is_returning else "новый клиент"
    discount = (
        f"{quote.discount_percent}% ({terms.discount_reason}) → −{fmt_rub(quote.discount_amount)}"
        if quote.discount_percent
        else "нет"
    )
    lines = [
        f"🧾 <b>Проверьте перед отправкой · заказ #{order.id}</b>",
        "",
        f"Цена: {fmt_rub(quote.base)}",
        f"Скидка: {discount}",
        f"Итого для клиента: <b>{fmt_rub(quote.final)}</b>",
        f"Предоплата {quote.prepay_percent}% ({reason}): {fmt_rub(quote.prepay)}",
    ]
    if quote.remainder:
        lines.append(f"Остаток: {fmt_rub(quote.remainder)}")
    return "\n".join(lines)


def support_header(user: User) -> str:
    return f"💬 <b>Поддержка</b>\n👤 {user_link(user)} · id <code>{user.id}</code>"


# ---------- клиент ----------


def client_order_card(order: Order, today: date) -> str:
    lines = [
        f"<b>Заказ #{order.id}</b>",
        f"Статус: {client_status(order.status)}",
        "",
        *_details(order.work_type, order.topic, order.volume, order.deadline, today),
    ]
    if order.final_price is not None and order.status != S.CANCELLED:
        price = f"<b>Стоимость:</b> {fmt_rub(order.final_price)}"
        if order.discount_percent:
            price += f" (скидка {order.discount_percent}%)"
        lines += ["", price]
        if order.paid_amount:
            lines.append(
                f"<b>Оплачено:</b> {fmt_rub(order.paid_amount)} из {fmt_rub(order.final_price)}"
            )
    return "\n".join(lines)


def offer_text(order: Order, offer: PriceOffer) -> str:
    wt = get_work_type(order.work_type)
    quote = Quote(
        offer.base_price,
        offer.discount_percent,
        offer.final_price,
        offer.prepay_percent,
        offer.prepay_amount,
    )
    lines = [
        f"💰 <b>Стоимость заказа #{order.id}</b>",
        f"{wt.label} «{escape(truncate(order.topic, 100))}»",
        "",
    ]
    if quote.discount_percent:
        lines += [
            f"Цена: {fmt_rub(quote.base)}",
            f"Ваша скидка {quote.discount_percent}%: −{fmt_rub(quote.discount_amount)}",
        ]
    lines += [f"<b>Итого: {fmt_rub(quote.final)}</b>", ""]
    if quote.prepay_percent >= 100:
        lines.append(f"💳 Оплата {fmt_rub(quote.final)} — до начала работы")
    else:
        lines += [
            f"💳 Предоплата {quote.prepay_percent}%: <b>{fmt_rub(quote.prepay)}</b> — "
            "после неё я приступаю",
            f"📦 Остаток {fmt_rub(quote.remainder)} — перед получением готовой работы",
        ]
    return "\n".join(lines)


def payment_text(order: Order, amount: int, is_final: bool, settings: Settings) -> str:
    if is_final:
        title = "Оплата остатка"
    elif (order.prepay_percent or 0) >= 100:
        title = "Оплата"
    else:
        title = "Предоплата"
    return (
        f"💳 <b>{title} по заказу #{order.id}: {fmt_rub(amount)}</b>\n\n"
        "Переведите по номеру телефона:\n"
        f"📱 <code>{escape(settings.payment_phone)}</code>\n"
        f"🏦 {escape(settings.payment_bank)}\n"
        f"👤 {escape(settings.payment_recipient)}\n\n"
        f"В комментарии укажите: <code>Заказ #{order.id}</code>\n\n"
        "После перевода нажмите «✅ Я оплатил» и пришлите скриншот чека."
    )


def referral_text(link: str, qualified: int, invited: int) -> str:
    tiers = []
    for need, percent in reversed(REFERRAL_TIERS):
        mark = "✅" if qualified >= need else "▫️"
        tiers.append(f"{mark} {need} {plural(need, FRIENDS_FORMS)} — скидка {percent}%")
    current = referral_tier_discount(qualified)
    nxt = next_referral_tier(qualified)
    progress = (
        f"Ещё {nxt[0]} {plural(nxt[0], FRIENDS_FORMS)} — и скидка {nxt[1]}%"
        if nxt
        else "🏆 У вас максимальная скидка"
    )
    return "\n".join(
        [
            "🎁 <b>Приглашайте друзей — получайте скидку</b>",
            "",
            *tiers,
            "",
            "Друг засчитывается, когда получит свой первый заказ "
            f"от {fmt_rub(REFERRAL_MIN_ORDER)}.",
            "Скидка постоянная и действует на все ваши заказы.",
            f"Другу — скидка {FRIEND_FIRST_ORDER_DISCOUNT}% на первый заказ.",
            "",
            "<b>Ваш прогресс</b>",
            f"Приглашено: {invited} · засчитано: {qualified}",
            f"Текущая скидка: <b>{current}%</b>",
            progress,
            "",
            "Ваша ссылка:",
            f"<code>{escape(link)}</code>",
        ]
    )


def welcome(user: User, invited: bool) -> str:
    text = texts.WELCOME.format(name=escape(user.full_name or "друг"))
    if invited:
        text += texts.WELCOME_INVITED.format(percent=FRIEND_FIRST_ORDER_DISCOUNT)
    return text
