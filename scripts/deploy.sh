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
npm ci

echo "Verifying the release..."
npm test
npm run typecheck

echo "Reloading los-barrios-bot with PM2..."
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "Deployment completed successfully."
