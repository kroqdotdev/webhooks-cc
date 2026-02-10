# webhooks.cc

Inspect and debug webhooks without deploying to production.

Get a unique URL, point your webhook there, and see every request in real-time. No signup required.

**[Try it now →](https://webhooks.cc/go)**

## Getting Started

1. Visit [webhooks.cc](https://webhooks.cc/go)
2. Copy your unique webhook URL
3. Send a test request: `curl -X POST https://go.webhooks.cc/w/<slug> -d '{"test": true}'`
4. Watch it appear in the dashboard

## Features

- **Capture requests** — Store incoming webhooks with headers, body, query params, and metadata
- **Inspect in real-time** — See requests the moment they arrive via WebSocket
- **Configure responses** — Return custom status codes, headers, and body for testing error paths
- **Forward to localhost** — Tunnel webhooks to your local server during development
- **CLI** — Manage endpoints and tunnel from your terminal with `whk`
- **TypeScript SDK** — Access webhook data programmatically for automation and testing

## Use Cases

**Testing payment integrations** — Point Stripe's test webhooks at your endpoint. Inspect the payload structure before writing handlers.

**Debugging CI/CD hooks** — See exactly what GitHub sends when a push, PR, or deployment occurs.

**Developing locally** — Forward production-like webhooks to localhost without exposing your machine to the internet.

**Mocking failure scenarios** — Configure your endpoint to return 500 errors and test your retry logic.

## Pricing

**Free** — 200 requests/day, 24-hour data retention. Enough for development and testing.

**Pro ($8/month)** — 500,000 requests/month, 30-day retention. For production monitoring and high-volume testing.

See [webhooks.cc](https://webhooks.cc) for details.

## Install

### CLI

```bash
curl -fsSL https://webhooks.cc/install.sh | sh
```

Then authenticate:

```bash
whk auth login
```

### SDK

```bash
npm install @webhooks-cc/sdk
```

See [webhooks.cc/installation](https://webhooks.cc/installation) for Homebrew, manual downloads, and other methods.

## CLI

```bash
whk endpoints list
whk endpoints create --name "stripe-test"
whk tunnel 8080
```

## SDK

```typescript
import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: "whcc_..." });

const endpoint = await client.endpoints.create({ name: "my-webhook" });
console.log(endpoint.url);

const requests = await client.requests.list(endpoint.slug);
```

## Open Source

The source is available for transparency and community contributions, not as a deployment guide. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

For compliance or air-gapped environments, the code is here. For most use cases, the hosted service at [webhooks.cc](https://webhooks.cc) is the easier path.

## License

This project uses a split license:

- **AGPL-3.0** — The web app, receiver, and Convex backend (`apps/web/`, `apps/receiver-rs/`, `convex/`). See [LICENSE](LICENSE).
- **MIT** — The CLI and SDK (`apps/cli/`, `packages/sdk/`, `apps/go-shared/`). See their respective `LICENSE` files.

If you use the CLI or SDK in your own projects, MIT applies. If you fork and host the service, AGPL-3.0 applies.
