# SpacetimeDB Migration Analysis for webhooks.cc

**Date:** 2026-02-24
**Status:** Analysis Complete — Migration Not Recommended

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Overview](#current-architecture-overview)
3. [SpacetimeDB Overview](#spacetimedb-overview)
4. [Component-by-Component Migration Analysis](#component-by-component-migration-analysis)
   - [Replacing Redis (Hot Path)](#1-replacing-redis-hot-path)
   - [Replacing Convex (Primary Database)](#2-replacing-convex-primary-database)
   - [Replacing ClickHouse (Analytics)](#3-replacing-clickhouse-analytics)
5. [Real-Time Capabilities: SpacetimeDB vs Convex](#real-time-capabilities-spacetimedb-vs-convex)
6. [Post-Migration Performance Estimates](#post-migration-performance-estimates)
7. [Migration Effort & Risk Assessment](#migration-effort--risk-assessment)
8. [Verdict & Recommendations](#verdict--recommendations)

---

## Executive Summary

This analysis evaluates replacing all database layers in webhooks.cc — **Convex** (primary database + application server), **Redis** (hot-path caching, buffering, quota management), and **ClickHouse** (optional analytics dual-write) — with **SpacetimeDB**.

**Verdict: Migration is not recommended.** While SpacetimeDB is an impressive technology for real-time stateful applications (particularly games), it is architecturally mismatched for webhooks.cc's workload profile. The primary concerns are:

1. **Hot-path latency regression**: Redis delivers sub-millisecond operations via pipelined commands on the same network. SpacetimeDB's WASM reducer overhead and WebSocket protocol would increase webhook capture latency from ~4ms to an estimated 15-50ms — a 4-12x regression on the most performance-critical path.

2. **No horizontal scaling**: SpacetimeDB scales vertically only (single machine, all data in RAM). webhooks.cc's architecture was designed for horizontal scalability via stateless receivers + Redis + Convex.

3. **Ecosystem immaturity for this workload**: No official Go SDK (CLI would need rewriting), no native HTTP endpoint routing (procedures are beta), no built-in OAuth/auth providers, no billing integration equivalents.

4. **Real-time parity is achievable but differently shaped**: SpacetimeDB's subscription model is query-level with automatic delta pushes — comparable to Convex's reactive queries for dashboard updates, but the migration cost to achieve parity is substantial.

---

## Current Architecture Overview

webhooks.cc uses a three-tier data architecture optimized for different access patterns:

### Tier 1: Redis (Hot Path — Sub-millisecond)
| Component | Purpose | Latency |
|-----------|---------|---------|
| `ep:{slug}` cache | Endpoint info (JSON, 300s TTL) | ~0.5ms |
| Lua quota check | Atomic decrement + check | ~1ms |
| Dedup SET NX | SHA-256 fingerprint, 2s TTL | ~1ms |
| `buf:{slug}` LPUSH | Request buffering | ~1ms |
| `buf:active` SADD | Active slug tracking | ~0.5ms |
| Circuit breaker | Redis-backed state machine | ~1ms |

**Total hot path: ~4ms** (3 pipelined Redis commands). Benchmarked at **86,000 RPS**.

### Tier 2: Convex (Warm Path — 100ms)
| Component | Purpose | Latency |
|-----------|---------|---------|
| HTTP actions | `/capture-batch`, `/quota`, `/endpoint-info` | ~100ms |
| Reactive queries | Dashboard live updates | ~50-200ms |
| Scheduled mutations | OCC-free usage increments | ~50ms |
| Cron jobs | Cleanup, billing resets | N/A |
| Auth system | GitHub/Google OAuth, device auth | ~200ms |

### Tier 3: ClickHouse (Analytics — Fire-and-Forget)
| Component | Purpose | Latency |
|-----------|---------|---------|
| Batch inserts | Analytics dual-write after flush | Fire-and-forget |
| Retention jobs | Periodic cleanup by user tier | Async mutations |

### Critical Data Flow
```
External webhook → Rust Receiver (Redis hot path, ~4ms)
  → Background flush workers (4x, Redis → Convex batch POST)
    → Convex HTTP action inserts to DB
      → Convex reactive query fires
        → Dashboard updates in real-time
```

### Key Redis Patterns That Would Need Replacement
1. **Lua scripts for atomicity**: Quota check-and-decrement, batch-take from lists, circuit breaker state transitions — all as single atomic Redis operations
2. **Pipelined commands**: 3 Redis operations in a single round-trip
3. **TTL-based caching**: Automatic expiration without cleanup logic
4. **SET NX for deduplication**: Lock-free, TTL-expiring dedup
5. **SSCAN for active slug iteration**: Memory-efficient set scanning

---

## SpacetimeDB Overview

SpacetimeDB (by Clockwork Labs) is a combined database + application server that:

- Holds **all data in memory** with WAL-based durability
- Runs application logic as **WASM modules** (Rust or TypeScript) inside the database
- Pushes **real-time updates** to connected clients via WebSocket subscriptions
- Provides **ACID transactions** via "reducers" (atomic stored procedures)
- Reached **1.0 in March 2025**, with 2.0 released in early 2026
- Powers **BitCraft Online** (MMORPG) as its primary production validation
- Claims **100-1000x** faster than traditional databases for certain workloads
- SpacetimeDB 2.0 claims **100k+ TPS for TypeScript modules, 170k+ TPS for Rust modules**

### Key Characteristics
| Attribute | SpacetimeDB |
|-----------|-------------|
| Data model | Relational (tables with indexes) |
| Query language | SQL (subscriptions) + typed query builders (2.0) |
| Server logic | WASM reducers (Rust, TypeScript, C#) |
| Client SDKs | TypeScript, Rust, C#, Python (official); Go (community only) |
| Real-time | WebSocket subscriptions with SQL WHERE filtering |
| Scaling | **Vertical only** (single machine, all data in RAM) |
| HTTP endpoints | Beta ("procedures") — cannot hold transactions during HTTP |
| Scheduled functions | Built-in via scheduled tables (interval or one-time) |
| Auth | No built-in OAuth — manual identity/token system |
| Hosting | Self-hosted or Maincloud (managed) |
| License | BSL 1.1 → AGPL v3 (with linking exception) |

---

## Component-by-Component Migration Analysis

### 1. Replacing Redis (Hot Path)

**Current Redis role:** Sub-millisecond caching, atomic Lua operations, request buffering, circuit breaker, dedup — all on the webhook capture hot path.

#### What SpacetimeDB offers
- In-memory table access with sub-microsecond reads (same-process, no network hop)
- ACID reducers for atomic operations (replaces Lua scripts)
- Tables can model lists, sets, and hash-like structures

#### What SpacetimeDB lacks for this use case

| Redis Feature | SpacetimeDB Equivalent | Gap |
|---------------|----------------------|-----|
| Pipelined commands (3 ops in 1 RTT) | Single reducer (all ops in one WASM call) | Reducer invocation overhead > pipeline overhead |
| TTL-based key expiration | No automatic row expiration; must schedule cleanup reducers | Adds complexity, no zero-config TTL |
| SET NX (lock-free dedup) | Insert with unique constraint + catch conflict | Possible but heavier |
| Lua atomic scripts | Reducers (atomic, but WASM overhead) | Functional parity, higher latency |
| LPUSH/LRANGE/LTRIM (list ops) | Table with auto-increment + range queries | Works but less ergonomic |
| SSCAN (memory-efficient iteration) | Table scan with index | Comparable |
| Separate process (isolate failures) | All in one process | Blast radius increases |

#### Critical Problem: Architecture Mismatch

The current architecture intentionally separates the hot path (Redis) from the persistent store (Convex) to achieve:
1. **Failure isolation**: Redis failure = capture degrades gracefully; Convex failure = only background flush stops
2. **Independent scaling**: Redis scales to millions of ops/sec; Convex handles complex queries
3. **At-most-once semantics**: Buffer in Redis, drain to Convex, drop on error

With SpacetimeDB, **all state lives in one process**. A slow reducer (e.g., a complex subscription update) would block or compete with the hot-path reducer. There's no way to say "this data is ephemeral/lossy" vs "this data must be durable" — everything goes through the WAL.

#### Estimated Latency Impact

| Operation | Current (Redis) | SpacetimeDB Estimate | Delta |
|-----------|----------------|---------------------|-------|
| Endpoint cache lookup | 0.5ms (GET) | 0.01ms (in-memory table) | -0.49ms |
| Quota check + decrement | 1ms (Lua script) | 0.5-2ms (reducer + WASM overhead) | +0-1ms |
| Dedup check | 1ms (SET NX) | 0.5-2ms (reducer) | +0-1ms |
| Request buffer push | 1ms (LPUSH + SADD) | 0.5-2ms (reducer insert) | +0-1ms |
| Network overhead | 1ms (TCP to Redis) | 0ms (same process) OR 5-20ms (WebSocket to SpacetimeDB) | Variable |
| **Total hot path** | **~4ms** | **2-5ms (co-located)** or **15-50ms (remote)** | **-50% to +1150%** |

The key variable is **where the Rust receiver runs relative to SpacetimeDB**:
- **Co-located (receiver is a SpacetimeDB module)**: ~2-5ms — competitive, but requires rewriting the entire receiver in WASM-compatible Rust and giving up the Axum HTTP server
- **Remote (receiver calls SpacetimeDB over WebSocket)**: ~15-50ms — significant regression due to WebSocket round-trip + WASM reducer invocation + subscription propagation

**The co-located scenario is impractical** because:
- SpacetimeDB modules can't run an HTTP server (no socket access from WASM)
- Modules can't access the filesystem or environment variables
- The receiver would need to be an external process calling SpacetimeDB, adding network latency

### 2. Replacing Convex (Primary Database)

**Current Convex role:** Persistent storage (5 tables), HTTP action endpoints, reactive queries, scheduled mutations, cron jobs, OAuth authentication, billing integration.

#### Feature Parity Assessment

| Convex Feature | SpacetimeDB Equivalent | Feasibility |
|----------------|----------------------|-------------|
| 5 relational tables | SpacetimeDB tables with indexes | Full parity |
| Compound indexes | Single-column + multi-column indexes | Full parity |
| HTTP actions (14 routes) | Procedures (beta) — HTTP endpoints | Partial (beta, can't hold transactions during HTTP) |
| Reactive queries | SQL subscriptions via WebSocket | Full parity (see real-time section) |
| Scheduled mutations (`runAfter`) | Scheduled reducers via scheduled tables | Full parity |
| Cron jobs (6 scheduled tasks) | Interval-based scheduled reducers | Full parity |
| `@convex-dev/auth` (GitHub/Google OAuth) | No built-in auth — manual token system | **Major gap** |
| `@convex-dev/rate-limiter` | Manual implementation in reducers | Feasible but manual |
| Paginated queries with cursors | SQL LIMIT/OFFSET or keyset pagination | Full parity |
| File storage | Not available | **Gap** (not currently used though) |
| Convex `.cloud` API URL | SpacetimeDB WebSocket URL | Different protocol |
| TypeScript functions (queries/mutations) | Rust or TypeScript WASM modules | Full parity |

#### Major Gaps

**1. Authentication System**
Convex provides `@convex-dev/auth` with built-in GitHub and Google OAuth providers, session management, and cross-provider email linking. SpacetimeDB has a basic identity/token system but no OAuth providers. You'd need to:
- Build OAuth flows manually or use a separate auth service (Auth0, Clerk, etc.)
- Implement session management, token refresh, and email linking from scratch
- Maintain a separate auth service alongside SpacetimeDB

**2. HTTP Action Endpoints**
The Convex backend exposes 14 HTTP action routes that the Rust receiver, CLI, and Polar billing service call directly. SpacetimeDB's "procedures" (beta) can make outbound HTTP requests but **serving as HTTP endpoints is not yet GA**. The current approach would be:
- Run a separate HTTP server (Express/Fastify) that translates HTTP requests into SpacetimeDB reducer calls
- Or wait for procedures to mature as HTTP endpoints

**3. Billing Integration**
Polar.sh webhooks currently POST to a Convex HTTP action that verifies HMAC signatures and processes subscription events. This would need a separate webhook handler service, since SpacetimeDB can't natively receive arbitrary HTTP POST requests with custom authentication.

#### Schema Migration Mapping

```
Convex Schema → SpacetimeDB Tables
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

users {                           →  #[table(name = users, public)]
  email: string                       struct Users {
  name?: string                         #[primary_key] #[auto_inc]
  image?: string                        id: u64,
  plan: "free" | "pro"                  email: String,
  polarCustomerId?: string              name: Option<String>,
  polarSubscriptionId?: string          image: Option<String>,
  subscriptionStatus?: string           plan: String,
  periodStart?: number                  polar_customer_id: Option<String>,
  periodEnd?: number                    requests_used: u32,
  requestsUsed: number                  request_limit: u32,
  requestLimit: number                  period_end: Option<u64>,
  createdAt: number                     created_at: u64,
}                                     }

endpoints {                       →  #[table(name = endpoints, public)]
  userId?: Id<"users">                struct Endpoints {
  slug: string                          #[primary_key] #[auto_inc]
  name?: string                         id: u64,
  mockResponse?: {...}                  #[unique]
  isEphemeral: boolean                  slug: String,
  expiresAt?: number                    user_id: Option<u64>,
  requestCount?: number                 name: Option<String>,
  createdAt: number                     mock_response_json: Option<String>,
}                                       is_ephemeral: bool,
                                        expires_at: Option<u64>,
                                        request_count: u32,
                                        created_at: u64,
                                      }

requests {                        →  #[table(name = requests, public)]
  endpointId: Id<"endpoints">        struct Requests {
  method: string                        #[primary_key] #[auto_inc]
  path: string                          id: u64,
  headers: Map<string,string>           endpoint_id: u64,
  body?: string                         method: String,
  queryParams: Map<string,string>       path: String,
  contentType?: string                  headers_json: String,
  ip: string                            body: Option<String>,
  size: number                          ip: String,
  receivedAt: number                    size: u32,
}                                       received_at: u64,
                                      }

apiKeys {                         →  #[table(name = api_keys, public)]
  userId: Id<"users">                struct ApiKeys {
  keyHash: string                       #[primary_key] #[auto_inc]
  keyPrefix: string                     id: u64,
  name: string                          user_id: u64,
  lastUsedAt?: number                   #[unique]
  expiresAt?: number                    key_hash: String,
  createdAt: number                     key_prefix: String,
}                                       name: String,
                                        expires_at: Option<u64>,
                                        created_at: u64,
                                      }

deviceCodes {                     →  #[table(name = device_codes, public)]
  deviceCode: string                  struct DeviceCodes {
  userCode: string                      #[primary_key] #[auto_inc]
  expiresAt: number                     id: u64,
  status: "pending"|"authorized"        #[unique]
  userId?: Id<"users">                  device_code: String,
}                                       user_code: String,
                                        status: String,
                                        user_id: Option<u64>,
                                        expires_at: u64,
                                      }
```

The schema mapping is straightforward. The main differences:
- SpacetimeDB uses auto-incrementing integer primary keys vs Convex's document IDs
- Maps/objects stored as JSON strings (SpacetimeDB has no native map type)
- Foreign keys are manual (u64 references vs Convex's typed `Id<>`)
- No native `v.union()` for plan types — use String with validation in reducers

### 3. Replacing ClickHouse (Analytics)

**Current ClickHouse role:** Optional fire-and-forget dual-write for analytics retention, with separate retention jobs.

#### SpacetimeDB Assessment

SpacetimeDB is explicitly **not designed for OLAP workloads**:

> "SpacetimeDB is optimized for maximum speed and minimum latency rather than batch processing or OLAP workloads."

ClickHouse is purpose-built for analytical queries over large datasets (billions of rows, columnar storage, compression). SpacetimeDB holds everything in RAM in row-oriented format. For analytics:

- **Small dataset** (< 1M rows): SpacetimeDB could handle it, but wastes RAM on data that's rarely queried
- **Large dataset** (> 1M rows): SpacetimeDB's RAM requirement becomes prohibitive; ClickHouse stores the same data in a fraction of the space with columnar compression

**Verdict:** ClickHouse should remain for analytics if you use it. SpacetimeDB is not a substitute for OLAP workloads.

---

## Real-Time Capabilities: SpacetimeDB vs Convex

This is the most important comparison since real-time updates are core to the webhooks.cc dashboard experience.

### How Convex Does Real-Time Today

1. Frontend calls `useQuery("requests:listNewForStream", { endpointId, afterTimestamp })` via the Convex React client
2. Convex tracks which documents the query reads (dependency tracking)
3. When any document touched by the query changes, Convex re-runs the query
4. Only the delta (new/changed results) is pushed to the client over WebSocket
5. React component re-renders with new data

**Characteristics:**
- Automatic dependency tracking (no manual subscription management)
- Query-level granularity (re-runs when any dependency changes)
- ~50-200ms latency from write to UI update
- Works with complex query logic (filters, joins via multiple queries, aggregations)
- Serverless — scales automatically

### How SpacetimeDB Does Real-Time

1. Client connects via WebSocket and subscribes with SQL: `SELECT * FROM requests WHERE endpoint_id = ? AND received_at > ?`
2. SpacetimeDB maintains a "client cache" of all matching rows
3. When a reducer inserts/updates/deletes a row matching the subscription, SpacetimeDB computes the delta
4. Delta (inserted/deleted rows) is pushed to client over WebSocket
5. Client SDK fires `onInsert`/`onUpdate`/`onDelete` callbacks; React hooks auto-update

**Characteristics:**
- SQL-based subscription queries with WHERE clause filtering
- Row-level delta computation (more efficient than re-running full queries)
- Sub-millisecond server-side processing (same-process, no network hop to DB)
- Estimated ~10-50ms latency from write to client notification (WebSocket transport)
- Supports JOINs across 2 tables in subscriptions
- Typed query builders in 2.0 (no more stringly-typed SQL)
- Views for computed/derived data
- Row-Level Security for per-client filtering

### Head-to-Head Comparison

| Aspect | Convex | SpacetimeDB | Winner |
|--------|--------|-------------|--------|
| Subscription granularity | Query-level (re-runs full query) | Row-level deltas (WHERE filter) | SpacetimeDB |
| Subscription setup | Declarative (`useQuery` hook) | SQL string or typed builder | Convex (DX) |
| Update latency (server-side) | ~50ms (re-execute query) | ~1-5ms (delta computation) | SpacetimeDB |
| End-to-end latency | ~50-200ms | ~10-50ms | SpacetimeDB |
| Complex queries | Full JS/TS query logic | SQL (limited JOINs, no subqueries) | Convex |
| React integration | First-class (`useQuery`) | `useTable` hook (newer, less mature) | Convex |
| Automatic dependency tracking | Yes (magical) | Manual (you write the SQL) | Convex |
| Scales to many clients | Serverless auto-scale | Vertical only (one machine) | Convex |
| Offline/reconnection | Built-in optimistic updates | Client cache survives reconnection | Tie |

### Real-Time Verdict

**SpacetimeDB delivers faster real-time updates** (lower latency from mutation to client notification) thanks to its in-memory architecture and row-level delta computation. For a webhook dashboard showing live incoming requests, SpacetimeDB's subscription model is well-suited:

```sql
-- SpacetimeDB subscription for live webhook requests
SELECT * FROM requests
WHERE endpoint_id = 42
  AND received_at > 1708000000000
```

Every new `INSERT` into `requests` matching this filter would automatically push to connected clients in ~10-50ms.

**However**, the overall real-time experience depends on the **full pipeline latency**:

```
Current:  webhook → Redis buffer (~4ms) → flush to Convex (~500ms) → reactive query (~100ms) = ~600ms total
SpacetimeDB: webhook → reducer insert (~15-50ms) → subscription delta (~5ms) = ~20-55ms total
```

SpacetimeDB would dramatically reduce the **end-to-end latency from webhook capture to dashboard update** (from ~600ms to ~20-55ms) because it eliminates the Redis buffering + batch flush intermediary. But this comes at the cost of hot-path latency (the time to return a response to the webhook sender).

---

## Post-Migration Performance Estimates

### Scenario: Full SpacetimeDB (Replace Redis + Convex + ClickHouse)

Assumes: SpacetimeDB self-hosted on a beefy machine (80 cores, 256GB RAM), Rust WASM module for server logic, external Rust HTTP proxy for webhook ingestion.

#### Webhook Capture (Hot Path)

| Metric | Current (Redis) | SpacetimeDB Estimate | Change |
|--------|-----------------|---------------------|--------|
| p50 latency | ~4ms | ~20-40ms | **5-10x regression** |
| p99 latency | ~10ms | ~50-100ms | **5-10x regression** |
| Max RPS (single instance) | 86,000 | ~5,000-15,000 | **5-17x regression** |
| Max sustained RPS | 3,200 | ~5,000-15,000 | **1.5-4.5x improvement** |

**Why hot-path regresses:** The receiver must call SpacetimeDB over WebSocket for each webhook (endpoint lookup + quota check + buffer insert). Each call involves WebSocket framing, WASM reducer invocation, WAL write, and subscription delta computation. Even with BSATN binary serialization, this is slower than pipelined Redis TCP commands.

**Why sustained RPS improves:** The current bottleneck at 3.2k sustained RPS is the Redis→Convex flush pipeline. With SpacetimeDB, there's no intermediary — data goes directly to the persistent store. The 86k peak RPS was a burst benchmark against Redis only; sustained throughput was limited by Convex ingestion rate.

#### Dashboard Real-Time Updates

| Metric | Current (Convex) | SpacetimeDB Estimate | Change |
|--------|------------------|---------------------|--------|
| Webhook-to-dashboard latency | ~600ms | ~25-55ms | **10-24x improvement** |
| Subscription setup time | ~100ms | ~50ms | **2x improvement** |
| Max concurrent dashboard clients | Serverless (unlimited) | ~1,000-10,000 (single machine) | **Regression** |

**Why dashboard latency improves dramatically:** Eliminates the Redis buffer → batch flush → Convex pipeline. Data goes directly from reducer insert to subscription delta push.

**Why concurrent clients regresses:** Convex auto-scales across their infrastructure. SpacetimeDB runs on one machine — each client holds a WebSocket connection and subscription state in memory.

#### Data Operations

| Metric | Current | SpacetimeDB Estimate | Change |
|--------|---------|---------------------|--------|
| Single row insert | ~5ms (Convex mutation) | ~0.01ms (in-memory) | **500x improvement** |
| Batch insert (100 rows) | ~50ms (Convex HTTP action) | ~0.5ms (single reducer) | **100x improvement** |
| Index lookup (by slug) | ~5ms (Convex query) | ~0.001ms (in-memory B-tree) | **5000x improvement** |
| Cron job cleanup (100 deletes) | ~200ms (Convex mutation) | ~1ms (single reducer) | **200x improvement** |
| Complex query (list + filter) | ~10ms (Convex query) | ~0.1ms (in-memory scan) | **100x improvement** |

**These numbers are for server-side operations only** — they don't include the network round-trip from the Rust receiver to SpacetimeDB (which adds 5-30ms).

#### Memory Requirements

| Data | Current Storage | SpacetimeDB RAM Estimate |
|------|----------------|-------------------------|
| 10,000 endpoints | Convex (managed) | ~50 MB |
| 1M requests (30-day retention) | Convex (managed) | ~2-5 GB |
| 10M requests | Convex (managed) | ~20-50 GB |
| Endpoint cache (active slugs) | Redis (~100 MB) | Included in tables |
| Quota state | Redis (~10 MB) | Included in tables |
| Request buffers | Redis (~500 MB peak) | Included in tables |

With SpacetimeDB, **all data must fit in RAM**. A production deployment with 30 days of request retention for pro users (potentially millions of rows with full headers and body) could easily require 20-50 GB of RAM. This is manageable on Maincloud (256GB machines) but expensive for self-hosting.

### Scenario: Hybrid (SpacetimeDB replaces Convex only, keep Redis)

This is the more practical scenario — use SpacetimeDB for persistent storage and real-time, keep Redis for the hot path.

| Metric | Current | Hybrid Estimate | Change |
|--------|---------|----------------|--------|
| Hot-path latency | ~4ms | ~4ms (unchanged) | **No change** |
| Hot-path RPS | 86,000 | 86,000 (unchanged) | **No change** |
| Flush latency | ~500ms (Convex HTTP) | ~5-20ms (SpacetimeDB reducer) | **25-100x improvement** |
| Sustained RPS | 3,200 | ~10,000-30,000 | **3-9x improvement** |
| Dashboard real-time | ~600ms | ~50-100ms | **6-12x improvement** |
| Concurrent clients | Unlimited (serverless) | ~1,000-10,000 | **Regression** |

**This hybrid approach preserves the hot-path performance while significantly improving flush throughput and real-time latency.** However, it still requires:
- Rewriting all Convex functions as SpacetimeDB reducers
- Building a separate auth system
- Running a separate HTTP server for webhook/CLI/billing endpoints
- Managing SpacetimeDB infrastructure (vs managed Convex)

---

## Migration Effort & Risk Assessment

### Effort Estimate

| Component | Effort | Risk | Notes |
|-----------|--------|------|-------|
| Schema migration (5 tables) | Low | Low | Straightforward relational mapping |
| Convex queries → SpacetimeDB views/subscriptions | Medium | Medium | 15+ queries to rewrite |
| Convex mutations → SpacetimeDB reducers | Medium | Medium | 20+ mutations including complex batch logic |
| HTTP actions → external HTTP server + reducer calls | High | High | 14 HTTP routes; new service to build and maintain |
| Auth system replacement | High | High | OAuth flows, session management, device auth |
| Billing integration | Medium | High | Polar webhook handler needs separate HTTP server |
| Redis hot path (if replacing Redis too) | Very High | Very High | Rewrite Rust receiver architecture entirely |
| CLI Go client (if replacing Convex HTTP) | High | Medium | No official Go SDK; use community client or HTTP API |
| SDK TypeScript client | Medium | Medium | Replace Convex HTTP calls with SpacetimeDB WebSocket |
| MCP server | Medium | Low | Wrapper around SDK changes |
| Dashboard React components | Medium | Medium | Replace `useQuery` with `useTable`/SpacetimeDB hooks |
| SSE streaming endpoint | Medium | Medium | Replace Convex polling with SpacetimeDB subscriptions |
| Cron jobs (6 tasks) | Low | Low | Scheduled reducers are well-supported |
| Tests (58+ Convex tests) | High | Medium | All tests need rewriting against new backend |
| Infrastructure/DevOps | High | High | Self-host SpacetimeDB or manage Maincloud deployment |

**Estimated total effort: 3-6 months for a full migration** (one experienced developer), with high risk of regressions on auth, billing, and hot-path performance.

### Key Risks

1. **Single point of failure**: All data in one SpacetimeDB instance vs distributed across Redis + Convex + ClickHouse
2. **RAM constraints**: All data must fit in memory; sudden traffic spikes can cause OOM
3. **No horizontal scaling**: Can't add more SpacetimeDB nodes for higher throughput
4. **Beta features dependency**: HTTP endpoints (procedures) are still beta
5. **Vendor lock-in shift**: Moving from Convex lock-in to SpacetimeDB lock-in (BSL license)
6. **Go SDK gap**: CLI would need community SDK or custom HTTP client
7. **Auth rebuild**: Most complex and highest-risk component to rebuild

---

## Verdict & Recommendations

### Do Not Migrate

The migration is **not recommended** for webhooks.cc. The current architecture is well-optimized for its workload:

1. **Redis hot path** is purpose-built for sub-millisecond webhook capture. SpacetimeDB cannot match this when running as a separate process (which it must, since WASM modules can't run HTTP servers).

2. **Convex's serverless model** handles unpredictable traffic spikes without capacity planning. SpacetimeDB requires provisioning a machine large enough for peak load + data.

3. **Convex's auth ecosystem** (`@convex-dev/auth`) provides production-ready OAuth with minimal code. Rebuilding this on SpacetimeDB is a significant undertaking.

4. **The 600ms webhook-to-dashboard latency** (the main thing SpacetimeDB would improve) is acceptable for a webhook inspection tool. Users don't need sub-100ms latency to see captured webhooks.

### If You Still Want to Improve Real-Time Latency

Consider these lower-risk alternatives instead:

1. **Direct SSE from Rust receiver**: Instead of waiting for the flush cycle, have the receiver push captured requests to connected dashboard clients immediately via SSE — before they even reach Convex. This could reduce dashboard latency to ~10ms with zero architecture changes to the DB layer.

2. **Reduce flush interval**: Currently flush workers poll every 50ms with batching. Reducing batch size or adding immediate-flush triggers could cut the ~500ms flush latency significantly.

3. **WebSocket from receiver to dashboard**: Add a lightweight pub/sub (Redis Pub/Sub or even an in-process channel) from the receiver to dashboard SSE connections. This gives "instant" updates while Convex remains the durable store.

### Where SpacetimeDB Would Be a Good Fit

SpacetimeDB would be compelling if webhooks.cc were:
- A **collaborative real-time editor** where multiple users edit shared state at game-tick speeds
- A **multiplayer application** needing sub-10ms state synchronization
- Starting from scratch with no existing auth/billing infrastructure
- Able to tolerate the limitations of a single-machine deployment

For a webhook inspection SaaS with clear tiered architecture (hot path → buffer → persistent store → dashboard), the current stack is well-suited and SpacetimeDB would introduce complexity without proportional benefit.

---

## Sources

- [SpacetimeDB Official Site](https://spacetimedb.com/)
- [SpacetimeDB GitHub](https://github.com/clockworklabs/SpacetimeDB)
- [SpacetimeDB TypeScript SDK](https://www.npmjs.com/package/spacetimedb)
- [SpacetimeDB Pricing](https://spacetimedb.com/pricing)
- [SpacetimeDB Self-Hosting Guide](https://spacetimedb.com/docs/deploying/spacetimedb-standalone/)
- [SpacetimeDB SQL Reference](https://spacetimedb.com/docs/sql/)
- [SpacetimeDB Procedures (Beta)](https://spacetimedb.com/docs/procedures/)
- [SpacetimeDB Row-Level Security](https://spacetimedb.com/docs/rls/)
- [SpacetimeDB FAQ](https://spacetimedb.com/docs/2.0.0-rc1/intro/faq/)
- [SpacetimeDB 2.0 Release Notes](https://github.com/clockworklabs/SpacetimeDB/releases)
- [SpacetimeDB New Pricing Blog](https://spacetimedb.com/blog/all-new-spacetimedb-pricing)
- [SpacetimeDB Hacker News Discussion](https://news.ycombinator.com/item?id=43631822)
- [Convex vs SpacetimeDB Comparison (Convex Blog)](https://stack.convex.dev/best-real-time-databases-compared)
- [Go SDK Request (GitHub Issue)](https://github.com/clockworklabs/SpacetimeDB/issues/2408)
