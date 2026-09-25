# Orders bot — plan & execution prompts

## Decisions (approved)
- Python 3.11, aiogram 3.x, SQLAlchemy 2 async + SQLite (aiosqlite), Alembic, pydantic-settings, Redis FSM on prod, long-polling on VPS, Docker Compose.
- Single executor (ADMIN_ID). Chat with clients via private forum supergroup: 1 topic per order + 1 support topic per client; bot relays messages both ways.
- Estimate (price list × volume × urgency, ±15%) visible ONLY to admin in order card. Client waits for admin's price.
- Admin sets price → preview (discount, prepay) → confirm → client: Accept / Discuss / Decline. New offer invalidates old buttons.
- Payment: transfer by phone number, client sends receipt, admin confirms. Prepay: new client 50%, returning (≥1 done order) 25%, final price < 1000 ₽ → 100%. Remainder before final delivery.
- Referral: friend qualifies when their order is DONE and final ≥ 500 ₽. Tiers 1→10%, 2→15%, 4→20%, permanent, max 20%. Invited friend: 5% on first order. Discounts don't stack (max wins).
- Russian only. Price list = editable stubs in `bot/services/pricing.py`.

## Prompts

### P1 — Scaffold
Goal: runnable skeleton. Files: requirements*.txt, pyproject.toml (ruff/mypy/pytest), .gitignore, .env.example, bot/config.py, bot/__main__.py. Details: secrets only via env; HTML parse mode; RetryAfter request middleware. Done: `python -m bot` starts with valid .env. Self-check: no secrets in repo, .gitignore covers .env*, data/, *.db.

### P2 — Domain core (pure)
Goal: pricing, money rules, order state machine. Files: bot/services/{pricing,money,order_flow}.py, bot/utils.py, tests. Details: integer rubles; transitions table is single source of truth; parse_price/parse_deadline robust. Done: unit tests pass. Self-check: boundary values (999/1000 ₽, 500 ₽, tiers 1/2/3/4, today/past dates, "2 000 ₽").

### P3 — DB
Goal: models, session, repo with atomic conditional transitions, Alembic init migration. Files: bot/db/*, alembic/*, tests/test_repo.py. Details: `UPDATE … WHERE status IN (allowed)` + rowcount; offer accept/payment resolve are single-transaction; user upsert race-safe. Done: migration applies on empty DB; repo tests pass. Self-check: double accept/double confirm return False/None.

### P4 — UI layer
Goal: texts, views (cards), keyboards, callback factories, states, filters, middlewares. Details: all strings in texts.py; html-escape user input; card keyboards derive from status.

### P5 — Client flows
Goal: /start + referral binding, menu, order form FSM (back/cancel, files with per-user lock), my orders, offer accept/discuss/decline, payment receipt, accept work. Done: happy path + stale buttons answered gracefully.

### P6 — Admin flows & relay
Goal: topic + card per order (pinned, renamed with status emoji), price input FSM (USER_IN_TOPIC), preview, payment confirm/reject, request remainder, deliver, close, cancel with confirm, /orders /stats /id; two-way relay; documents to not-fully-paid order require confirm. Done: full scenario is consistent across card, topic name and client messages.

### P7 — Hardening & deploy
Goal: error handler, throttling, blocked-user handling, fallback for stale callbacks, Dockerfile, docker-compose (bot+redis), README (BotFather, group setup, env, run, deploy). Done: ruff + mypy + pytest green; import smoke test builds Dispatcher.
