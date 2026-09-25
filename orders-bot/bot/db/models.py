from datetime import UTC, date, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from bot.services.order_flow import OrderStatus


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class PaymentKind(StrEnum):
    PREPAY = "prepay"
    FINAL = "final"


class PaymentStatus(StrEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    username: Mapped[str | None] = mapped_column(String(64))
    full_name: Mapped[str] = mapped_column(String(256), default="")
    ref_code: Mapped[str] = mapped_column(String(16), unique=True)
    referrer_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), index=True)
    # Куда уходят сообщения клиента: заказ или (если None) тема поддержки
    active_order_id: Mapped[int | None] = mapped_column(Integer)
    support_thread_id: Mapped[int | None] = mapped_column(Integer, index=True)
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), index=True)
    work_type: Mapped[str] = mapped_column(String(32))
    topic: Mapped[str] = mapped_column(String(256))
    volume: Mapped[int | None] = mapped_column(Integer)
    deadline: Mapped[date] = mapped_column(Date)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default=OrderStatus.NEW, index=True)

    estimate_min: Mapped[int | None] = mapped_column(Integer)
    estimate_max: Mapped[int | None] = mapped_column(Integer)

    base_price: Mapped[int | None] = mapped_column(Integer)
    discount_percent: Mapped[int] = mapped_column(Integer, default=0)
    final_price: Mapped[int | None] = mapped_column(Integer)
    prepay_percent: Mapped[int | None] = mapped_column(Integer)
    prepay_amount: Mapped[int | None] = mapped_column(Integer)
    paid_amount: Mapped[int] = mapped_column(Integer, default=0)

    thread_id: Mapped[int | None] = mapped_column(Integer, index=True)
    card_message_id: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    @property
    def is_fully_paid(self) -> bool:
        return self.final_price is not None and self.paid_amount >= self.final_price

    @property
    def remainder(self) -> int:
        return max(0, (self.final_price or 0) - self.paid_amount)


class PriceOffer(Base):
    __tablename__ = "price_offers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(Integer, ForeignKey("orders.id"), index=True)
    base_price: Mapped[int] = mapped_column(Integer)
    discount_percent: Mapped[int] = mapped_column(Integer)
    final_price: Mapped[int] = mapped_column(Integer)
    prepay_percent: Mapped[int] = mapped_column(Integer)
    prepay_amount: Mapped[int] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    client_message_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(Integer, ForeignKey("orders.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    amount: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default=PaymentStatus.PENDING)
    receipt_file_id: Mapped[str] = mapped_column(String(256))
    receipt_is_photo: Mapped[bool] = mapped_column(Boolean, default=True)
    admin_message_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OrderFile(Base):
    __tablename__ = "order_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(Integer, ForeignKey("orders.id"), index=True)
    file_id: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(16))  # photo | document
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
