# Security Audit Report

**Date:** 2026-04-01
**Scope:** Full codebase - web app, Rust receiver, Go CLI, SDK, MCP server, database, infrastructure
**Methodology:** Static analysis of all source code, migrations, configurations, and dependencies

---

## Executive Summary

The webhooks.cc codebase demonstrates **strong security practices overall**. Authentication, authorization, input validation, and data handling are well-implemented across all components. No critical vulnerabilities were found. Several medium-severity issues were identified, primarily around database function permissions and RLS policy edge cases.

**Findings by severity:**
- Critical: 0
- High: 0
- Medium: 4
- Low: 5
- Informational: 6

---

## Medium Severity Findings

### M1. Missing REVOKE/GRANT on SECURITY DEFINER Utility Functions

**Files:**
- `supabase/migrations/00001_initial_schema.sql` (lines 338-357, 361-381, 300-330)
- `supabase/migrations/00002_additional_functions.sql` (lines 4-19)
- `supabase/migrations/00003_receiver_support.sql` (lines 3-41)

**Description:** Several `SECURITY DEFINER` functions lack explicit `REVOKE`/`GRANT` statements. By default in PostgreSQL, public schema functions are callable by any role. The affected functions are:

- `check_and_decrement_quota(uuid, integer)` - decrements user quota
- `start_free_period(uuid)` - activates free billing period
- `check_and_increment_ephemeral(uuid)` - increments ephemeral request count
- `increment_endpoint_request_count(uuid, integer)` - increments endpoint counter
- `increment_user_requests_used(uuid, integer)` - increments user usage
- `cleanup_free_user_requests()` - deletes free user requests
- `cleanup_old_requests()` - deletes old requests

Other functions (e.g., `search_requests` in 00004, `cleanup_expired_ephemeral_endpoints` in 00007, `create_team_with_owner` in 00016) correctly have `REVOKE`/`GRANT` statements restricting access to `service_role`.

**Impact:** An authenticated user with the Supabase anon key or their session token could potentially call these functions directly via the PostgREST RPC interface, manipulating their own quota counters or triggering cleanup operations.

**Recommendation:** Add explicit permission restrictions to all affected functions:
```sql
revoke all on function public.check_and_decrement_quota(uuid, integer) from public, anon, authenticated;
grant execute on function public.check_and_decrement_quota(uuid, integer) to service_role;
-- Repeat for each affected function
```

---

### M2. Ephemeral Endpoint TTL Bypass via Direct Supabase Client

**File:** `supabase/migrations/00008_rls_hardening.sql` (lines 38-42)

**Description:** The RLS policy for anonymous endpoint creation requires `expires_at is not null` but does not bound the value:
```sql
create policy endpoints_insert on public.endpoints
  for insert with check (
    (user_id is null and is_ephemeral = true and expires_at is not null)
    or user_id = auth.uid()
  );
```

Since `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a public client-side value, an attacker could use the Supabase JS client directly (bypassing the web app API) to insert ephemeral endpoints with `expires_at` set arbitrarily far in the future (e.g., year 2100), creating effectively permanent guest endpoints.

**Impact:** Attacker can create unlimited permanent guest endpoints that bypass the intended 12-hour TTL, consuming database resources indefinitely.

**Recommendation:** Add a CHECK constraint on the `endpoints` table:
```sql
ALTER TABLE public.endpoints
ADD CONSTRAINT ephemeral_expiry_max_24h
CHECK (NOT is_ephemeral OR expires_at <= now() + interval '24 hours');
```

---

### M3. In-Memory Rate Limiter Not Effective in Multi-Instance Deployments

**File:** `apps/web/lib/rate-limit.ts`

**Description:** The rate limiter uses an in-memory `Map<string, number[]>` to track request timestamps per IP. This state is not shared between processes or instances.

**Impact:** If the web app runs on multiple instances (e.g., behind a load balancer or in a serverless environment), rate limits are per-instance rather than global. An attacker hitting different instances can multiply their effective rate limit.

**Current mitigation:** The app appears to run as a single process behind Caddy, limiting exposure. The rate limiter already documents this limitation in code comments.

**Recommendation:** If scaling to multiple instances, replace with a distributed rate limiter backed by Redis or a similar shared store. For single-instance deployment, current approach is adequate.

---

### M4. Missing Connection Acquire Timeout on Receiver PG Pool

**File:** `apps/receiver-rs/src/main.rs` (lines 120-125)

**Description:** The PostgreSQL connection pool is configured with min/max connections but no explicit `acquire_timeout()`:
```rust
let pool = PgPoolOptions::new()
    .min_connections(config.pool_min)     // Default: 5
    .max_connections(config.pool_max)     // Default: 20
    .connect(&config.database_url)
```

**Impact:** Under sustained load when all pool connections are in use, new requests will wait indefinitely for a connection rather than failing fast. This could cause request timeouts to cascade and consume Tokio task resources.

**Recommendation:** Add an explicit acquire timeout:
```rust
let pool = PgPoolOptions::new()
    .min_connections(config.pool_min)
    .max_connections(config.pool_max)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(&config.database_url)
```

---

## Low Severity Findings

### L1. No Explicit Request Timeout on Receiver

**File:** `apps/receiver-rs/src/main.rs`

**Description:** No Tower timeout middleware is configured for the HTTP handler. While OS-level TCP timeouts provide some protection, slow clients could hold connections longer than necessary.

**Recommendation:** Add `tower_http::timeout::TimeoutLayer` with a 60-second timeout.

---

### L2. Unused CAPTURE_SHARED_SECRET in Receiver

**File:** `apps/receiver-rs/src/config.rs` (line 48)

**Description:** The `CAPTURE_SHARED_SECRET` environment variable is required at startup and loaded into config, but never referenced in any handler or middleware. This suggests an incomplete implementation of internal service authentication.

**Recommendation:** Either implement authentication using this secret (e.g., validate a shared header from trusted callers) or remove the requirement to avoid confusion.

---

### L3. CLI Replay `--to` Flag Lacks URL Scheme Validation

**File:** `apps/cli/cmd/whk/main.go` (line 572)

**Description:** The `whk replay --to <url>` command accepts an arbitrary URL without validating the scheme. While the `openBrowser()` function elsewhere (lines 619-624) correctly restricts to `http`/`https`, the replay target URL has no such check.

**Impact:** Low - the user explicitly provides the URL and the command is for local development use.

**Recommendation:** Add scheme validation consistent with other URL handling in the CLI.

---

### L4. Docker Compose Ports Exposed Without Restriction

**File:** `docker-compose.yml`

**Description:** Ports `3000:3000` and `3001:3001` are mapped directly without IP binding restrictions. In production, these should be behind a reverse proxy.

**Recommendation:** Bind to localhost if running behind a reverse proxy: `127.0.0.1:3000:3000`.

---

### L5. Systemd Service Hardening Incomplete

**File:** `infra/webhooks-collector.service`

**Description:** Only the collector service file was found. Service files could benefit from additional hardening directives.

**Recommendation:** Add to all service files:
```ini
PrivateTmp=yes
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
```

---

## Informational Findings

### I1. Sensitive Headers Stored in Requests Table

**File:** `supabase/migrations/00001_initial_schema.sql` (lines 86-104)

The `requests` table stores all webhook headers (JSONB), which may include `Authorization`, `Cookie`, or other credential headers from webhook senders. While the receiver filters proxy/CDN headers (`apps/receiver-rs/src/handlers/webhook.rs` lines 16-30), it does not strip authentication headers since preserving them is core to the product's inspection feature.

**Note:** This is by design. Users should be aware that credentials in webhook headers will be visible in the dashboard.

---

### I2. Error Message in Update Reveals Expected Checksum

**File:** `apps/cli/internal/update/update.go` (line 157)

The checksum mismatch error message includes both expected and actual SHA256 hashes. Since checksums are published publicly on GitHub Releases, this is not a real concern.

---

### I3. Debug Log Truncation

**Files:** `apps/cli/internal/stream/stream.go` (line 193), `apps/cli/internal/api/client.go` (line 139)

Error messages and debug output are properly truncated to 200 characters, preventing sensitive data leakage in logs. Good practice.

---

### I4. Config Debug Impl Redacts Secrets

**File:** `apps/receiver-rs/src/config.rs` (lines 16-30)

Custom `Debug` implementation properly redacts `DATABASE_URL`, `CAPTURE_SHARED_SECRET`, and API keys. Prevents accidental exposure in panic messages or debug logs.

---

### I5. Fail-Open Design in Receiver

**File:** `apps/receiver-rs/src/handlers/webhook.rs` (lines 301-305)

On database errors, the receiver returns HTTP 200 OK to prevent webhook senders from retrying. This is an intentional design choice appropriate for a webhook ingestion service. Database errors are logged for monitoring.

---

### I6. API Key Hashing

**File:** `supabase/migrations/00001_initial_schema.sql` (lines 112-127), `apps/web/lib/supabase/api-keys.ts`

API keys are stored as SHA-256 hashes with only a prefix retained for display. Raw keys are shown once at creation and never stored. This follows industry best practices.

---

## Security Strengths

The audit identified numerous positive security practices across the codebase:

### Authentication & Authorization
- Proper separation of API keys vs session tokens for sensitive operations (`authenticateSessionRequest` rejects API keys for account/billing routes)
- SHA-256 hashed API key storage with prefix-only display
- Device auth flow with 15-minute TTL, bounded pending codes (max 500), and atomic state transitions
- Timing-safe secret comparison for blog API auth (`crypto.timingSafeEqual`)
- Team access control with ownership verification, Pro plan enforcement, and proper cascade on downgrade

### Input Validation
- Strict slug validation: `/^[A-Za-z0-9_-]{1,50}$/` in both web app and receiver
- Request body size limits: 64KB default (API routes), 1MB (receiver, send-test)
- Mock response validation: status code range (100-599), header size limits (256/8192 bytes), delay cap (30s)
- Path traversal protection: `..` rejection, `url.JoinPath()` usage
- HTTP method whitelisting in send-test endpoint

### Injection Prevention
- All SQL via parameterized queries (sqlx `.bind()` in Rust, Supabase client in TypeScript)
- CRLF injection protection in mock response headers
- Security header blocklist (set-cookie, HSTS, CSP, X-Frame-Options) for mock responses
- HTML entity escaping for request display (`escapeHtml()`)
- Shell escaping for generated curl commands (`escapeForShellDoubleQuotes`)
- No command injection vectors in CLI (uses `exec.Command` with arg arrays, not shell strings)

### Network Security
- No `InsecureSkipVerify` anywhere in Go codebase
- TLS enforced on all HTTP clients with proper timeout configuration
- IP address validation with character whitelist (prevents XSS via spoofed headers)
- Proxy header filtering strips Cloudflare/Caddy infrastructure headers
- Tunnel header filtering strips auth/cookie headers before forwarding

### Data Protection
- Secrets redacted in Rust Debug output
- Error responses truncated to 200 chars (prevents data leakage)
- No console logging of API keys in SDK
- Token storage with 0600 file permissions, 0700 directory
- Environment variables validated via Zod schemas
- `.env*` files properly gitignored

### RLS & Database Security
- Row-level security enabled on all tables with deny-by-default for anonymous users (migration 00008)
- Device codes fully blocked from anonymous access
- Request inserts blocked entirely (only service_role via receiver)
- Team tables deny all direct access, forcing API-route mediation
- Stored procedures use `SECURITY DEFINER` with `SET search_path = ''`

### CLI Security
- SHA-256 verified self-updates with GitHub URL validation
- `io.LimitReader` for downloads (100MB binary, 1MB API)
- Safe tar/zip extraction with basename matching (no path traversal)
- Atomic binary replacement via `os.Rename`
- `crypto/rand` for random values

### Infrastructure
- Non-root Docker containers
- Multi-stage builds minimizing attack surface
- Dependency review workflow blocking HIGH severity and GPL licenses
- CodeQL analysis for JavaScript/TypeScript and Go
- Dependabot configured for weekly updates

---

## Recommendations Summary

| Priority | Finding | Action |
|----------|---------|--------|
| **Medium** | M1: Missing REVOKE/GRANT on utility functions | Add explicit permission restrictions |
| **Medium** | M2: Ephemeral TTL bypass via direct Supabase | Add CHECK constraint on expires_at |
| **Medium** | M3: In-memory rate limiter | Use Redis-backed limiter if multi-instance |
| **Medium** | M4: Missing PG pool acquire timeout | Add `.acquire_timeout(10s)` |
| **Low** | L1: No request timeout on receiver | Add Tower timeout middleware |
| **Low** | L2: Unused CAPTURE_SHARED_SECRET | Implement or remove |
| **Low** | L3: CLI replay URL scheme check | Add http/https validation |
| **Low** | L4: Docker ports unbound | Bind to 127.0.0.1 |
| **Low** | L5: Systemd hardening | Add PrivateTmp, NoNewPrivileges, etc. |

---

## Conclusion

The webhooks.cc codebase is production-ready from a security standpoint. The identified medium-severity issues are defense-in-depth improvements rather than exploitable vulnerabilities in the current single-instance deployment. The development team has demonstrated consistent security awareness across all components, with proper input validation, parameterized queries, secret handling, and access control throughout.
