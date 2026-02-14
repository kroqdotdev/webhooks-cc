# @webhooks-cc/sdk

TypeScript SDK for [webhooks.cc](https://webhooks.cc). Create webhook endpoints, capture requests, match and replay them, and stream events in real time.

## Install

```bash
npm install @webhooks-cc/sdk
# or: pnpm add / yarn add / bun add
```

## Quick start

```typescript
import { WebhooksCC, matchAll, matchMethod, matchHeader } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: "whcc_..." });

// Create an endpoint
const endpoint = await client.endpoints.create({ name: "stripe-test" });
console.log(endpoint.url); // https://go.webhooks.cc/w/abc123

// Point your service at endpoint.url, then wait for the webhook
const request = await client.requests.waitFor(endpoint.slug, {
  timeout: "30s",
  match: matchAll(matchMethod("POST"), matchHeader("stripe-signature")),
});

console.log(request.body); // '{"type":"checkout.session.completed",...}'

// Clean up
await client.endpoints.delete(endpoint.slug);
```

## Client options

```typescript
new WebhooksCC(options);
```

| Option       | Type          | Default                  | Description               |
| ------------ | ------------- | ------------------------ | ------------------------- |
| `apiKey`     | `string`      | _required_               | API key (`whcc_...`)      |
| `baseUrl`    | `string`      | `https://webhooks.cc`    | API base URL              |
| `webhookUrl` | `string`      | `https://go.webhooks.cc` | Webhook receiver URL      |
| `timeout`    | `number`      | `30000`                  | HTTP request timeout (ms) |
| `hooks`      | `ClientHooks` | —                        | Lifecycle callbacks       |

### Hooks

```typescript
const client = new WebhooksCC({
  apiKey: "whcc_...",
  hooks: {
    onRequest: (info) => console.log(info.method, info.url),
    onResponse: (info) => console.log(info.status),
    onError: (info) => console.error(info.error),
  },
});
```

## Endpoints

```typescript
// Create
const endpoint = await client.endpoints.create({ name: "my-test" });

// List all
const endpoints = await client.endpoints.list();

// Get by slug
const endpoint = await client.endpoints.get("abc123");

// Update name or mock response
await client.endpoints.update("abc123", {
  name: "New Name",
  mockResponse: { status: 201, body: '{"ok":true}', headers: {} },
});

// Clear mock response
await client.endpoints.update("abc123", { mockResponse: null });

// Send a test webhook
const res = await client.endpoints.send("abc123", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { event: "test" },
});

// Delete
await client.endpoints.delete("abc123");
```

## Requests

```typescript
// List captured requests
const requests = await client.requests.list("endpoint-slug", {
  limit: 50,
  since: Date.now() - 60000,
});

// Get a single request by ID
const request = await client.requests.get("request-id");

// Poll until a matching request arrives
const request = await client.requests.waitFor("endpoint-slug", {
  timeout: "30s", // human-readable or milliseconds
  pollInterval: "500ms",
  match: matchHeader("stripe-signature"),
});

// Replay a captured request to a target URL
const res = await client.requests.replay(request.id, "http://localhost:3000/webhooks");

// Stream requests in real time via SSE
for await (const req of client.requests.subscribe("endpoint-slug")) {
  console.log(req.method, req.body);
}
```

## Matchers

Composable functions for `waitFor`'s `match` option:

```typescript
import { matchMethod, matchHeader, matchBodyPath, matchAll, matchAny } from "@webhooks-cc/sdk";

// Match POST requests with a specific header
matchAll(matchMethod("POST"), matchHeader("x-event-type", "payment.success"));

// Match header presence (any value)
matchHeader("stripe-signature");

// Match a nested JSON body field
matchBodyPath("data.object.id", "sub_123");

// Match any of several conditions
matchAny(matchHeader("stripe-signature"), matchHeader("x-github-event"));
```

## Provider helpers

Detect webhook sources by their signature headers:

```typescript
import { isStripeWebhook, isGitHubWebhook } from "@webhooks-cc/sdk";

if (isStripeWebhook(request)) {
  // has stripe-signature header
}
```

Available: `isStripeWebhook`, `isGitHubWebhook`, `isShopifyWebhook`, `isSlackWebhook`, `isTwilioWebhook`, `isPaddleWebhook`, `isLinearWebhook`.

## Self-description

AI agents can call `client.describe()` to get a structured summary of all SDK operations, parameters, and return types — no API call required.

```typescript
const desc = client.describe();
// { version: "0.3.0", endpoints: { create: { ... }, ... }, requests: { ... } }
```

## Errors

All API errors extend `WebhooksCCError` and include actionable recovery hints:

```typescript
import { WebhooksCC, WebhooksCCError, NotFoundError } from "@webhooks-cc/sdk";

try {
  await client.endpoints.get("nonexistent");
} catch (error) {
  if (error instanceof WebhooksCCError) {
    console.log(error.statusCode); // 404
    console.log(error.message); // includes what went wrong and how to fix it
  }
}
```

Error classes: `WebhooksCCError`, `UnauthorizedError`, `NotFoundError`, `TimeoutError`, `RateLimitError`. The legacy `ApiError` alias is still exported for backward compatibility.

## GitHub Actions

Add your API key as a repository secret named `WHK_API_KEY`:

```yaml
- name: Run webhook tests
  env:
    WHK_API_KEY: ${{ secrets.WHK_API_KEY }}
  run: npx vitest run
```

```typescript
// webhook.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { WebhooksCC, matchHeader } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

describe("webhook integration", () => {
  let slug: string;

  it("receives Stripe webhook", async () => {
    const endpoint = await client.endpoints.create({ name: "CI Test" });
    slug = endpoint.slug;

    // Trigger your service to send a webhook to endpoint.url
    await yourService.registerWebhook(endpoint.url!);
    await yourService.createOrder();

    const req = await client.requests.waitFor(slug, {
      timeout: "15s",
      match: matchHeader("stripe-signature"),
    });

    const body = JSON.parse(req.body!);
    expect(body.type).toBe("checkout.session.completed");
  });

  afterAll(async () => {
    if (slug) await client.endpoints.delete(slug);
  });
});
```

## Types

All types are exported:

```typescript
import type {
  ClientOptions,
  ClientHooks,
  Endpoint,
  Request,
  CreateEndpointOptions,
  UpdateEndpointOptions,
  SendOptions,
  ListRequestsOptions,
  WaitForOptions,
  SubscribeOptions,
  SDKDescription,
} from "@webhooks-cc/sdk";
```

## License

MIT
