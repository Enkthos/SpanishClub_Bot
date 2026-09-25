from aiogram.types import KeyboardButton, ReplyKeyboardMarkup

from bot import texts


def main_menu() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=texts.BTN_NEW_ORDER), KeyboardButton(text=texts.BTN_MY_ORDERS)],
            [KeyboardButton(text=texts.BTN_HOW), KeyboardButton(text=texts.BTN_REFERRAL)],
            [KeyboardButton(text=texts.BTN_SUPPORT)],
        ],
        resize_keyboard=True,
        is_persistent=True,
        input_field_placeholder=texts.MENU_PLACEHOLDER,
    )


MENU_BUTTONS = frozenset(
    {texts.BTN_NEW_ORDER, texts.BTN_MY_ORDERS, texts.BTN_HOW, texts.BTN_REFERRAL, texts.BTN_SUPPORT}
)
