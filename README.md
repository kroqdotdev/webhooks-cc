# webhooks.cc

Webhook inspection and testing service. Capture incoming webhooks, inspect request details, configure mock responses, and forward requests to localhost for development.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start Convex (in a separate terminal)
pnpm dev:convex

# Start the web app
pnpm dev:web

# Start the receiver (in a separate terminal)
make dev-receiver
```

## Project Structure

```
webhooks-cc/
├── apps/
│   ├── web/          # Next.js dashboard
│   ├── receiver/     # Go webhook receiver
│   ├── cli/          # Go CLI tool
│   └── go-shared/    # Shared Go types
├── packages/
│   └── sdk/          # TypeScript SDK
├── convex/           # Convex backend
└── docs/             # Documentation
```

## Stack

- **Frontend:** Next.js 15, Tailwind, shadcn/ui
- **Backend:** Convex (database, auth, real-time)
- **Receiver:** Go + Fiber
- **CLI:** Go + Cobra
- **SDK:** TypeScript
- **Payments:** Polar.sh

## Infrastructure

The project runs on an Ubuntu LXC container with Caddy reverse proxy:

| Domain | Port | Service |
|--------|------|---------|
| webhooks.cc | 3000 | Next.js web app |
| go.webhooks.cc | 3001 | Go webhook receiver |

### Mail

SMTP is configured for transactional emails (welcome, notifications, etc.):

| Setting | Value |
|---------|-------|
| Host | mail.sauerdev.com |
| Port | 465 (SSL) or 587 (TLS) |
| Username | postmaster@webhooks.cc |
| From addresses | *@webhooks.cc |

## Commands

```bash
# Development
make dev              # Start all services
pnpm dev:web         # Start web only
pnpm dev:convex      # Start Convex
make dev-receiver    # Start Go receiver
make dev-cli ARGS="tunnel 8080"  # Run CLI

# Build
make build           # Build everything
make build-receiver  # Build receiver only
make build-cli       # Build CLI only

# Deploy
pnpm convex deploy   # Deploy Convex
docker compose up -d # Deploy web + receiver
```

## Environment Variables

Copy `.env.example` to `.env.local` and fill in:

```bash
CONVEX_DEPLOYMENT=
NEXT_PUBLIC_CONVEX_URL=
POLAR_ACCESS_TOKEN=
POLAR_WEBHOOK_SECRET=
POLAR_PRO_PRICE_ID=
CONVEX_URL=
SMTP_HOST=mail.sauerdev.com
SMTP_PORT=465
SMTP_USER=postmaster@webhooks.cc
SMTP_PASS=
```

## License

MIT
