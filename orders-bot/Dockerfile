FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini .
COPY alembic ./alembic
COPY bot ./bot

RUN useradd --create-home --uid 1000 app && mkdir -p /app/data && chown -R app /app/data
USER app

CMD ["sh", "-c", "alembic upgrade head && python -m bot"]
