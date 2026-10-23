# Webhook tests with @webhooks-cc/sdk

Install the SDK as a dev dependency (`npm i -D @webhooks-cc/sdk`, or the
project's package manager) and read the API key from `WHK_API_KEY`, which CI
gets from a secret. Adapt the recipes to the project's test runner, routes and
env var names.

```ts
import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });
```

## A handler accepts signed payloads and rejects forged ones

`sendTo` signs the request the way the provider does and posts it straight to
your URL. The app must be running (a dev server, Playwright's `webServer`, or
a test global setup).

```ts
import { describe, expect, it } from "vitest";

const url = "http://localhost:3000/api/webhooks/stripe";
const secret = process.env.STRIPE_WEBHOOK_SECRET!;

describe("Stripe webhook handler", () => {
  it("handles checkout.session.completed", async () => {
    const response = await client.sendTo(url, {
      provider: "stripe",
      template: "checkout.session.completed",
      secret,
    });
    expect(response.status).toBe(200);
    // Assert the side effect too: the order is marked paid, a job is queued...
  });

  it("rejects a signature made with another secret", async () => {
    const response = await client.sendTo(url, {
      provider: "stripe",
      template: "checkout.session.completed",
      secret: "whsec_not_the_real_one",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
```

Pass `body` to send your own payload, signed the same way, for example to
cover an edge case the template does not have. Template names per provider
come from `client.templates.get("stripe").templates`.

## The app sends the webhooks it should

`captureDuring` creates a temporary endpoint, runs your action with it, waits
for the delivery and deletes the endpoint.

```ts
import { matchHeader } from "@webhooks-cc/sdk";
import { assertRequest, captureDuring } from "@webhooks-cc/sdk/testing";

it("notifies the customer's webhook when an order is created", async () => {
  const [request] = await captureDuring(
    client,
    async (endpoint) => {
      await app.settings.setWebhookUrl(endpoint.url!);
      await app.orders.create({ total: 4200 });
    },
    { expiresIn: "1h", timeout: "20s", match: matchHeader("x-acme-signature") }
  );

  assertRequest(
    request,
    { method: "POST", bodyJson: { type: "order.created" } },
    { throwOnFailure: true }
  );
});
```

## A signup sends a code or magic link (Playwright)

Create one endpoint for end-to-end mail on an account (sandbox endpoints get
no email) and keep its slug in `WHK_EMAIL_SLUG`. A tag per run keeps parallel
runs apart.

```ts
import { expect, test } from "@playwright/test";
import { WebhooksCC, extractCode, extractLink } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });
const slug = process.env.WHK_EMAIL_SLUG!;

test("sign up with the emailed code", async ({ page }) => {
  const tag = `signup-${Date.now()}`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(client.emails.address(slug, tag));
  await page.getByRole("button", { name: "Sign up" }).click();

  const email = await client.emails.waitFor(slug, { tag, timeout: "60s" });
  await page.getByLabel("Code").fill(extractCode(email)!);
  // For a magic link instead: await page.goto(extractLink(email)!);
  await expect(page.getByText("Welcome")).toBeVisible();
});
```

## Types from captured requests

The same generator as the `generate_payload_schema` tool, for scripts:

```ts
import { generateRequestSchema } from "@webhooks-cc/sdk";

const requests = await client.requests.list("acme-stripe", { limit: 20 });
const { code, samples } = generateRequestSchema(requests, {
  format: "zod", // or "typescript", "pydantic", "json-schema"
  name: "InvoicePaidEvent",
});
```
