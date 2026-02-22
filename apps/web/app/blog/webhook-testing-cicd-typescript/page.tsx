import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogPostShell } from "@/components/blog/blog-post-shell";
import { getBlogPostBySlug } from "@/lib/blog";
import { createBlogPostMetadata, createPageMetadata } from "@/lib/seo";

const post = getBlogPostBySlug("webhook-testing-cicd-typescript");

export const metadata = post
  ? createBlogPostMetadata(post)
  : createPageMetadata({
      title: "Webhook testing in CI/CD with TypeScript",
      description:
        "Create deterministic webhook integration tests in CI with endpoint setup, strict request matching, assertions, and teardown using the TypeScript SDK.",
      path: "/blog/webhook-testing-cicd-typescript",
    });

const sections = [
  { id: "why-ci", label: "Why CI webhook tests" },
  { id: "install", label: "Install and auth" },
  { id: "test-flow", label: "End-to-end test flow" },
  { id: "matcher-strategy", label: "Matcher strategy" },
  { id: "cleanup", label: "Cleanup and isolation" },
] as const;

export default function CiTypescriptBlogPage() {
  if (!post) notFound();

  return (
    <BlogPostShell post={post} sections={sections}>
      <p>
        Manual testing catches obvious issues, but CI is where webhook regressions should fail fast.
        The SDK gives you a repeatable pattern: create endpoint, trigger behavior, wait for a
        matching webhook, assert payload, delete endpoint.
      </p>

      <h2 id="why-ci">Why CI webhook tests matter</h2>
      <p>
        Most webhook bugs are contract bugs: missing headers, wrong event names, and payload shape
        drift. Unit tests usually miss these. Integration tests with captured real HTTP requests do
        not.
      </p>

      <h2 id="install">1. Install and configure auth</h2>
      <pre className="neo-code text-sm">{`npm install @webhooks-cc/sdk`}</pre>
      <pre className="neo-code text-sm">{`# GitHub Actions
env:
  WHK_API_KEY: \${{ secrets.WHK_API_KEY }}`}</pre>
      <p>Keep API keys in CI secrets only. Never commit them in repo config files.</p>

      <h2 id="test-flow">2. End-to-end test flow</h2>
      <pre className="neo-code text-sm">{`import { WebhooksCC, matchAll, matchMethod, matchBodyPath } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

it("emits payment.success webhook", async () => {
  const endpoint = await client.endpoints.create({ name: "ci-payments" });

  try {
    await triggerPaymentFlow({ webhookUrl: endpoint.url });

    const req = await client.requests.waitFor(endpoint.slug, {
      timeout: "30s",
      match: matchAll(
        matchMethod("POST"),
        matchBodyPath("event", "payment.success")
      ),
    });

    expect(req.headers["content-type"]).toContain("application/json");
  } finally {
    await client.endpoints.delete(endpoint.slug);
  }
});`}</pre>

      <h2 id="matcher-strategy">3. Use strict matchers</h2>
      <ul>
        <li>Match HTTP method first.</li>
        <li>Match event name from body path.</li>
        <li>Match provider signature header when relevant.</li>
        <li>Avoid broad matches that pass on unrelated requests.</li>
      </ul>
      <p>
        If your service emits multiple webhooks per flow, add one assertion per event type instead
        of one broad assertion.
      </p>

      <h2 id="cleanup">4. Cleanup and isolation</h2>
      <p>
        Endpoint-per-suite is usually enough. If tests run highly parallelized, move to
        endpoint-per-test or add unique endpoint names for each run.
      </p>
      <p>
        Continue with{" "}
        <Link href="/blog/ai-agents-debug-webhooks-mcp">
          AI-assisted webhook debugging with MCP
        </Link>
        .
      </p>
    </BlogPostShell>
  );
}
