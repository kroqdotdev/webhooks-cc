import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Polar.sh Subscription Lifecycle with Playwright",
  description:
    "Simulate the full Polar subscription lifecycle — created, updated, canceled, reactivated — by sending signed Standard Webhooks payloads to your localhost handler with Playwright.",
  path: "/docs/sdk/testing/polar-playwright",
});

export default function PolarPlaywrightPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Polar.sh + Playwright</h1>
      <p className="text-lg text-muted-foreground mb-8">
        Simulate the full Polar subscription lifecycle — created, updated, canceled, reactivated — by
        sending signed Standard Webhooks payloads directly to your localhost handler. No Polar
        dashboard needed.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Full lifecycle test</h2>
        <p className="text-muted-foreground mb-4">
          Use <code className="font-mono font-bold">test.describe.serial</code> so each step depends
          on the previous one creating state in your database:
        </p>
        <pre className="neo-code text-sm">{`import { test, expect } from "@playwright/test";
import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });
const WEBHOOK_URL = "http://localhost:3000/api/webhooks/polar";

test.describe.serial("Polar subscription lifecycle", () => {
  test("subscription.created provisions tenant", async () => {
    const res = await client.sendTo(WEBHOOK_URL, {
      provider: "standard-webhooks",
      secret: process.env.POLAR_WEBHOOK_SECRET!,
      body: {
        type: "subscription.created",
        timestamp: new Date().toISOString(),
        data: {
          id: "sub_test_001",
          status: "active",
          customer: {
            id: "cust_001",
            email: "test@example.com",
            name: "Test User",
          },
          product: {
            id: "prod_001",
            name: "Pro Plan",
          },
          recurring_interval: "month",
          current_period_start: "2026-03-08T00:00:00Z",
          current_period_end: "2026-04-08T00:00:00Z",
        },
      },
    });

    const text = await res.text();
    expect(res.status, \`Server responded: \${text}\`).toBe(200);
  });

  test("subscription.updated upgrades plan", async () => {
    const res = await client.sendTo(WEBHOOK_URL, {
      provider: "standard-webhooks",
      secret: process.env.POLAR_WEBHOOK_SECRET!,
      body: {
        type: "subscription.updated",
        timestamp: new Date().toISOString(),
        data: {
          id: "sub_test_001",
          status: "active",
          customer: {
            id: "cust_001",
            email: "test@example.com",
            name: "Test User",
          },
          product: {
            id: "prod_002",
            name: "Enterprise Plan",
          },
          recurring_interval: "year",
          current_period_end: "2027-03-08T00:00:00Z",
        },
      },
    });

    const text = await res.text();
    expect(res.status, \`Server responded: \${text}\`).toBe(200);
  });

  test("subscription.canceled suspends tenant", async () => {
    const res = await client.sendTo(WEBHOOK_URL, {
      provider: "standard-webhooks",
      secret: process.env.POLAR_WEBHOOK_SECRET!,
      body: {
        type: "subscription.canceled",
        timestamp: new Date().toISOString(),
        data: {
          id: "sub_test_001",
          status: "canceled",
          cancel_at_period_end: true,
          customer: {
            id: "cust_001",
            email: "test@example.com",
            name: "Test User",
          },
        },
      },
    });

    const text = await res.text();
    expect(res.status, \`Server responded: \${text}\`).toBe(200);
  });
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Inspect what the SDK sends</h2>
        <p className="text-muted-foreground mb-4">
          Use <code className="font-mono font-bold">buildRequest</code> to inspect the computed
          headers and signature without sending:
        </p>
        <pre className="neo-code text-sm">{`const { url, method, headers, body } = await client.buildRequest(
  "http://localhost:3000/api/webhooks/polar",
  {
    provider: "standard-webhooks",
    secret: process.env.POLAR_WEBHOOK_SECRET!,
    body: { type: "subscription.created", data: { id: "sub_1" } },
  }
);

console.log(headers["webhook-signature"]); // v1,<base64>
console.log(headers["webhook-id"]);        // msg_<hex>
console.log(body);                         // JSON string`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Tips</h2>
        <ul className="list-disc list-inside space-y-3 text-muted-foreground">
          <li>
            <strong className="text-foreground">Capture first, test later</strong> — Don&apos;t build
            payloads from scratch. Point your Polar webhook to a webhooks.cc endpoint first, trigger
            a real event, then copy the captured payload as your test fixture. Polar&apos;s SDK validates
            many required fields in snake_case — getting them right manually is tedious.
          </li>
          <li>
            <strong className="text-foreground">snake_case field names</strong> — Polar&apos;s webhook
            payloads use snake_case (<code className="font-mono">recurring_interval</code>,{" "}
            <code className="font-mono">current_period_end</code>). Their Zod schema rejects
            camelCase.
          </li>
          <li>
            <strong className="text-foreground">Body timestamp</strong> — Polar requires a{" "}
            <code className="font-mono">timestamp</code> ISO-8601 field in the body alongside{" "}
            <code className="font-mono">type</code> and <code className="font-mono">data</code>. The
            SDK generates the header timestamp but the body timestamp is your responsibility.
          </li>
          <li>
            <strong className="text-foreground">Error diagnosis</strong> — If your handler returns
            500, read the response body:{" "}
            <code className="font-mono">
              {`const text = await res.text(); expect(res.status, text).toBe(200);`}
            </code>
          </li>
        </ul>
      </section>

      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">More examples</h2>
        <ul className="space-y-2">
          <li>
            <Link
              href="/docs/sdk/testing/standard-webhooks"
              className="text-primary hover:underline font-bold"
            >
              Standard Webhooks + Vitest
            </Link>{" "}
            <span className="text-muted-foreground">- handler testing with signed payloads</span>
          </li>
          <li>
            <Link
              href="/docs/sdk/testing/playwright-e2e"
              className="text-primary hover:underline font-bold"
            >
              Playwright E2E
            </Link>{" "}
            <span className="text-muted-foreground">- browser flow + webhook assertions</span>
          </li>
          <li>
            <Link
              href="/docs/sdk/testing/stripe-vitest"
              className="text-primary hover:underline font-bold"
            >
              Stripe + Vitest
            </Link>{" "}
            <span className="text-muted-foreground">- payment webhook assertions</span>
          </li>
        </ul>
      </section>
    </article>
  );
}
