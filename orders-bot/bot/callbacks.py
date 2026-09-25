from aiogram.filters.callback_data import CallbackData


class FormCb(CallbackData, prefix="fm"):
    # type | vol | dl | files_done | submit | back | cancel
    action: str
    value: str = ""


class ClientOrderCb(CallbackData, prefix="co"):
    # list | view | chat | cancel | cancel_yes | offer
    # pay_info | paid | receipt_cancel | accept_work
    action: str
    order_id: int = 0


class OfferCb(CallbackData, prefix="of"):
    # accept | talk | decline | decline_yes | back
    action: str
    offer_id: int


class AdminOrderCb(CallbackData, prefix="ao"):
    # price | estimate | cancel | cancel_yes | cancel_no | remainder | deliver | close
    action: str
    order_id: int


class PricePreviewCb(CallbackData, prefix="pp"):
    # send | retry | abort
    action: str
    order_id: int
    price: int = 0


class PaymentCheckCb(CallbackData, prefix="pc"):
    # ok | no
    action: str
    payment_id: int


class RelayFileCb(CallbackData, prefix="rf"):
    # send | drop
    action: str
    order_id: int
    message_id: int
