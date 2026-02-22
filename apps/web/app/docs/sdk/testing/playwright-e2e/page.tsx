import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "E2E Webhook Testing with Playwright",
  description:
    "Run full browser-to-backend webhook tests with Playwright and assert captured webhook events, payloads, and headers using @webhooks-cc/sdk.",
  path: "/docs/sdk/testing/playwright-e2e",
});

export default function PlaywrightE2EPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Playwright E2E</h1>
      <p className="text-lg text-muted-foreground mb-8">
        Combine browser automation with webhook assertions for end-to-end checkout or onboarding
        flows.
      </p>

      <pre className="neo-code text-sm mb-8">{`import { test, expect } from "@playwright/test";
import { WebhooksCC, matchJsonField } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

test("checkout triggers webhook", async ({ page }) => {
  const endpoint = await client.endpoints.create({ name: "playwright-e2e" });
  try {
    await page.goto(process.env.APP_URL!);
    await page.fill("[name=email]", "qa@example.com");
    await page.click("button[data-testid=checkout]");

    const req = await client.requests.waitFor(endpoint.slug, {
      timeout: "45s",
      match: matchJsonField("event", "checkout.completed"),
    });

    expect(req.method).toBe("POST");
  } finally {
    await client.endpoints.delete(endpoint.slug);
  }
});`}</pre>

      <p className="text-muted-foreground">
        Tip: keep endpoint creation/deletion inside each test for parallel-safe runs.
      </p>
    </article>
  );
}
