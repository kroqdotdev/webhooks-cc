# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

webhooks.cc is a webhook inspection and testing service. Users can capture incoming webhooks, inspect request details, configure mock responses, and forward requests to localhost for development.

## Commands

### Development

```bash
pnpm install              # Install all dependencies
pnpm dev:convex           # Start Convex backend (run first, in separate terminal)
pnpm dev:web              # Start Next.js web app
make dev-receiver         # Start Go webhook receiver
make dev-cli ARGS="..."   # Run CLI with arguments
```

### Build & Test

```bash
pnpm build                # Build all TypeScript packages
pnpm typecheck            # Type check all packages
make build                # Build everything including Go binaries
make build-receiver       # Build Go receiver to dist/receiver
make build-cli            # Build CLI with goreleaser
make test                 # Run all tests (TS + Go)
```

### Convex

```bash
npx convex dev --once     # Push schema/functions to dev deployment
npx convex deploy         # Deploy to production
npx convex run <fn> '{}'  # Run a function (e.g., endpoints:create)
npx convex data           # List all tables
```

## Architecture

### Service Layout

- **Web app (port 3000)**: Next.js frontend/dashboard
- **Receiver (port 3001)**: Go server that captures webhooks
- **Convex**: Backend database, auth, real-time subscriptions

### Data Flow

1. External service sends webhook to receiver at `/w/{slug}`
2. Go receiver captures request, calls Convex HTTP action at `/capture`
3. Convex stores request in `requests` table
4. Frontend receives real-time update via Convex subscription

### Key Directories

- `convex/` - Backend: schema, mutations, queries, HTTP actions, crons
- `apps/web/` - Next.js 15 with App Router, Tailwind v4, shadcn/ui
- `apps/receiver/` - Go Fiber server that captures webhooks
- `apps/cli/` - Go CLI tool (Cobra) for tunneling
- `packages/sdk/` - TypeScript SDK for programmatic access

### Convex Structure

- `schema.ts` - Database schema (users, endpoints, requests, apiKeys)
- `endpoints.ts` - CRUD for webhook endpoints
- `requests.ts` - Capture and query webhook requests
- `http.ts` - HTTP actions (receiver calls `/capture`)
- `auth.ts` - GitHub/Google OAuth via @convex-dev/auth
- `crons.ts` - Cleanup expired endpoints, billing resets

### Environment Variables

The `.env.local` file (root and apps/web) must include:

- `CONVEX_DEPLOYMENT` / `NEXT_PUBLIC_CONVEX_URL` - Convex project
- `CONVEX_SITE_URL` - For Go receiver to call HTTP actions (`.site` domain)
- `NEXT_PUBLIC_WEBHOOK_URL` - Base URL for webhook receiver
- `NEXT_PUBLIC_APP_URL` - Base URL for web application

### Convex Specifics

- Optional fields must be `undefined`, not `null`
- HTTP actions are served from `.convex.site` domain, not `.convex.cloud`
- Use `internalMutation` for cron jobs, `httpAction` for HTTP endpoints

## Development Phases

See `docs/ROADMAP.md` for full roadmap. Current focus:

- Phase 1: Landing page, live demo, real-time request display
- Phase 2: Auth, dashboard, endpoint management
- Phase 3: Polar.sh billing integration
