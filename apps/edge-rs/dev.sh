#!/bin/sh
# Runs the tunnel edge for development (make dev-edge). Previews answer at
# http://<name>.sharehooks.localhost:4000 and the CLI connects to
# ws://localhost:4000. Only EDGE_SECRET is read from .env.local, never the
# whole file; it must match the web app's.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
secret=$(grep -E '^EDGE_SECRET=' "$root/.env.local" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//")
if [ -z "$secret" ]; then
  echo "EDGE_SECRET is not set in .env.local (openssl rand -hex 32, and the same value for the web app)" >&2
  exit 1
fi
export EDGE_SECRET="$secret"
export PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-sharehooks.localhost:4000}"
export WEB_URL="${WEB_URL:-http://localhost:3000}"
export APP_URL="${APP_URL:-http://localhost:3000}"
export CONTROL_LISTEN="${CONTROL_LISTEN:-127.0.0.1:4001}"
export RELAY_LISTEN="${RELAY_LISTEN:-127.0.0.1:4002}"
export SYNC_SECONDS="${SYNC_SECONDS:-5}"
export EDGE_WORDS_FILE="${EDGE_WORDS_FILE:-$root/apps/edge-rs/words.example.json}"
cd "$root/apps/edge-rs"
exec "${CARGO:-$HOME/.cargo/bin/cargo}" run
