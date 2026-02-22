import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Stripe Webhook Testing with Vitest",
  description:
    "Example Vitest integration test using @webhooks-cc/sdk to assert Stripe webhook delivery, headers, and payload fields in CI.",
  path: "/docs/sdk/testing/stripe-vitest",
});

export default function StripeVitestPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Stripe + Vitest</h1>
      <p className="text-lg text-muted-foreground mb-8">
        End-to-end Stripe webhook assertion pattern using endpoint lifecycle setup/teardown.
      </p>

      <pre className="neo-code text-sm mb-8">{`import { WebhooksCC, matchHeader, matchJsonField, matchAll } from "@webhooks-cc/sdk";
import { describe, beforeAll, afterAll, it, expect } from "vitest";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });
let endpoint: Awaited<ReturnType<typeof client.endpoints.create>>;

describe("stripe webhooks", () => {
  beforeAll(async () => {
    endpoint = await client.endpoints.create({ name: "stripe-vitest" });
  });

  afterAll(async () => {
    await client.endpoints.delete(endpoint.slug);
  });

  it("captures payment_intent.succeeded", async () => {
    await triggerStripeCheckout({ webhookUrl: endpoint.url! });

    const req = await client.requests.waitFor(endpoint.slug, {
      timeout: "30s",
      match: matchAll(
        matchHeader("stripe-signature"),
        matchJsonField("type", "payment_intent.succeeded")
      ),
    });

    expect(req.method).toBe("POST");
  });
});`}</pre>

      <p className="text-muted-foreground">
        Next:{" "}
        <Link href="/docs/sdk/testing/github-jest" className="text-primary font-bold">
          GitHub + Jest
        </Link>
      </p>
    </article>
  );
}
