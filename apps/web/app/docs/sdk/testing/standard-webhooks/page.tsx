import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Standard Webhooks Testing with Vitest",
  description:
    "Test Standard Webhooks handlers (Polar, Svix, Clerk, Resend) locally using @webhooks-cc/sdk sendTo with signed payloads and Vitest assertions.",
  path: "/docs/sdk/testing/standard-webhooks",
});

export default function StandardWebhooksPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Standard Webhooks + Vitest</h1>
      <p className="text-lg text-muted-foreground mb-8">
        Test webhook handlers for services that use the{" "}
        <strong className="text-foreground">Standard Webhooks</strong> spec — Polar.sh, Svix, Clerk,
        Resend, and others. Uses <code className="font-mono font-bold">sendTo</code> to send signed
        payloads directly to localhost.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Test a Polar webhook handler</h2>
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhooks-cc/sdk";
import { describe, it, expect } from "vitest";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

describe("polar webhook handler", () => {
  it("processes subscription.created", async () => {
    const res = await client.sendTo("http://localhost:3000/api/webhooks/polar", {
      provider: "standard-webhooks",
      secret: process.env.POLAR_WEBHOOK_SECRET!,
      body: {
        type: "subscription.created",
        timestamp: new Date().toISOString(),
        data: {
          id: "sub_test_123",
          status: "active",
          customer: {
            id: "cust_1",
            email: "test@example.com",
            name: "Test User",
          },
          recurring_interval: "month",
          current_period_start: "2026-03-08T00:00:00Z",
          current_period_end: "2026-04-08T00:00:00Z",
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("processes subscription.canceled", async () => {
    const res = await client.sendTo("http://localhost:3000/api/webhooks/polar", {
      provider: "standard-webhooks",
      secret: process.env.POLAR_WEBHOOK_SECRET!,
      body: {
        type: "subscription.canceled",
        timestamp: new Date().toISOString(),
        data: {
          id: "sub_test_123",
          status: "canceled",
          customer: {
            id: "cust_1",
            email: "test@example.com",
            name: "Test User",
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("rejects invalid signatures", async () => {
    const res = await client.sendTo("http://localhost:3000/api/webhooks/polar", {
      provider: "standard-webhooks",
      secret: "d3Jvbmctc2VjcmV0", // wrong secret (base64 of "wrong-secret")
      body: { type: "subscription.created", data: {} },
    });

    // Your handler should reject invalid signatures
    expect(res.status).toBe(401);
  });
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">How Standard Webhooks signing works</h2>
        <p className="text-muted-foreground mb-4">
          The SDK generates three headers per the{" "}
          <strong className="text-foreground">Standard Webhooks</strong> spec:
        </p>
        <div className="neo-code text-sm overflow-x-auto mb-4">
          <table className="w-full">
            <thead>
              <tr className="border-b border-foreground/20">
                <th className="text-left py-1.5 pr-3 font-bold">Header</th>
                <th className="text-left py-1.5 font-bold">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-3">
                  <code>webhook-id</code>
                </td>
                <td className="py-1.5 text-muted-foreground">
                  Unique message ID (e.g. <code>msg_a1b2c3...</code>)
                </td>
              </tr>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-3">
                  <code>webhook-timestamp</code>
                </td>
                <td className="py-1.5 text-muted-foreground">Unix timestamp in seconds</td>
              </tr>
              <tr className="border-b border-foreground/20 last:border-0">
                <td className="py-1.5 pr-3">
                  <code>webhook-signature</code>
                </td>
                <td className="py-1.5 text-muted-foreground">
                  <code>v1,&lt;base64(HMAC-SHA256(secret, msgId.timestamp.body))&gt;</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground">
          The secret should be base64-encoded, matching what providers give you. Secrets with a{" "}
          <code className="font-mono font-bold">whsec_</code> prefix are handled automatically.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Capture and inspect with webhooks.cc</h2>
        <p className="text-muted-foreground mb-4">
          You can also send Standard Webhooks to a webhooks.cc endpoint using{" "}
          <code className="font-mono font-bold">sendTemplate</code>, then inspect the headers and
          signature:
        </p>
        <pre className="neo-code text-sm">{`import { WebhooksCC, isStandardWebhook, matchHeader } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

describe("standard webhooks inspection", () => {
  let endpoint: Awaited<ReturnType<typeof client.endpoints.create>>;

  beforeAll(async () => {
    endpoint = await client.endpoints.create({ name: "stdwhk-test" });
  });

  afterAll(async () => {
    await client.endpoints.delete(endpoint.slug);
  });

  it("sends and captures a signed Standard Webhook", async () => {
    await client.endpoints.sendTemplate(endpoint.slug, {
      provider: "standard-webhooks",
      secret: process.env.POLAR_WEBHOOK_SECRET!,
      event: "subscription.created",
      body: { type: "subscription.created", data: { id: "sub_1" } },
    });

    const req = await client.requests.waitFor(endpoint.slug, {
      timeout: "10s",
      match: matchHeader("webhook-signature"),
    });

    expect(isStandardWebhook(req)).toBe(true);
    expect(req.headers["webhook-id"]).toMatch(/^msg_subscription\\.created_/);
    expect(req.headers["webhook-signature"]).toMatch(/^v1,/);

    const body = JSON.parse(req.body!);
    expect(body.type).toBe("subscription.created");
  });
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Deterministic signatures for snapshots</h2>
        <p className="text-muted-foreground mb-4">
          Pass a fixed <code className="font-mono font-bold">timestamp</code> to generate
          deterministic signatures, useful for snapshot testing:
        </p>
        <pre className="neo-code text-sm">{`const res = await client.sendTo("http://localhost:3000/api/webhooks", {
  provider: "standard-webhooks",
  secret: "dGVzdC1zZWNyZXQ=", // base64("test-secret")
  timestamp: 1700000000,       // fixed timestamp
  body: { type: "test.event", data: {} },
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Services using Standard Webhooks</h2>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
          <li>
            <strong className="text-foreground">Polar.sh</strong> — subscription, order, and benefit
            events
          </li>
          <li>
            <strong className="text-foreground">Svix</strong> — webhook delivery infrastructure
          </li>
          <li>
            <strong className="text-foreground">Clerk</strong> — user and session events
          </li>
          <li>
            <strong className="text-foreground">Resend</strong> — email delivery events
          </li>
          <li>
            <strong className="text-foreground">Liveblocks</strong> — collaboration events
          </li>
          <li>
            <strong className="text-foreground">Novu</strong> — notification events
          </li>
        </ul>
      </section>

      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">More examples</h2>
        <ul className="space-y-2">
          <li>
            <Link
              href="/docs/sdk/testing/stripe-vitest"
              className="text-primary hover:underline font-bold"
            >
              Stripe + Vitest
            </Link>{" "}
            <span className="text-muted-foreground">- payment webhook assertions</span>
          </li>
          <li>
            <Link
              href="/docs/sdk/testing/github-jest"
              className="text-primary hover:underline font-bold"
            >
              GitHub + Jest
            </Link>{" "}
            <span className="text-muted-foreground">- push event verification</span>
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
        </ul>
      </section>
    </article>
  );
}
