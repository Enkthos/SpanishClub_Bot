from aiogram import Router

from bot.handlers import admin, client_orders, common, errors, order_form, relay, service


def build_root_router() -> Router:
    root = Router(name="root")
    # Порядок важен: кнопки меню и команды — раньше анкеты, пересылка сообщений — последней
    root.include_routers(
        service.router,
        common.router,
        admin.router,
        order_form.router,
        client_orders.router,
        relay.router,
        errors.fallback_router,
    )
    return root
