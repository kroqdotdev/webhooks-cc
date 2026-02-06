# webhooks.cc Roadmap

## Overview

This roadmap outlines the development path from scaffold to production.

---

## Phase Summary

| Phase | Focus            | Status         | Deliverable                            |
| ----- | ---------------- | -------------- | -------------------------------------- |
| **1** | Foundation       | 🟢 Complete    | Working landing page + demo + receiver |
| **2** | Auth & Dashboard | 🟢 Complete    | Login, dashboard, endpoint management  |
| **3** | Billing          | 🟢 Complete    | Polar.sh integration, usage tracking   |
| **4** | Docs & Polish    | 🟢 Complete    | /docs, /installation, smart formatting |
| **5** | CLI              | 🟢 Complete    | `whk tunnel`, `whk listen`             |
| **5H** | Prod Hardening  | 🟢 Complete    | Sentry, error handling, key expiry     |
| **6** | SDK              | 🟢 Complete    | Client, API routes, typed errors, tests |
| **6T** | Convex Tests    | 🟢 Complete    | 78 tests: billing, quota, capture      |
| **7** | Growth           | 🔴 Deferred    | Team features, integrations            |

---

## Phase 1: Foundation

**Goal:** A visitor can land on the site, create an ephemeral endpoint, send a test request, and see it appear in real-time.

**Key Deliverables:**

- [x] Convex backend deployed and working
- [x] Go receiver capturing webhooks
- [x] Landing page with interactive demo
- [x] Real-time request display
- [x] Basic request detail view (JSON formatting)
- [x] E2E testing complete
- [x] Caddy/deployment configured

**Status:** ✅ Complete

**Detailed tasks:** See [TODO-phase-1-COMPLETED.md](./TODO-phase-1-COMPLETED.md)

**Definition of Done:**

1. Visit webhooks.cc → see landing page
2. Click "Try it live" → get ephemeral endpoint URL
3. Run curl command → see request appear instantly
4. Click request → see formatted JSON body

---

## Phase 2: Auth & Dashboard

**Goal:** Users can sign up, manage persistent endpoints, and use the full dashboard.

**Key Deliverables:**

- [x] GitHub + Google OAuth working
- [x] User accounts with plan tracking
- [x] Dashboard with endpoint switcher
- [x] Endpoint settings page (name, mock response)
- [x] Account page with usage display
- [x] Protected routes (redirect to login)

**Status:** ✅ Complete

**Detailed tasks:** See [TODO-phase-2-COMPLETED.md](./TODO-phase-2-COMPLETED.md)

**Definition of Done:**

1. Sign in with GitHub → redirected to dashboard
2. Create named endpoint → appears in dropdown
3. Configure mock response → endpoint returns it
4. See usage stats on account page

---

## Phase 3: Billing

**Goal:** Users can upgrade to Pro, usage is tracked and enforced, subscriptions work correctly.

**Key Deliverables:**

- [x] Polar.sh checkout integration
- [x] Webhook handlers for subscription events
- [x] Usage limit enforcement in receiver (file-based quota cache)
- [x] Period reset cron job working
- [x] Cancel at period end handling
- [x] Upgrade/downgrade UI

**Status:** ✅ Complete

**Detailed tasks:** See [TODO-phase-3-COMPLETED.md](./TODO-phase-3-COMPLETED.md)

**Definition of Done:**

1. Click Upgrade → complete Polar.sh checkout → plan changes to Pro
2. Hit 200 requests on free → receiver returns 429
3. Cancel subscription → access continues until period end → downgrades to free

---

## Phase 4: Docs & Polish

**Goal:** Comprehensive documentation, polished UI, and production-ready experience.

**Key Deliverables:**

- [x] /installation page with CLI + SDK tabs
- [x] /docs with quick start guide
- [x] /docs/endpoints, /docs/requests, /docs/mock-responses
- [x] /docs/cli/\* - CLI reference (install, commands, tunneling)
- [x] /docs/sdk/\* - SDK reference (install, API, testing patterns)
- [x] /docs/webhooks/\* - integration guides (Stripe, GitHub, Shopify)
- [x] Smart formatting (JSON, XML, form data)
- [x] Request search/filter (client-side)
- [x] Export (JSON/CSV)
- [x] Request replay (client-side)
- [x] Copy as cURL
- [x] SEO meta tags, sitemap, robots.txt
- [x] Dark mode, loading skeletons, error boundaries

**Status:** ✅ Complete

**Detailed tasks:** See [TODO-phase-4-COMPLETED.md](./TODO-phase-4-COMPLETED.md)

**Definition of Done:**

1. ✅ /installation page with CLI + SDK installation tabs
2. ✅ /docs quick start + full documentation tree
3. ✅ Smart formatting for JSON, XML, and form data
4. ✅ Search, export, replay, and copy-as-cURL all working

---

## Phase 5: CLI

**Goal:** Developers can tunnel webhooks to localhost from the command line.

**Key Deliverables:**

- [x] OAuth device flow authentication
- [x] `whk tunnel <port>` creates endpoint + forwards
- [x] `whk listen <slug>` streams to terminal
- [x] Real-time request display in terminal
- [x] goreleaser for multi-platform binaries
- [x] Homebrew tap

**Status:** ✅ Complete

**Detailed tasks:** See [TODO-phase-5-COMPLETED.md](./TODO-phase-5-COMPLETED.md)

**Definition of Done:**

1. ✅ `whk auth login` opens browser, authorizes, saves token
2. ✅ `whk tunnel 8080` creates endpoint, forwards requests to localhost
3. ✅ Requests appear in terminal in real-time
4. ✅ Ctrl+C with `--ephemeral` deletes endpoint
5. ✅ Binaries available via Homebrew and curl

---

## Phase 5H: Production Hardening

**Goal:** Error tracking, webhook reliability, and medium-priority fixes for production readiness.

**Key Deliverables:**

- [x] Sentry integration (web, receiver, CLI)
- [x] Polar webhook error classification (transient vs permanent)
- [x] API key expiration (90-day for device auth, cleanup cron)
- [x] Centralized env validation (Zod)
- [x] Request body size limits on API routes
- [x] Docker health checks
- [x] Log standardization across Convex functions
- [x] Device code indexed query
- [x] SDK typed errors and telemetry hooks
- [x] Abuse protection (ephemeral endpoint limits, rate limiting, HMAC auth)
- [x] Go receiver + CLI test coverage (Phase 4 Go tests)

**Status:** ✅ Complete

---

## Phase 6: SDK

**Goal:** Developers can programmatically create endpoints and wait for webhooks in tests.

**Key Deliverables:**

- [x] `@webhooks-cc/sdk` client with full CRUD + `waitFor`
- [x] API routes (`/api/endpoints/...`, `/api/requests/...`)
- [x] Typed errors (`WebhooksCCError`, `UnauthorizedError`, `NotFoundError`, etc.)
- [x] Helper functions (`parseJsonBody`, `isStripeWebhook`, `isGitHubWebhook`, `matchJsonField`)
- [x] Telemetry hooks (`ClientHooks` for request/response/error instrumentation)
- [x] Unit tests (20 tests via vitest, mocked fetch)
- [x] Integration test scaffold (skipped without credentials)
- [x] /docs/sdk reference pages (overview, API, testing patterns)
- [x] Package built with tsup (CJS + ESM + types)

**Status:** ✅ Complete

**Detailed tasks:** See [TODO-phase-6-COMPLETED.md](./TODO-phase-6-COMPLETED.md)

**Definition of Done:**

1. ✅ `@webhooks-cc/sdk` installable (v0.1.1 published)
2. ✅ Create endpoint, send webhook, `waitFor` returns it
3. ✅ Helper functions for Stripe/GitHub webhook matching
4. ✅ SDK docs at /docs/sdk with API reference and testing patterns

---

## Phase 6T: Convex Test Suite

**Goal:** Comprehensive test coverage for Convex backend functions (billing, quota, capture).

**Key Deliverables:**

- [x] `convex-test` infrastructure with vitest + edge-runtime
- [x] Polar webhook handler tests (29 cases: customer, order, subscription lifecycle)
- [x] Quota and capture tests (25 cases: period management, usage, getQuota, capture, batch)
- [x] Free user period reset tests (4 cases: reset, no-op, cleanup)
- [x] 78 total Convex function tests passing

**Status:** ✅ Complete

---

## Phase 7: Growth Features (Deferred)

**Goal:** Features that drive adoption and retention based on user feedback.

**Potential Features:**

- [ ] Custom subdomains (Pro)
- [ ] Team workspaces (shared endpoints)
- [ ] Slack/Discord notifications
- [ ] Request diff/comparison
- [ ] TypeScript type generation from requests
- [ ] WebSocket testing
- [ ] GraphQL inspection

---

## Architecture Decisions

### Already Decided

- **Database:** Convex (real-time, auth, serverless)
- **Frontend:** Next.js 15 + Tailwind + shadcn/ui
- **Receiver:** Go + Fiber (fast, stateless)
- **Payments:** Polar.sh (developer-friendly)
- **Hosting:** Self-hosted home server + Caddy

### Decided Since Launch

- **Request retention:** Cron-based cleanup (`cleanupOldRequests` for pro, `resetFreeUserPeriod` + `cleanupUserRequests` for free)
- **Rate limiting:** Receiver-side via in-memory quota cache (Go receiver queries Convex for quota, caches locally). See `docs/future/distributed-rate-limiting.md` for Redis migration plan.

### To Decide Later

- Analytics/monitoring stack

---

## Success Metrics

### Phase 1 (Foundation)

- Page loads in < 2s
- Webhook capture latency < 100ms
- Real-time update latency < 500ms

### Phase 2 (Auth)

- OAuth flow completes in < 5s
- Dashboard loads in < 1s

### Phase 3 (Billing)

- Checkout flow works end-to-end
- Webhook handlers process events correctly

### Launch (Post Phase 4)

- 100 signups in first week
- 10% free-to-paid conversion
- < 1 critical bug per week

---

## Risk Register

| Risk                     | Likelihood | Impact | Mitigation                           |
| ------------------------ | ---------- | ------ | ------------------------------------ |
| Convex rate limits       | Low        | High   | Go receiver quota cache reduces Convex calls |
| Home server downtime     | Medium     | High   | Docker health checks, systemd auto-restart |
| Polar.sh webhook issues  | Low        | Medium | 78 Convex tests + error classification + retry logic |
| Go receiver memory leaks | Low        | Medium | Profile under load, set limits       |

---

_Last updated: 2026-02-06_
