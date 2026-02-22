import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "GitHub Webhook Assertions with Jest",
  description:
    "Example Jest integration test that validates GitHub webhook event type, headers, and payload fields with @webhooks-cc/sdk.",
  path: "/docs/sdk/testing/github-jest",
});

export default function GitHubJestPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">GitHub + Jest</h1>
      <p className="text-lg text-muted-foreground mb-8">
        Validate push and pull request webhook events in a Jest integration suite.
      </p>

      <pre className="neo-code text-sm mb-8">{`import { WebhooksCC, matchHeader, matchBodyPath, matchAll } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

test("receives GitHub push webhook", async () => {
  const endpoint = await client.endpoints.create({ name: "github-jest" });
  try {
    await triggerGitHubPush({ webhookUrl: endpoint.url! });

    const req = await client.requests.waitFor(endpoint.slug, {
      timeout: "20s",
      match: matchAll(
        matchHeader("x-github-event", "push"),
        matchBodyPath("ref", "refs/heads/main")
      ),
    });

    expect(req.headers["x-github-event"]).toBe("push");
  } finally {
    await client.endpoints.delete(endpoint.slug);
  }
});`}</pre>

      <p className="text-muted-foreground">
        Next:{" "}
        <Link href="/docs/sdk/testing/playwright-e2e" className="text-primary font-bold">
          Playwright E2E
        </Link>
      </p>
    </article>
  );
}
