from functools import lru_cache

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_DB_URL = "sqlite+aiosqlite:///data/bot.db"


class DbSettings(BaseSettings):
    """Минимальный конфиг для миграций — не требует токена."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    db_url: str = DEFAULT_DB_URL


class Settings(DbSettings):
    bot_token: SecretStr
    admin_id: int
    admin_group_id: int

    payment_phone: str
    payment_bank: str
    payment_recipient: str

    redis_url: str | None = None
    timezone: str = "Europe/Moscow"
    log_level: str = "INFO"

    @field_validator("redis_url", mode="before")
    @classmethod
    def _empty_to_none(cls, value: object) -> object:
        return value or None


@lru_cache
def get_settings() -> Settings:
    return Settings()
