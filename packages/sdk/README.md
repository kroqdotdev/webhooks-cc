# @webhooks-cc/sdk

TypeScript SDK for [webhooks.cc](https://webhooks.cc). Create webhook endpoints, capture and search requests, send signed test webhooks, verify provider signatures, and build webhook tests with less boilerplate.

## Install

```bash
pnpm add @webhooks-cc/sdk
```

The package also ships a testing entrypoint:

```typescript
import { captureDuring, assertRequest } from "@webhooks-cc/sdk/testing";
```

## API key setup

The SDK needs an API key in `whcc_...` format. You can pass the key directly, but most projects load it from `WHK_API_KEY` so the same code works locally and in CI.

For local development, set the env var in your shell or `.env.local`:

```bash
export WHK_API_KEY=whcc_...
```

For GitHub Actions, store the key as a repository secret and expose it in the workflow:

```yaml
# .github/workflows/test.yml
env:
  WHK_API_KEY: ${{ secrets.WHK_API_KEY }}
```

## Quick start

```typescript
import { WebhooksCC, matchAll, matchHeader, matchMethod } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

const endpoint = await client.endpoints.create({
  name: "stripe-test",
  expiresIn: "1h",
});

await yourApp.registerWebhook(endpoint.url!);
await yourApp.triggerCheckout();

const request = await client.requests.waitFor(endpoint.slug, {
  timeout: "30s",
  match: matchAll(matchMethod("POST"), matchHeader("stripe-signature")),
});

console.log(request.body);

await client.endpoints.delete(endpoint.slug);
```

## Client options

```typescript
const client = new WebhooksCC({
  apiKey: "whcc_...",
  retry: {
    maxAttempts: 3,
    backoffMs: 500,
  },
  hooks: {
    onRequest: ({ method, url }) => console.log(method, url),
    onResponse: ({ status, durationMs }) => console.log(status, durationMs),
    onError: ({ error }) => console.error(error),
  },
});
```

| Option       | Type           | Default                  | Notes                                                                    |
| ------------ | -------------- | ------------------------ | ------------------------------------------------------------------------ |
| `apiKey`     | `string`       | required                 | API key in `whcc_...` format. Often read from `process.env.WHK_API_KEY`. |
| `baseUrl`    | `string`       | `https://webhooks.cc`    | API base URL                                                             |
| `webhookUrl` | `string`       | `https://go.webhooks.cc` | receiver base URL used by `endpoints.send()`                             |
| `timeout`    | `number`       | `30000`                  | request timeout in milliseconds                                          |
| `retry`      | `RetryOptions` | `1` attempt              | retries transient SDK requests                                           |
| `hooks`      | `ClientHooks`  | none                     | lifecycle callbacks for request logging                                  |

## API overview

- `client.endpoints`: `create`, `list`, `get`, `update`, `delete`, `send`, `sendTemplate`
- `client.requests`: `list`, `listPaginated`, `get`, `waitFor`, `waitForAll`, `subscribe`, `replay`, `search`, `count`, `clear`, `export`
- `client.templates`: `listProviders`, `get`
- top-level client methods: `usage()`, `sendTo()`, `buildRequest()`, `flow()`, `describe()`

## Endpoints

Create persistent or ephemeral endpoints. You can also attach a mock response at creation time.

```typescript
const endpoint = await client.endpoints.create({
  name: "billing-webhooks",
  expiresIn: "12h",
  mockResponse: {
    status: 202,
    body: '{"queued":true}',
    headers: { "x-webhooks-cc": "mock" },
  },
});

const fetched = await client.endpoints.get(endpoint.slug);
console.log(fetched.isEphemeral, fetched.expiresAt);

await client.endpoints.update(endpoint.slug, {
  name: "billing-webhooks-renamed",
  mockResponse: null,
});
```

Send plain test requests through the hosted receiver:

```typescript
await client.endpoints.send(endpoint.slug, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { event: "invoice.paid" },
});
```

## Requests

List, paginate, wait, stream, replay, export, and clear captured requests.

```typescript
const recent = await client.requests.list(endpoint.slug, {
  limit: 50,
  since: Date.now() - 60_000,
});

const page1 = await client.requests.listPaginated(endpoint.slug, { limit: 100 });
const page2 = page1.cursor
  ? await client.requests.listPaginated(endpoint.slug, { limit: 100, cursor: page1.cursor })
  : { items: [], hasMore: false };

const firstMatch = await client.requests.waitFor(endpoint.slug, {
  timeout: "20s",
  match: matchHeader("stripe-signature"),
});

const allMatches = await client.requests.waitForAll(endpoint.slug, {
  count: 3,
  timeout: "30s",
  match: matchMethod("POST"),
});

for await (const request of client.requests.subscribe(endpoint.slug, { reconnect: true })) {
  console.log(request.method, request.path);
}
```

Replay, export, and clear requests:

```typescript
await client.requests.replay(firstMatch.id, "http://localhost:3001/webhooks");

const curlExport = await client.requests.export(endpoint.slug, {
  format: "curl",
  limit: 10,
});

const harExport = await client.requests.export(endpoint.slug, {
  format: "har",
  since: Date.now() - 3_600_000,
});

await client.requests.clear(endpoint.slug, { before: "24h" });
```

Search and count use the retained request store rather than the live endpoint request table:

```typescript
const retained = await client.requests.search({
  slug: endpoint.slug,
  q: "checkout.session.completed",
  from: "7d",
  limit: 20,
});

const total = await client.requests.count({
  slug: endpoint.slug,
  q: "checkout.session.completed",
  from: "7d",
});
```

`search()` returns `SearchResult[]`. Their `id` field is synthetic and is not valid for `requests.get()` or `requests.replay()`.

## Templates, sendTo, and buildRequest

The SDK can generate signed webhook payloads for:

- `stripe`
- `github`
- `shopify`
- `twilio`
- `slack`
- `paddle`
- `linear`
- `standard-webhooks`

Inspect the static provider metadata:

```typescript
const providers = client.templates.listProviders();
const stripe = client.templates.get("stripe");

console.log(providers);
console.log(stripe.signatureHeader, stripe.templates);
```

If you prefer a static export, import `TEMPLATE_METADATA` from `@webhooks-cc/sdk`.

Send a signed provider template through a hosted endpoint:

```typescript
await client.endpoints.sendTemplate(endpoint.slug, {
  provider: "slack",
  template: "slash_command",
  secret: process.env.SLACK_SIGNING_SECRET!,
});
```

Build or send a signed request directly to any URL:

```typescript
const preview = await client.buildRequest("http://localhost:3001/webhooks", {
  provider: "stripe",
  template: "checkout.session.completed",
  secret: "whsec_test_123",
});

await client.sendTo("http://localhost:3001/webhooks", {
  provider: "github",
  template: "push",
  secret: "github_secret",
});
```

## Signature verification

The SDK includes provider-specific verification helpers and a provider-agnostic `verifySignature()`.

Provider-specific helpers such as `verifyStripeSignature()` and `verifyDiscordSignature()` are also exported.

Supported verification providers:

- `stripe`
- `github`
- `shopify`
- `twilio`
- `slack`
- `paddle`
- `linear`
- `discord`
- `standard-webhooks`

```typescript
import { isDiscordWebhook, verifySignature } from "@webhooks-cc/sdk";

if (isDiscordWebhook(request)) {
  const result = await verifySignature(request, {
    provider: "discord",
    publicKey: process.env.DISCORD_PUBLIC_KEY!,
  });

  console.log(result.valid);
}
```

For Twilio, pass the original signed URL:

```typescript
const result = await verifySignature(request, {
  provider: "twilio",
  secret: process.env.TWILIO_AUTH_TOKEN!,
  url: "https://example.com/webhooks/twilio",
});
```

Discord support is verification-only. It is not part of the template generation API.

Request detection helpers are exported too: `isStripeWebhook()`, `isGitHubWebhook()`, `isShopifyWebhook()`, `isSlackWebhook()`, `isTwilioWebhook()`, `isPaddleWebhook()`, `isLinearWebhook()`, `isDiscordWebhook()`, and `isStandardWebhook()`.

## Matchers, parsing, and diffing

Use matchers with `waitFor()` or `waitForAll()`:

```typescript
import {
  matchAll,
  matchBodySubset,
  matchContentType,
  matchHeader,
  matchPath,
  matchQueryParam,
} from "@webhooks-cc/sdk";

const request = await client.requests.waitFor(endpoint.slug, {
  match: matchAll(
    matchPath("/webhooks/stripe"),
    matchHeader("stripe-signature"),
    matchContentType("application/json"),
    matchQueryParam("tenant", "acme"),
    matchBodySubset({ type: "checkout.session.completed" })
  ),
});
```

`matchAny()`, `matchBodyPath()`, and `matchJsonField()` are available when you need looser matching.

Parse request bodies and diff captures:

```typescript
import { diffRequests, extractJsonField, parseBody, parseFormBody } from "@webhooks-cc/sdk";

const parsed = parseBody(request);
const form = parseFormBody(request);
const eventType = extractJsonField<string>(request, "type");

const diff = diffRequests(previousRequest, request, {
  ignoreHeaders: ["date", "x-request-id"],
});

console.log(parsed, form, eventType, diff.matches);
```

## Testing helpers

`@webhooks-cc/sdk/testing` adds a small test-oriented layer:

- `withEndpoint()`
- `withEphemeralEndpoint()`
- `captureDuring()`
- `assertRequest()`

```typescript
import { matchHeader, WebhooksCC } from "@webhooks-cc/sdk";
import { assertRequest, captureDuring } from "@webhooks-cc/sdk/testing";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

const [request] = await captureDuring(
  client,
  async (endpoint) => {
    await yourApp.registerWebhook(endpoint.url!);
    await yourApp.triggerCheckout();
  },
  {
    expiresIn: "1h",
    timeout: "20s",
    match: matchHeader("stripe-signature"),
  }
);

assertRequest(
  request,
  {
    method: "POST",
    bodyJson: { type: "checkout.session.completed" },
  },
  { throwOnFailure: true }
);
```

## Flow builder

`client.flow()` composes the common test sequence into one chain: create endpoint, optionally set a mock, send a request, wait for capture, verify the signature, replay the request, and clean up.

```typescript
const result = await client
  .flow()
  .createEndpoint({ expiresIn: "1h" })
  .sendTemplate({
    provider: "github",
    template: "push",
    secret: "github_secret",
  })
  .waitForCapture({ timeout: "15s" })
  .verifySignature({
    provider: "github",
    secret: "github_secret",
  })
  .cleanup()
  .run();

console.log(result.request?.id, result.verification?.valid, result.cleanedUp);
```

## Usage and self-description

Check quota state from code:

```typescript
const usage = await client.usage();
console.log(usage.used, usage.limit, usage.remaining, usage.plan);
```

Ask the client what it supports without making an API call:

```typescript
const description = client.describe();
console.log(description.requests.waitForAll);
```

## Errors

API failures throw typed errors:

- `WebhooksCCError`
- `UnauthorizedError`
- `NotFoundError`
- `TimeoutError`
- `RateLimitError`

`ApiError` is still exported as a legacy alias of `WebhooksCCError`.

## License

MIT
