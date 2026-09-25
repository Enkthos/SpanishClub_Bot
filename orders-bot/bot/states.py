from aiogram.fsm.state import State, StatesGroup


class OrderForm(StatesGroup):
    work_type = State()
    topic = State()
    volume = State()
    deadline = State()
    description = State()
    files = State()
    confirm = State()


class ClientReceipt(StatesGroup):
    waiting = State()


class AdminPrice(StatesGroup):
    waiting = State()
