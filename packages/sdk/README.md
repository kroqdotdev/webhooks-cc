# @webhooks-cc/sdk

TypeScript SDK for [webhooks.cc](https://webhooks.cc). Create temporary webhook endpoints, capture requests, and assert on their contents in your test suite.

## Install

```bash
npm install @webhooks-cc/sdk
```

## Quick Start

```typescript
import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: "whcc_..." });

// Create a temporary endpoint
const endpoint = await client.endpoints.create({ name: "My Test" });
console.log(endpoint.url); // https://go.webhooks.cc/w/abc123

// Point your service at endpoint.url, then wait for the webhook
const request = await client.requests.waitFor(endpoint.slug, {
  timeout: 10000,
  match: (r) => r.method === "POST",
});

console.log(request.body); // '{"event":"order.created"}'
console.log(request.headers); // { 'content-type': 'application/json', ... }

// Clean up
await client.endpoints.delete(endpoint.slug);
```

## API

### `new WebhooksCC(options)`

| Option    | Type     | Default               | Description          |
| --------- | -------- | --------------------- | -------------------- |
| `apiKey`  | `string` | _required_            | API key (`whcc_...`) |
| `baseUrl` | `string` | `https://webhooks.cc` | API base URL         |
| `timeout` | `number` | `30000`               | Request timeout (ms) |

### Endpoints

```typescript
// Create
const endpoint = await client.endpoints.create({ name: "optional name" });

// List all
const endpoints = await client.endpoints.list();

// Get by slug
const endpoint = await client.endpoints.get("abc123");

// Delete
await client.endpoints.delete("abc123");
```

### Requests

```typescript
// List captured requests for an endpoint
const requests = await client.requests.list("endpoint-slug", {
  limit: 50, // default: 50, max: 1000
  since: Date.now() - 60000, // only after this timestamp (ms)
});

// Get a single request by ID
const request = await client.requests.get("request-id");

// Poll until a matching request arrives
const request = await client.requests.waitFor("endpoint-slug", {
  timeout: 30000, // max wait (ms), default: 30000
  pollInterval: 500, // poll interval (ms), default: 500
  match: (r) => r.method === "POST" && r.body?.includes("order"),
});
```

### Errors

```typescript
import { WebhooksCC, ApiError } from "@webhooks-cc/sdk";

try {
  await client.endpoints.get("nonexistent");
} catch (error) {
  if (error instanceof ApiError) {
    console.log(error.statusCode); // 404
    console.log(error.message); // "API error (404): ..."
  }
}
```

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
import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

describe("webhook integration", () => {
  let slug: string;

  it("receives order webhook", async () => {
    const endpoint = await client.endpoints.create({ name: "CI Test" });
    slug = endpoint.slug;

    // Trigger your service to send a webhook to endpoint.url
    await yourService.registerWebhook(endpoint.url!);
    await yourService.createOrder();

    const req = await client.requests.waitFor(slug, {
      timeout: 15000,
      match: (r) => r.body?.includes("order.created"),
    });

    const body = JSON.parse(req.body!);
    expect(body.event).toBe("order.created");
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
  Endpoint,
  Request,
  CreateEndpointOptions,
  ListRequestsOptions,
  WaitForOptions,
} from "@webhooks-cc/sdk";
```

## License

MIT
