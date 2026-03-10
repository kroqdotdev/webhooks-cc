# Receiver-Side SSE Streaming for CLI Tunnels

> Status: Planned
> Created: 2026-03-08

## Problem

The CLI tunnel streaming path currently routes through Convex:

```
Webhook → Receiver → Redis → Flush → Convex → Next.js polls Convex → SSE → CLI
                                                  ↑
                                          120 function calls/min per tunnel
```

Each active CLI tunnel polls Convex every 500ms (2 queries/sec = 120 function calls/min). This is the single largest drain on the Convex function call budget and limits the number of concurrent tunnels the platform can support.

The data the CLI needs already passes through the receiver before Convex ever sees it.

## Solution: SSE on the Rust Receiver

Move real-time streaming to the receiver using Redis pub/sub:

```
Webhook → Receiver → Redis pub/sub → SSE → CLI  (real-time, zero Convex calls)
                  ↘ Redis buffer → Flush → Convex (persistence, unchanged)
```

Two additions to the receiver:

1. **Redis pub/sub** — When a webhook arrives, publish to a `stream:{slug}` channel in addition to buffering. One extra Redis command on the hot path (~0.1ms).

2. **SSE endpoint** — `GET /stream/{slug}` on the receiver. Subscribes to the Redis pub/sub channel, streams events to the CLI. Tokio handles thousands of concurrent SSE connections trivially.

## Impact

| Metric                             | Current (Convex polling) | Receiver SSE                   |
| ---------------------------------- | ------------------------ | ------------------------------ |
| Convex calls per tunnel            | 120/min                  | **0**                          |
| Latency to CLI                     | ~500ms (poll interval)   | **<5ms** (pub/sub)             |
| Concurrent tunnels at 25M calls/mo | ~5 always-on             | **Unlimited** (no Convex cost) |
| Bottleneck                         | Convex function calls    | Tokio connections (~50k+)      |

This single change removes the biggest Convex cost driver and makes tunnels essentially free from a billing perspective.

## Auth

The receiver currently only authenticates via `CAPTURE_SHARED_SECRET` (server-to-server). CLI streaming needs user-level auth. Two options:

### Option A: Validate API key at the receiver (recommended)

- CLI sends `Authorization: Bearer whcc_...` to the receiver SSE endpoint
- Receiver calls Convex once to validate the key and get the userId + endpoint ownership
- Cache the validation in Redis (e.g., `auth:{keyHash}` with 5 min TTL)
- Subsequent connections with the same key skip Convex entirely
- Key validation logic already exists in Convex (`apiKeys.validateQuery`)

### Option B: Short-lived stream token

- CLI calls Convex (via existing auth) to get a signed stream token for a specific slug
- Token is a JWT or HMAC with slug + userId + expiry (e.g., 30 min)
- CLI passes token to receiver SSE endpoint
- Receiver validates the signature locally, no Convex call needed
- Token refresh happens over existing CLI → Convex auth path

Option A is simpler — one Convex call per new connection, cached in Redis. The receiver already talks to both Redis and Convex.

## Implementation

### Receiver changes

| File                       | Change                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `handlers/stream.rs` (new) | SSE endpoint with API key auth, Redis pub/sub subscription |
| `redis/pubsub.rs` (new)    | Pub/sub subscribe + publish helpers                        |
| `handlers/webhook.rs`      | Add publish call after buffering (one line)                |
| `redis/mod.rs`             | Expose pub/sub module                                      |
| `main.rs`                  | Register `/stream/{slug}` route                            |

### CLI changes

| File                                        | Change                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `internal/tunnel/stream.go` (or equivalent) | Point SSE URL to receiver instead of web app                              |
| CLI config                                  | Use `WHK_WEBHOOK_URL` (receiver) for streaming instead of app URL         |

### Redis pub/sub data model

- Channel: `stream:{slug}`
- Message: JSON-serialized request payload (same shape as the buffered request)
- No persistence needed — pub/sub is fire-and-forget, Convex handles persistence via flush workers

### SSE endpoint spec

```
GET /stream/{slug}
Authorization: Bearer whcc_...

Response: text/event-stream
- Event: request
  Data: { method, path, headers, body, queryParams, ip, receivedAt }
- Keepalive: every 30s (comment line)
- Connection timeout: 30 min (match current behavior)
```

### Auth flow at the receiver

1. Extract `Authorization: Bearer whcc_...` header
2. Hash the key (SHA-256, same as Convex)
3. Check Redis cache: `auth:{keyHash}` → `{ userId, validUntil }`
4. On cache miss: call Convex `/validate-api-key` HTTP action (already exists)
5. Verify userId owns the endpoint for the requested slug (check `ep:{slug}` cache)
6. On success: subscribe to `stream:{slug}` pub/sub channel, begin SSE

### Rust libraries

- SSE: `axum::response::sse::Sse` with `tokio-stream` (already in dependency tree)
- Redis pub/sub: `redis` crate's async pub/sub (already using this crate)

## Future: Dashboard SSE

The same pattern could move dashboard real-time updates off Convex polling:

- Dashboard connects to receiver SSE endpoint (authenticated via session or API key)
- Same Redis pub/sub channels
- Eliminates Convex reactive query cost for active dashboard sessions

This is a larger change since dashboard auth uses Convex sessions (not API keys), but the infrastructure built for CLI streaming would be reusable.

## Migration

1. Deploy receiver with new SSE endpoint
2. Release new CLI version pointing streaming to receiver
3. Old CLI versions continue working via Next.js SSE (backwards compatible)
4. Eventually deprecate the Next.js `/api/stream/[slug]` route
