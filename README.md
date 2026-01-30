# webhooks.cc

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Inspect and test webhooks. Capture incoming requests, view their details, configure mock responses, and forward them to localhost.

## Features

- **Capture webhooks** — Store incoming HTTP requests
- **Real-time updates** — See requests instantly via WebSocket
- **Request inspection** — View headers, body, query params, and metadata
- **Mock responses** — Return custom status codes, headers, and body
- **Localhost tunneling** — Forward webhooks to your local server
- **CLI** — Manage endpoints and tunnel from the terminal
- **TypeScript SDK** — Access webhook data programmatically

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  External       │────▶│  Go Receiver    │────▶│  Convex         │
│  Service        │     │  (port 3001)    │     │  Backend        │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  CLI            │◀───▶│  Next.js Web    │◀────│  Real-time      │
│  (tunneling)    │     │  (port 3000)    │     │  Subscriptions  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. External services send webhooks to the Go receiver
2. The receiver stores requests via Convex
3. The web dashboard displays requests in real-time
4. The CLI tunnels requests to localhost

## Prerequisites

- Node.js 20+
- pnpm 8+ (`npm install -g pnpm`)
- Go 1.21+
- Make
- A [Convex](https://convex.dev) account

## Quick Start

```bash
git clone https://github.com/your-username/webhooks-cc.git
cd webhooks-cc

pnpm install

cp .env.example .env.local
# Edit .env.local with your Convex credentials

# Terminal 1: Start Convex
pnpm dev:convex

# Terminal 2: Start the web app
pnpm dev:web

# Terminal 3: Start the receiver
make dev-receiver
```

## Project Structure

```
webhooks-cc/
├── apps/
│   ├── web/          # Next.js dashboard (port 3000)
│   ├── receiver/     # Go webhook receiver (port 3001)
│   ├── cli/          # Go CLI
│   └── go-shared/    # Shared Go types
├── packages/
│   └── sdk/          # TypeScript SDK
├── convex/           # Backend functions
└── docs/             # Documentation
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 15, Tailwind CSS, shadcn/ui |
| Backend | Convex (database, auth, real-time) |
| Receiver | Go, Fiber |
| CLI | Go, Cobra |
| SDK | TypeScript |
| Payments | Polar.sh (optional) |

## Environment Variables

Copy `.env.example` to `.env.local` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_DEPLOYMENT` | Yes | Convex deployment identifier |
| `NEXT_PUBLIC_CONVEX_URL` | Yes | Convex cloud URL (`.convex.cloud`) |
| `CONVEX_SITE_URL` | Yes | Convex site URL (`.convex.site`) |
| `NEXT_PUBLIC_WEBHOOK_URL` | Yes | Public URL of your receiver |
| `NEXT_PUBLIC_APP_URL` | Yes | Public URL of your web app |
| `POLAR_ACCESS_TOKEN` | No | Polar.sh billing |
| `SMTP_*` | No | Email settings |

### Convex Environment Variables

Set via dashboard or `npx convex env set`:

| Variable | Default | Description |
|----------|---------|-------------|
| `FREE_REQUEST_LIMIT` | 500 | Requests per period (free tier) |
| `PRO_REQUEST_LIMIT` | 500000 | Requests per period (pro tier) |
| `EPHEMERAL_TTL_MS` | 600000 | Anonymous endpoint lifetime (10 min) |
| `BILLING_PERIOD_MS` | 2592000000 | Billing cycle (30 days) |

## Commands

```bash
# Development
pnpm dev:web              # Start web app
pnpm dev:convex           # Start Convex
make dev-receiver         # Start receiver
make dev-cli ARGS="..."   # Run CLI

# Build
pnpm build                # Build TypeScript packages
pnpm typecheck            # Type-check all packages
make build                # Build everything
make build-receiver       # Build receiver
make build-cli            # Build CLI

# Test
make test                 # Run all tests

# Deploy
npx convex deploy         # Deploy Convex functions
docker compose up -d      # Deploy with Docker
```

## CLI

```bash
go install ./apps/cli

whk login
whk endpoints list
whk endpoints create --name "my-webhook"
whk tunnel 8080
```

Set `WHK_API_URL` to point to your deployment.

## Docker

```bash
cp .env.example .env
# Edit .env with production values

docker compose up -d
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
