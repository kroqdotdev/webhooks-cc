# Receiver Simplification: Drop Redis + ClickHouse, Direct Postgres

Date: 2026-03-15
Phase: 5 of Supabase migration

## Goal

Replace the Redis-buffered, ClickHouse-backed Rust receiver with a simplified
architecture that writes directly to Postgres via a single stored procedure.
Remove all intermediate state (Redis cache, request buffers, flush workers,
circuit breaker, cache warmer, ClickHouse dual-write).

## Architecture

```
Webhook POST /w/{slug}/path
  → Axum handler
  → Postgres RPC: capture_webhook(slug, method, path, headers, body, ...)
  → Return mock response or 200 OK
```

One database round-trip per webhook. No background workers.

## Stored Procedure: `capture_webhook`

```sql
capture_webhook(
  p_slug text,
  p_method text,
  p_path text,
  p_headers jsonb,
  p_body text,
  p_query_params jsonb,
  p_content_type text,
  p_ip text,
  p_received_at timestamptz
) → jsonb
```

Steps (single transaction):
1. Look up endpoint by slug → `not_found` if missing
2. Check `expires_at` → `expired` if past
3. Resolve quota:
   - Ephemeral (no user): check `endpoint.request_count` vs 25
   - Owned free user with expired/no period: start new 24h period lazily
   - Owned: check `user.requests_used` vs `user.request_limit`
4. If quota exceeded → return `quota_exceeded` with `retry_after`
5. INSERT request row
6. Increment `endpoint.request_count`; if owned, increment `user.requests_used`
7. Return `ok` with `mock_response` (if configured)

Return shape (jsonb):
```json
{
  "status": "ok|not_found|expired|quota_exceeded",
  "mock_response": { "status": 200, "body": "...", "headers": {} } | null,
  "retry_after": null | <ms>
}
```

## Rust Receiver

### Files

| File | Purpose |
|------|---------|
| `main.rs` | Axum setup, PgPool creation, route registration |
| `config.rs` | `DATABASE_URL`, `CAPTURE_SHARED_SECRET`, `PORT`, `RECEIVER_DEBUG` |
| `handlers/webhook.rs` | Hot path: call stored procedure, map result to HTTP response |
| `handlers/health.rs` | Pool connectivity check |

### AppState

```rust
struct AppState {
    pool: PgPool,
    config: Config,
}
```

### Dependencies

Remove: `redis`, `reqwest`, `sha2`, `subtle`
Add: `sqlx` (postgres, runtime-tokio, tls-rustls)
Keep: `axum`, `tokio`, `serde`, `serde_json`, `tracing`, `tower-http`, `bytes`, `http`

### What carries over unchanged

- Route structure: `/w/{slug}` and `/w/{slug}/{*path}`, all HTTP methods
- Slug validation: `^[A-Za-z0-9_-]{1,50}$`
- IP extraction: cf-connecting-ip → x-real-ip → x-forwarded-for → socket
- Header filtering: strip proxy headers before storing
- Mock response builder: status/body/headers, block security headers, CRLF validation
- Body size limit: 1MB (tower-http)
- CORS: permissive for public routes
- Structured logging: tracing with JSON output

### What gets removed

- Entire `redis/` module (cache, quota, buffer, dedup)
- Entire `convex/` module (HTTP client, types, circuit breaker)
- All background workers (flush, cache warmer, ClickHouse retention)
- Search handlers (`/search`, `/search/count`) — already served by Next.js
- Cache invalidation handler — no cache
- Dedup fingerprinting — acceptable loss, can add Postgres-level dedup later

## Config

| Env var | Required | Purpose |
|---------|----------|---------|
| `DATABASE_URL` | yes | Postgres connection string (pooler) |
| `CAPTURE_SHARED_SECRET` | yes | Not used on hot path but kept for health/internal auth |
| `PORT` | no | Default 3001 |
| `RECEIVER_DEBUG` | no | Debug logging |
| `RECEIVER_LOG_DIR` | no | Log file directory |
| `PG_POOL_MIN` | no | Min pool connections (default 5) |
| `PG_POOL_MAX` | no | Max pool connections (default 20) |

## Implementation Order

1. Write the `capture_webhook` stored procedure (new migration 00010)
2. Apply and test it with manual SQL calls
3. Rewrite the Rust receiver (replace all src/ files)
4. Test end-to-end: send webhook → check it appears in dashboard
5. Remove bridge routes (`/api/internal/receiver/*`) — no longer needed
6. Remove receiver Redis/ClickHouse env vars from .env.local
7. Update CLAUDE.md to reflect simplified architecture

## Migration Notes

- The existing bridge routes continue working during development
- The receiver can be tested against the dev Supabase Postgres pooler
- `DATABASE_URL` should use the session pooler for transaction-mode compatibility
- Systemd service restart required after rebuild: `make build-receiver && sudo systemctl restart webhooks-receiver`
