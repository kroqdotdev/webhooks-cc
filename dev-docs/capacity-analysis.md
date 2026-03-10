# Capacity & Scaling Analysis

> Last updated: 2026-03-08
> Convex plan: Pro ($25/dev/month)

## Current Infrastructure

| Component    | Spec                                                 |
| ------------ | ---------------------------------------------------- |
| **LXC**      | 16 cores, 8 GB RAM, 30 GB disk                       |
| **Receiver** | Rust binary, ~10 MB RSS, 17 threads, 4 flush workers |
| **Next.js**  | ~228 MB RSS                                          |
| **Redis**    | Separate host, Redis 8.4, no maxmemory set           |
| **Convex**   | Pro plan — managed backend                           |

## Convex Pro Plan Limits

| Resource                   | Included/month | Overage            |
| -------------------------- | -------------- | ------------------ |
| Function calls             | 25,000,000     | $2 per 1,000,000   |
| Action compute             | 250 GB-hours   | $0.30 per GB-hour  |
| Database storage           | 50 GB          | $0.20 per GB/month |
| Database bandwidth         | 50 GB          | $0.20 per GB       |
| File storage               | 100 GB         | $0.03 per GB/month |
| File bandwidth             | 50 GB          | $0.30 per GB       |
| Query/Mutation concurrency | 256+           | —                  |
| Action concurrency         | 256+           | —                  |
| HTTP Action concurrency    | 128+           | —                  |

## Layer-by-Layer Bottleneck Analysis

### 1. Rust Receiver — NOT a bottleneck

- Benchmarked at ~86k RPS. At 10 MB RSS it barely uses resources.
- Hot path is 3 pipelined Redis commands (~0.3ms).
- The Tokio runtime has headroom for 100k+ RPS on current hardware.
- Even at 24/7 sustained load, it can handle far more than Convex can absorb.

### 2. Redis — NOT a bottleneck at any realistic scale

- Minimal memory usage currently. Even 50k concurrent buffered requests (~2-5 KB each) would only be ~250 MB.
- `maxmemory` is currently unset — should be configured to prevent runaway usage.
- Single-threaded Redis 8.4 handles ~100k ops/sec.
- Lua scripts (quota check, batch take) are fast atomic operations.

### 3. Next.js / SSE Streaming — moderate concern at scale

- Each CLI tunnel or dashboard SSE connection holds an open HTTP connection and polls Convex every 500ms.
- Node.js single-process can handle ~5,000-10,000 concurrent SSE connections before event loop pressure.
- Each SSE connection = 2 Convex queries/sec = **120 function calls/min per connection**.
- 100 concurrent SSE connections = 720k Convex function calls/hour.
- CLI tunnels are expensive in Convex function calls — this is the "silent killer" of budget.

### 4. Convex Pro — THE bottleneck

This is where the ceiling lives.

| Resource                          | Cost per webhook                                                 | Monthly capacity before overage |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| **Function calls** (25M)          | Capture: ~2.5/webhook, SSE: 120/min/conn, Dashboard: ~50/session | **5-8M webhooks**               |
| **DB bandwidth** (50 GB)          | Write: ~3 KB, Read: ~3-6 KB per webhook viewed                   | **5-7M webhooks**               |
| **DB storage** (50 GB)            | ~3 KB/request, 30-day retention                                  | ~16M stored at any time         |
| **HTTP action concurrency** (128) | Flush workers + SSE + dashboard                                  | ~200-300 concurrent users max   |

#### Function call breakdown per webhook

Each captured webhook triggers (via flush worker batch):

1. 1 HTTP action (`/capture-batch`)
2. ~1 mutation per request in batch (store to `requests` table)
3. ~1 scheduled mutation per request (usage increment via `runAfter(0)`)

With average batch size of 5-10 requests: **~2.2-2.5 function calls per webhook**.

## Total User Estimates

### Registered users (stored in DB)

Each user record is ~0.5 KB. Even 500,000 users = 250 MB of storage.

**Storage is not the limit. 50,000-100,000+ registered users are easily supported.**

### Monthly Active Users (MAU)

Convex function call consumption per user type:

| User type                                               | Convex calls/month | DB bandwidth/month |
| ------------------------------------------------------- | ------------------ | ------------------ |
| **Casual** (checks dashboard 2-3x/month, <100 webhooks) | ~500               | ~1 MB              |
| **Regular** (daily use, ~1,000 webhooks/month)          | ~5,000             | ~10 MB             |
| **Heavy** (CLI tunnel 2hrs/day, ~10,000 webhooks/month) | ~250,000           | ~100 MB            |
| **Power** (always-on tunnel, 50,000+ webhooks/month)    | ~1,000,000+        | ~500 MB            |

MAU estimates against the 25M function call budget:

| User mix                                     | Supported MAU  |
| -------------------------------------------- | -------------- |
| All casual                                   | ~50,000        |
| 80% casual, 15% regular, 5% heavy            | ~10,000-15,000 |
| 60% casual, 25% regular, 10% heavy, 5% power | ~3,000-5,000   |
| Lots of CLI tunnel users                     | ~1,000-2,000   |

## Bottlenecks Ranked

1. **Convex function calls (25M/month)** — SSE polling is the silent killer. Each active tunnel/stream burns 120 calls/min.
2. **Convex DB bandwidth (50 GB/month)** — every write + read costs bandwidth.
3. **Convex HTTP action concurrency (128)** — hard limit on simultaneous requests hitting Convex.
4. **Host RAM** — Next.js + receiver leaves headroom, but under heavy load with many SSE connections, Node.js memory grows.
5. **Redis, CPU, receiver binary** — not bottlenecks at any realistic scale.

## Improvements to Increase Capacity

### High impact — Convex cost reduction

| Change                                                            | Impact                                                      | Effort            |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | ----------------- |
| **Increase SSE poll interval** from 500ms to 2-5s                 | Cuts SSE function calls by 4-10x. Biggest single win.       | Trivial           |
| **Use Convex reactive queries** instead of polling for SSE        | Eliminates polling entirely — only fires on actual changes. | Medium            |
| **Increase flush batch size** (`BATCH_MAX_SIZE` from 50 to 200)   | Fewer HTTP action calls per webhook.                        | Trivial (env var) |
| **Increase flush interval** (`FLUSH_INTERVAL_MS` from 100 to 500) | Larger natural batches, fewer Convex round-trips.           | Trivial (env var) |
| **Reduce free retention** from 7 days to 3 days                   | Less DB storage and bandwidth from cleanup queries.         | Trivial (config)  |
| **Truncate large request bodies** (e.g., cap at 16 KB)            | Directly reduces DB bandwidth and storage.                  | Small             |

### Medium impact — infrastructure

| Change                                                      | Impact                                               | Effort       |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| **Set Redis `maxmemory`** (e.g., 512 MB with `allkeys-lru`) | Prevents runaway memory.                             | Trivial      |
| **Scale host RAM to 32 GB+**                                | Lets Node.js handle more concurrent SSE connections. | Trivial      |
| **Run Next.js in cluster mode** (PM2 or similar)            | Multiple Node.js workers for SSE concurrency.        | Small        |
| **Move to Convex reactive subscriptions for CLI**           | Eliminates polling overhead entirely.                | Medium-Large |

### Low priority — already overprovisioned

- More CPU cores — barely using current allocation.
- More flush workers — 4 is fine for millions/day.
- Redis optimization — minimal memory usage.

## Overage Cost Projections

Convex overage pricing is gentle and scales linearly:

| Scale                    | Est. monthly Convex overage |
| ------------------------ | --------------------------- |
| 5,000 MAU, 5M webhooks   | ~$0 (within included)       |
| 10,000 MAU, 10M webhooks | ~$15-25                     |
| 20,000 MAU, 20M webhooks | ~$50-80                     |
| 50,000 MAU, 50M webhooks | ~$150-250                   |

Approximate cost per additional 1M webhooks beyond included: **~$2-5**.

## Summary

| Metric                     | Current capacity (no changes) | With SSE poll fix                          |
| -------------------------- | ----------------------------- | ------------------------------------------ |
| **Total registered users** | 30,000-60,000                 | 50,000-100,000+                            |
| **Monthly active users**   | 5,000-10,000                  | 10,000-20,000                              |
| **Webhooks/month**         | 5-8M                          | 5-8M (Convex is the ceiling, not receiver) |

The Rust receiver can handle 10x the traffic that Convex can absorb. Scaling host hardware will not meaningfully change capacity — Convex is the ceiling, and it is a soft ceiling with reasonable overage pricing. Hardware scaling (more cores, 32-48 GB RAM) would only matter for SSE connection concurrency in Node.js, not for webhook throughput.
