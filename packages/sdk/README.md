# @webhooks-cc/sdk

TypeScript SDK for [webhooks.cc](https://webhooks.cc). Create webhook endpoints, capture and search requests, wait for emails and read their codes and links, forward emails to your server, send signed test webhooks, verify provider signatures, and build webhook tests with less boilerplate.

## Install

```bash
pnpm add @webhooks-cc/sdk
```

The package also ships a testing entrypoint, and an email entrypoint with no network code:

```typescript
import { captureDuring, captureEmailDuring, assertRequest } from "@webhooks-cc/sdk/testing";
import { extractCode, type EmailReceivedEvent } from "@webhooks-cc/sdk/email";
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

## Without an API key (AI agents)

An agent can capture webhooks before anyone signs up. `WebhooksCC.sandbox()` registers through [auth.md](https://webhooks.cc/auth.md), solves a short proof of work (about 3 seconds) and returns a sandbox: up to 3 endpoints, 25 captured requests each and 100 in all, for 24 hours.

```ts
import { WebhooksCC } from "@webhooks-cc/sdk";

const sandbox = await WebhooksCC.sandbox({ clientName: "my-agent" });
const endpoint = await sandbox.endpoints.create();
const request = await sandbox.requests.waitFor(endpoint.slug, { timeout: "60s" });

// Connect it to a human's account: they open the link, sign in and enter the code.
const { verificationUri, userCode } = await sandbox.claim({ email: "dev@example.com" });
console.log(`Open ${verificationUri}, sign in, and enter ${userCode}`);
const client = await sandbox.waitForClaim(); // a WebhooksCC for that account
```

`WebhooksCC.agent.*` exposes the auth.md steps one by one. See [AI Agents](https://webhooks.cc/docs/agents).

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

| Option        | Type           | Default                  | Notes                                                                    |
| ------------- | -------------- | ------------------------ | ------------------------------------------------------------------------ |
| `apiKey`      | `string`       | required                 | API key in `whcc_...` format. Often read from `process.env.WHK_API_KEY`. |
| `baseUrl`     | `string`       | `https://webhooks.cc`    | API base URL                                                             |
| `webhookUrl`  | `string`       | `https://go.webhooks.cc` | receiver base URL used by `endpoints.send()`                             |
| `timeout`     | `number`       | `30000`                  | request timeout in milliseconds                                          |
| `retry`       | `RetryOptions` | `1` attempt              | retries transient SDK requests                                           |
| `hooks`       | `ClientHooks`  | none                     | lifecycle callbacks for request logging                                  |
| `emailDomain` | `string`       | `mailhooks.cc`           | domain `emails.address()` builds addresses on                            |

## API overview

- `client.endpoints`: `create`, `list`, `get`, `update`, `delete`, `send`, `sendTemplate`
- `client.requests`: `list`, `listPaginated`, `get`, `waitFor`, `waitForAll`, `subscribe`, `replay`, `search`, `count`, `clear`, `export`
- `client.emails`: `address`, `list`, `get`, `latest`, `waitFor`, `waitForAll`, `sendTest`, `toJson`
- `client.forwarding`: `configure`, `secret`, `rotateSecret`, `test`, `deliveries`, `emailDeliveries`, `redeliver`
- `client.templates`: `listProviders`, `get`
- `client.teams`: `list`, `members`, `share`, `unshare`, `invite`, `invites.list`, `invites.accept`, `invites.decline`
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
  kind: "http", // or "email"; omit for both
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

`subscribe()` streams over SSE. The server rotates every stream connection after 30 minutes: it
sends a `timeout` event and closes. With `reconnect: true` the client follows that rotation
transparently, reconnecting immediately, resuming from the last received request, and deduplicating
replayed events, so the loop above runs until you break out of it, abort the `signal`, the `timeout`
expires, or the endpoint is deleted. Rotations do not count against `maxReconnectAttempts`
(default 5), which only limits recovery from unexpected stream ends and transient errors (with
exponential backoff from `reconnectBackoffMs`). Without `reconnect`, the loop ends at the first
rotation, after at most 30 minutes.

An idle watchdog (`idleTimeout`, default `"90s"`, three server keepalive intervals) detects
half-open sockets: if nothing arrives within that window while waiting, the connection is dropped.
With `reconnect: true` it is reconnected (counted as a reconnect attempt, with backoff); without it,
the iterator throws `TimeoutError`. Pass `idleTimeout: 0` to disable the watchdog.

```typescript
for await (const request of client.requests.subscribe(endpoint.slug, {
  reconnect: true,
  maxReconnectAttempts: 10,
  idleTimeout: "2m",
  onReconnect: (attempt) => console.warn(`stream reconnect #${attempt}`),
})) {
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

`requests.list()`, `listPaginated()`, `search()` and `count()` take `kind: "http" | "email"`.
`waitFor()` and `waitForAll()` look back five minutes by default, so a request that arrived just
before the call is found; pass `since` to change that.

## Emails

Every endpoint on an account also receives email at `<slug>@mailhooks.cc`, and at
`<slug>+<tag>@mailhooks.cc` for any tag. Guest endpoints receive none. A captured email is a
request with `kind: "email"`, `method: "EMAIL"`, the recipient address as `path`, the raw message
as `body`, and the parsed message as `email` (typed `EmailRequest`). Each email counts as one
request against your quota.

Give each test run its own tag, wait for its email, and pull out the code or link:

```typescript
import { extractCode, extractLink } from "@webhooks-cc/sdk";

const runId = `signup-${Date.now()}`;
await yourApp.signUp({ email: client.emails.address(endpoint.slug, runId) });

const email = await client.emails.waitFor(endpoint.slug, { tag: runId, timeout: "60s" });
console.log(email.email.subject, email.email.from[0]?.address);

const code = extractCode(email); // "482913", or null
const link = extractLink(email); // the confirm, verify, reset or sign-in link, or null
```

`client.emails` methods:

- `address(endpointOrSlug, tag?)`: the address, optionally tagged. Pass the endpoint object to use
  the address the server reports; a slug uses the `emailDomain` client option
- `list(slug, { tag, subject, from, to, limit, since })`: emails newest first. `limit` (default 50)
  is how many of the newest emails are fetched before the filters apply
- `get(requestId)`: one email; throws `NotFoundError` for anything else
- `latest(slug, criteria)`: the newest matching email among the 100 newest, or `null`
- `waitFor(slug, { ...criteria, timeout, pollInterval, since, match })`: polls until a matching
  email arrives (defaults: 60 s timeout, 1 s interval, looking back five minutes)
- `waitForAll(slug, { count, ...options })`: polls until `count` matching emails arrived, oldest
  first
- `sendTest(slug, { tag? })`: delivers a sample email with a six-digit code and a link. It counts as
  one request and skips SMTP, so no sender checks run on it
- `toJson(email, { endpoint?, includeExtracts? })`: the `email.received` JSON forwarding would post

The criteria are `tag` (exact and case-sensitive; `null` matches untagged mail), `subject` (a
substring or a RegExp), `from` and `to` (an address, compared case-insensitively, or a RegExp tested
against `Name <address>`). `to` also matches the address the email was delivered to.

`extractFromEmail(email.email)` returns every code and link found (`{ codes, links }`).
`extractLink(email)` returns the confirm, verify, reset or sign-in link when there is one, otherwise
the first link worth keeping; pass `{ actionOnly: true }` to accept only an action link.

`matchEmail(criteria)` does the same filtering as a matcher for `requests.waitFor()` or
`captureDuring()`, and `isEmailRequest(request)` narrows a request to `EmailRequest`. Requests from
`requests.subscribe()` carry `kind` but not the parsed `email`; fetch it with
`client.emails.get(request.id)`. `requests.replay()` throws for emails, `requests.export()` skips
them, and provider detection ignores them.

The `@webhooks-cc/sdk/email` entry point exports the email types, `extractCode`, `extractLink`,
`extractFromEmail`, `htmlToText`, `buildEmailJson`, `emailAddress` and `isValidEmailTag`. It has
no network code, so it fits in a browser bundle.

## Forwarding

Forwarding posts every email an endpoint captures to your server as signed `email.received` JSON,
retried for about a day until your server answers 2xx. Only the endpoint's owner can manage it.

```typescript
await client.forwarding.configure(endpoint.slug, { url: "https://example.com/hooks/email" });
const secret = await client.forwarding.secret(endpoint.slug); // "whsec_..."

const test = await client.forwarding.test(endpoint.slug); // posts the newest email or a sample once
console.log(test.delivered, test.status, test.excerpt);

await client.forwarding.configure(endpoint.slug, { enabled: true });
```

`client.forwarding` also has `rotateSecret(slug)`, `deliveries(slug, { limit })` (latest
deliveries, 1 to 20, default 5), `emailDeliveries(requestId)` (every try of one email) and
`redeliver(requestId)`. `configure({ url: null })` removes the URL once forwarding is off.

Verify deliveries in your handler with `verifyForwardedEmail()`. It checks the Standard Webhooks
signature and that the timestamp is within five minutes, then returns the typed event. Pass the raw
body (string, `Uint8Array`/`Buffer` or `ArrayBuffer`) and the headers as a Fetch `Headers`, a plain
object such as Express's `req.headers`, or name and value pairs:

```typescript
import { verifyForwardedEmail, WebhookVerificationError } from "@webhooks-cc/sdk";

export async function POST(request: Request) {
  try {
    const event = await verifyForwardedEmail(
      await request.text(),
      request.headers,
      process.env.FORWARD_SECRET!
    );
    console.log(event.data.subject, event.data.codes);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      // error.code: missing_headers | timestamp_out_of_range | invalid_signature | invalid_payload
      return new Response(error.message, { status: error.code === "invalid_payload" ? 400 : 401 });
    }
    throw error;
  }
}
```

To test a handler on your machine without forwarding, post a captured email to it, signed with your
secret:

```typescript
const email = await client.emails.latest(endpoint.slug);
if (email) {
  await client.sendTo("http://localhost:3000/hooks/email", {
    provider: "standard-webhooks",
    secret: process.env.FORWARD_SECRET!,
    body: client.emails.toJson(email),
  });
}
```

## Templates, sendTo, and buildRequest

The SDK can generate provider-shaped webhook payloads (signed where the provider uses a shared
secret or public test key flow) for:

- `stripe`
- `github`
- `shopify`
- `twilio`
- `slack`
- `paddle`
- `linear`
- `sendgrid`
- `clerk`
- `discord`
- `vercel`
- `gitlab`
- `typeform`
- `standard-webhooks`
- `meta`
- `lemonsqueezy`
- `coinbase-commerce`
- `razorpay`
- `cal`
- `intercom`
- `telegram`
- `square`
- `hubspot`
- `mailgun`
- `calendly`
- `mux`
- `sentry`
- `bitbucket`
- `docusign`
- `adyen`
- `paypal`
- `plaid`
- `resend`
- `workos`

`sendgrid`, `discord`, `paypal`, and `plaid` templates are intentionally not shared-secret signed:
SendGrid uses IP allowlisting, Discord/PayPal signatures require provider-owned private keys, and
Plaid verification uses Plaid JWT/JWK lookup.

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
- `clerk`
- `discord`
- `vercel`
- `gitlab`
- `typeform`
- `standard-webhooks`
- `meta`
- `lemonsqueezy`
- `coinbase-commerce`
- `razorpay`
- `cal`
- `intercom`
- `telegram`
- `square`
- `hubspot`
- `mailgun`
- `calendly`
- `mux`
- `sentry`
- `bitbucket`
- `docusign`
- `adyen`
- `paypal`
- `resend`
- `workos`

`sendgrid` and `plaid` are template-only for verification: SendGrid uses IP allowlisting, and Plaid
JWT/JWK verification requires Plaid API credentials.

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

For Twilio, Square, and HubSpot, pass the original signed URL. HubSpot v3 also signs the HTTP method, so pass `method` too:

```typescript
const result = await verifySignature(request, {
  provider: "twilio",
  secret: process.env.TWILIO_AUTH_TOKEN!,
  url: "https://example.com/webhooks/twilio",
});

// HubSpot v3 signs `method + url + body + timestamp` and rejects stale timestamps
const hubspot = await verifySignature(request, {
  provider: "hubspot",
  secret: process.env.HUBSPOT_CLIENT_SECRET!,
  url: "https://example.com/webhooks/hubspot",
  method: "POST",
});
```

Mailgun is the exception with no signature header: it embeds `signature.{timestamp,token,signature}` in the request body, so `verifyMailgunSignature` reads the body directly and never throws on malformed input.

SendGrid uses IP allowlisting rather than cryptographic signature verification.

Request detection helpers are exported for every supported provider:

```text
isStripeWebhook        isGitHubWebhook         isShopifyWebhook     isSlackWebhook
isTwilioWebhook        isPaddleWebhook         isLinearWebhook      isSendGridWebhook
isClerkWebhook         isDiscordWebhook        isVercelWebhook      isGitLabWebhook
isTypeformWebhook      isStandardWebhook       isMetaWebhook        isLemonSqueezyWebhook
isCoinbaseCommerceWebhook  isRazorpayWebhook   isCalWebhook         isIntercomWebhook
isTelegramWebhook      isSquareWebhook         isHubSpotWebhook     isMailgunWebhook
isCalendlyWebhook      isMuxWebhook            isSentryWebhook      isBitbucketWebhook
isDocuSignWebhook      isAdyenWebhook          isPayPalWebhook      isPlaidWebhook
isResendWebhook        isWorkOSWebhook
```

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
`matchEmail({ tag, subject, from, to })` matches captured emails; see [Emails](#emails).

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
- `captureEmailDuring()`
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

`captureEmailDuring()` creates a temporary endpoint, runs your action with its email address, waits
for the email, and deletes the endpoint:

```typescript
import { extractCode } from "@webhooks-cc/sdk";
import { captureEmailDuring } from "@webhooks-cc/sdk/testing";

const [email] = await captureEmailDuring(
  client,
  async (address) => {
    await yourApp.signUp({ email: address });
  },
  { subject: "Confirm your email", timeout: "30s" }
);

console.log(extractCode(email));
```

It takes the email criteria (`tag`, `subject`, `from`, `to`), `count` (default 1), `timeout`
(default 60 s), `pollInterval`, `match`, and the options of `endpoints.create()`.

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

## Teams

A key has exactly the team access of the account it belongs to. Endpoints shared with you through a subscribed team appear in `endpoints.list()` with `fromTeam` set and work with every request method by slug except `requests.clear`, which stays with the owner. The `teams` namespace manages the teams themselves:

```typescript
const teams = await client.teams.list();
// [{ id, name, role, seats, requestsUsed, requestLimit, periodEnd, suspended, ... }]

// Only endpoints tied to one team (id or name), shared either way
const payments = await client.endpoints.list({ team: "Payments" });

// Owner-only: share an endpoint you own, by slug. Its requests then bill the team pool.
await client.teams.share(teams[0].id, "my-stripe");
await client.teams.unshare(teams[0].id, "my-stripe");

const { members, pendingInvites } = await client.teams.members(teams[0].id);

// Invites: sending one emails the address; accepting claims a paid seat.
await client.teams.invite(teams[0].id, "dev@example.com");
const invites = await client.teams.invites.list();
await client.teams.invites.accept(invites[0].id);
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
- `TimeoutError` (also thrown by `requests.subscribe()` when the idle watchdog trips without `reconnect`)
- `RateLimitError`

`verifyForwardedEmail()` throws `WebhookVerificationError`, whose `code` is `missing_headers`,
`timestamp_out_of_range`, `invalid_signature` or `invalid_payload`.

`ApiError` is still exported as a legacy alias of `WebhooksCCError`.

## License

MIT
