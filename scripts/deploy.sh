#!/usr/bin/env bash

set -Eeuo pipefail

BRANCH="${1:-main}"
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

cd "$PROJECT_DIR"

for program in git node npm pm2; do
  if ! command -v "$program" >/dev/null 2>&1; then
    echo "Required command is missing: $program" >&2
    exit 1
  fi
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it from .env.example before deploying." >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  echo "Current branch is '$CURRENT_BRANCH'; expected '$BRANCH'." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked files have local changes. Commit or stash them before deploying." >&2
  exit 1
fi

ENV_BACKUP="$(mktemp "${TMPDIR:-/tmp}/los-barrios-env.XXXXXX")"
cp -- "$ENV_FILE" "$ENV_BACKUP"
chmod 600 "$ENV_BACKUP"

restore_env() {
  cp -- "$ENV_BACKUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  rm -f -- "$ENV_BACKUP"
}
trap restore_env EXIT

echo "Fetching origin/$BRANCH..."
git fetch origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"

# The local deployment credentials always win over repository contents.
cp -- "$ENV_BACKUP" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Installing locked dependencies..."
npm ci --include=dev

echo "Verifying the release..."
npm test
npm run typecheck
npm run build

if [[ ! -f "$PROJECT_DIR/dist/bot.js" ]]; then
  echo "Build completed without creating dist/bot.js." >&2
  exit 1
fi

echo "Removing development-only dependencies..."
npm prune --omit=dev

echo "Reloading los-barrios-bot with PM2..."
if pm2 describe los-barrios-bot >/dev/null 2>&1; then
  # Recreate the process so changes to script/interpreter paths take effect.
  pm2 delete los-barrios-bot
fi
pm2 start ecosystem.config.cjs
pm2 save

echo "Deployment completed successfully."
