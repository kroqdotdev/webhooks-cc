# webhooks.cc

Inspect and debug webhooks and email without deploying to production.

Get a unique URL, point your webhook there, and see every request in real time. No signup required. Every endpoint also has an email address at `mailhooks.cc` that captures mail the same way.

**[Try it now →](https://webhooks.cc)**

## Getting Started

1. Visit [webhooks.cc](https://webhooks.cc)
2. Copy your unique webhook URL
3. Send a test request: `curl -X POST https://go.webhooks.cc/w/<slug> -d '{"test": true}'`
4. Watch it appear in the dashboard

## Features

- **Capture requests**: store incoming webhooks with headers, body, query parameters and metadata
- **Capture email**: every endpoint receives mail at `{slug}@mailhooks.cc`, with parsed fields, attachments and authentication results
- **Inspect in real time**: see requests the moment they arrive
- **Configure responses**: return custom status codes, headers and bodies, chosen by rules, to test error paths
- **Verify signatures**: check provider signatures (Stripe, GitHub, Shopify and more) on captured requests
- **Forward**: tunnel webhooks to localhost during development (with `--live`, the sender gets your local app's answer), or forward them to other URLs, chat and file drops
- **Share localhost**: put the site on your machine at a public link on sharehooks.cc with `whk share`
- **CLI with interactive TUI**: manage endpoints, tunnel and stream requests from your terminal
- **SDKs for TypeScript, Python and Go**: wait for and assert on webhooks in tests and CI
- **MCP server**: connect AI coding agents (Claude Code, Cursor, VS Code, Codex) to your webhooks

## Use Cases

**Testing payment integrations**: point Stripe's test webhooks at your endpoint. Inspect the payload structure before writing handlers.

**Debugging CI/CD hooks**: see exactly what GitHub sends when a push, PR, or deployment occurs.

**Developing locally**: forward production-like webhooks to localhost without exposing your machine to the internet.

**Mocking failure scenarios**: configure your endpoint to return 500 errors and test your retry logic.

## Pricing

**Free**: 50 requests a day, 7-day retention. Enough for development and testing.

**Pro ($8/month)**: 100,000 requests a month, 31-day retention.

**Business ($29/month)**: 250,000 requests a month, 90-day retention, attachment parsing, custom inbound domains and file drops.

Teams share endpoints under a per-seat subscription. See [plans and limits](https://webhooks.cc/docs/plans-limits) for details.

## Install

### CLI

```bash
curl -fsSL https://webhooks.cc/install.sh | sh
# or
brew install kroqdotdev/tap/whk
# without root: any directory you can write to (created when missing)
curl -fsSL https://webhooks.cc/install.sh | WHK_INSTALL_DIR="$HOME/.local/bin" sh
```

With `WHK_INSTALL_DIR`, put that directory on your `PATH` (the installer prints the line to add) before running `whk`.

Then launch interactive terminal:

```bash
whk
```

### SDK

```bash
npm install @webhooks-cc/sdk
```

### MCP server

```bash
# Claude Code
claude mcp add -s user webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp

# Cursor, VS Code, Devin Desktop (formerly Windsurf), Claude Desktop
npx @webhooks-cc/mcp setup cursor --api-key whcc_...
```

See [webhooks.cc/installation](https://webhooks.cc/installation) for all install methods, one-click buttons, and setup guides.

## CLI

Run `whk` to launch the interactive TUI:

```
$ whk

  webhooks.cc

  ● Logged in as you@example.com

  ▸ Tunnel    Forward webhooks to localhost
    Listen    Stream incoming requests
    Create    Create a new endpoint
    Endpoints Manage your endpoints
    Auth      Login / logout
    Update    Check for updates
```

All commands also work directly from the command line:

```bash
whk tunnel 8080                       # Forward webhooks to localhost:8080
whk share 3000                        # Share localhost:3000 at https://<name>.sharehooks.cc
whk listen <slug>                     # Stream incoming requests
whk create my-endpoint                # Create a new endpoint
whk list                              # List your endpoints
whk replay <request-id> --to :3000    # Replay a captured request
```

Pass `--nogui` or set `WHK_NOGUI=1` to skip the TUI and print help.

## SDK

```typescript
import { WebhooksCC, matchMethod, matchHeader, matchAll } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: "whcc_..." });

const endpoint = await client.endpoints.create({ name: "my-webhook" });
console.log(endpoint.url);

// Wait for a matching request with human-readable timeout
const req = await client.requests.waitFor(endpoint.slug, {
  timeout: "30s",
  match: matchAll(matchMethod("POST"), matchHeader("stripe-signature")),
});

// Replay captured requests to your local server
await client.requests.replay(req.id, "http://localhost:3000/webhooks");
```

## MCP server

The `@webhooks-cc/mcp` package exposes 57 tools (54 on the remote server) that let AI agents manage endpoints, inspect webhooks, send test payloads, and replay requests through natural language.

```
You: "Create a webhook endpoint for testing Stripe"
Agent: Created endpoint "stripe-test" at https://go.webhooks.cc/w/abc123

You: "Send a test checkout.session.completed event"
Agent: Sent POST to stripe-test

You: "Replay that to my local server"
Agent: Replayed to http://localhost:3000/webhooks: 200 OK
```

See [`packages/mcp/README.md`](packages/mcp/README.md) for full setup and tool reference.

## Why the code is public

webhooks.cc holds other people's webhooks and email, so the code that handles them should be open to inspection. You can read exactly how a request is captured, stored, forwarded and deleted, and check that the service does what it says. The repository is also where security scanning, dependency updates and bug reports happen in the open.

webhooks.cc is built and run by one developer. The hosted service at [webhooks.cc](https://webhooks.cc) is the product; the repository is not a community project.

## Issues and contributions

- **Bugs and feature requests** are welcome as [issues](https://github.com/kroqdotdev/webhooks-cc/issues/new/choose).
- **Questions about your account, billing or data** go to [webhooks.cc/support](https://webhooks.cc/support), never to a public issue.
- **Security vulnerabilities** are reported privately, see [SECURITY.md](SECURITY.md).
- **Pull requests** are accepted only from people who have signed the [Contributor License Agreement](CLA.md). Open an issue first: most changes are made in-house, and a pull request may be closed or reimplemented. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project uses a split license:

- **AGPL-3.0**: the web app, receiver, email-capture SMTP host, tunnel edge, attachment parser and database schema (`apps/web/`, `apps/receiver-rs/`, `apps/mx-rs/`, `apps/edge-rs/`, `apps/parser-rs/`, `supabase/`). See [LICENSE](LICENSE).
- **MIT**: the CLI and its tunnel protocol crate, the TypeScript, Python and Go SDKs, the MCP server, the Zapier and Make apps, and the Claude Code plugin (`apps/cli-rs/`, `crates/tunnel/`, `packages/sdk/`, `packages/sdk-python/`, `packages/sdk-go/`, `packages/mcp/`, `packages/zapier-app/`, `packages/make-app/`, `plugins/`). See the `LICENSE` file in each directory.

The CLI, SDKs and MCP server are MIT so you can use them freely in your own projects, open or closed.
