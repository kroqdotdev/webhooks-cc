import Link from "next/link";
import { GuestLiveDashboard } from "@/components/go/guest-live-dashboard";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, softwareApplicationSchema } from "@/lib/schemas";

const GO_FAQ_ITEMS = [
  {
    question: "Is there a free webhook endpoint with no signup?",
    answer:
      "Yes. The /go page creates a temporary guest endpoint so you can send a webhook and inspect the payload immediately without creating an account first.",
  },
  {
    question: "How long does a guest endpoint last?",
    answer:
      "Guest endpoints are ephemeral — they expire after 12 hours and accept up to 25 requests. Sign up free to get persistent endpoints with higher limits.",
  },
  {
    question: "Can I test webhooks locally and in CI?",
    answer:
      "Yes. Use the CLI to forward events to localhost during development and the SDK in automated test suites for CI pipelines.",
  },
  {
    question: "Can I test signed webhooks like Stripe or GitHub?",
    answer:
      "Yes. The dashboard includes signed provider templates for Stripe, GitHub, Shopify, Twilio, Slack, Paddle, and Linear. Send them to your verification code to exercise signature checks end-to-end without touching production keys.",
  },
  {
    question: "Do I need ngrok to test webhooks locally?",
    answer:
      "No. The whk CLI ships a tunnel command that forwards incoming webhooks directly to any local port. You get a stable public URL without ngrok, port forwarding, or exposing your machine's IP.",
  },
  {
    question: "Can I return a custom response to a webhook sender?",
    answer:
      "Yes. Persistent endpoints let you configure mock responses with custom status codes, headers, and JSON bodies. Conditional rules return different responses based on request method, path, or body content.",
  },
] as const;

const baseMetadata = createPageMetadata({
  title: "Free Webhook Endpoint — No Signup Required",
  description:
    "Create a free webhook endpoint and inspect requests live in seconds. No account needed. Capture payloads, view headers, and debug webhooks instantly.",
  path: "/go",
  keywords: [
    "free webhook endpoint",
    "guest webhook endpoint",
    "live webhook test",
    "test webhook online",
    "webhook request inspector",
    "instant webhook url",
    "webhook capture free",
    "webhook payload viewer",
  ],
});

export const metadata = {
  ...baseMetadata,
  alternates: {
    ...baseMetadata.alternates,
    languages: {
      "en-US": "/go",
      "x-default": "/go",
    },
  },
};

export default function GoPage() {
  return (
    <main>
      <JsonLd data={softwareApplicationSchema()} />
      <JsonLd data={faqSchema([...GO_FAQ_ITEMS])} />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Free Webhook Endpoint", path: "/go" },
        ])}
      />
      <div className="sr-only">
        <p>
          webhooks.cc is a free webhook testing and inspection service. Use this page to create a
          guest webhook endpoint instantly — no signup, no credit card, no configuration. Send any
          HTTP POST, PUT, PATCH, or DELETE request and inspect the full payload, headers, query
          parameters, and origin IP in a live dashboard. Your endpoint is live for 12 hours and
          accepts up to 25 requests, perfect for debugging a webhook integration, testing a
          third-party service, or verifying a payload shape before wiring it into production.
        </p>
        <p>
          Developers use webhooks.cc to debug production webhook integrations with Stripe, GitHub,
          Shopify, Twilio, Slack, Paddle, Linear, Polar, PayPal, and any custom HTTP webhook sender.
          Capture the exact payload a provider sends, inspect signature headers, replay requests to
          a staging environment, and assert payload shape in automated tests. The service is
          SOC-friendly, GDPR-friendly, and hosted in the EU with no customer data stored on US
          servers.
        </p>
        <h2>Beyond the free endpoint — a full webhook toolkit</h2>
        <p>
          The guest endpoint on this page is one piece of a larger toolkit. Sign in free for a
          persistent endpoint with 50 requests per day, or upgrade to Pro for 25,000 requests per
          month, unlimited endpoints, team collaboration, and extended retention. Every tier
          includes the dashboard, the whk CLI, the TypeScript SDK, and the MCP server for AI coding
          agents.
        </p>
        <h3>
          <Link href="/docs/mock-responses">Mock webhook responses instantly</Link>
        </h3>
        <p>
          Return custom status codes, headers, and JSON bodies per endpoint. Use conditional rules
          to match on method, path, or body content and return different responses — no deploy, no
          restart. Ideal for mocking a third-party API during development, simulating rate-limited
          or failed responses, or staging a sender&apos;s retry behavior. Changes take effect
          instantly and apply to every incoming request.
        </p>
        <h3>
          <Link href="/docs/guides/verify-webhook-signatures">Test signed webhooks end-to-end</Link>
        </h3>
        <p>
          Verify Stripe, GitHub, Shopify, Twilio, Slack, Paddle, Linear, and more. Send signed
          provider templates with correct signature headers to exercise your verification code for
          real. The dashboard and SDK both compute valid HMAC-SHA256, HMAC-SHA1, and
          standard-webhooks signatures automatically so you can focus on your integration rather
          than cryptographic plumbing.
        </p>
        <h3>
          <Link href="/docs/cli/tunnel">Forward webhooks to localhost with the CLI</Link>
        </h3>
        <p>
          Run <code>whk tunnel 3000</code> to pipe incoming webhooks to any local port. No ngrok, no
          port forwarding, no public IP — just a stable public URL that streams to your dev server.
          Reconnects automatically on network changes. Works on macOS, Linux, and Windows, with
          cross-compiled binaries available from GitHub Releases.
        </p>
        <h3>
          <Link href="/docs/sdk/testing">Assert webhooks in CI tests with the TypeScript SDK</Link>
        </h3>
        <p>
          The SDK waits for matching requests with composable matchers. Works in Vitest, Jest, and
          Playwright — assert method, headers, body JSON paths, and signature validity. Helpers like{" "}
          <code>matchMethod</code>, <code>matchHeader</code>, <code>matchBodyPath</code>,{" "}
          <code>matchAll</code>, and <code>matchAny</code> make multi-step webhook flows trivial to
          test deterministically. Actionable error messages with recovery hints shrink the
          debug-loop in CI failures.
        </p>
        <h3>
          <Link href="/docs/mcp">AI-native webhook debugging with the MCP server</Link>
        </h3>
        <p>
          The MCP server lets Claude Code, Cursor, VS Code, and Codex create endpoints, send test
          payloads, and inspect captured requests through natural language — no manual copy-paste.
          Install via <code>claude mcp add</code> or <code>codex mcp add</code>, then ask your agent
          to &quot;send a Stripe checkout event and verify my handler returns 200&quot;. The agent
          runs the flow end-to-end and reports back.
        </p>
        <h3>
          <Link href="/docs/requests">Inspect, search, replay, and export requests</Link>
        </h3>
        <p>
          Full-text search across captured requests by header name, body content, path, or request
          id. Replay any request to any URL to debug a production incident or reproduce a flaky
          failure. Export as JSON or CSV for offline analysis. Real-time updates via server-sent
          events mean no polling and no refresh — captured requests appear in the dashboard the
          instant they arrive.
        </p>
        <h2>Provider-specific webhook testing guides</h2>
        <ul>
          <li>
            <Link href="/docs/guides/test-stripe-webhooks">Test Stripe webhooks locally</Link> —
            capture <code>checkout.session.completed</code> and{" "}
            <code>invoice.payment_succeeded</code> events and verify Stripe-Signature headers in
            dev.
          </li>
          <li>
            <Link href="/docs/guides/test-github-webhooks">Test GitHub webhooks locally</Link> —
            pull request, push, release, and workflow_run events with HMAC-SHA256 verification using{" "}
            <code>X-Hub-Signature-256</code>.
          </li>
          <li>
            <Link href="/docs/guides/test-shopify-webhooks">Test Shopify webhooks locally</Link> —
            orders, products, and inventory webhooks with topic-based routing and
            Shopify-Hmac-SHA256 signatures.
          </li>
          <li>
            <Link href="/docs/guides/webhook-testing-ci-cd">
              Webhook testing in CI/CD pipelines
            </Link>{" "}
            — run signature and payload assertions in GitHub Actions, GitLab CI, CircleCI, and
            Jenkins.
          </li>
          <li>
            <Link href="/docs/guides/test-webhooks-locally">Test webhooks locally</Link> —
            end-to-end guide to capturing, forwarding, and asserting webhooks during development.
          </li>
          <li>
            <Link href="/docs/guides/ngrok-vs-webhooks-cc">ngrok vs webhooks.cc</Link> —
            head-to-head comparison for developers choosing a tunnel tool.
          </li>
          <li>
            <Link href="/docs/guides/webhook-site-vs-webhooks-cc">webhook.site vs webhooks.cc</Link>{" "}
            — feature comparison for developers evaluating inspection services.
          </li>
          <li>
            <Link href="/docs/guides/webhook-testing-tools">Webhook testing tools comparison</Link>{" "}
            — survey of the webhook testing tool landscape.
          </li>
        </ul>
        <h2>Frequently asked questions</h2>
        {GO_FAQ_ITEMS.map((item) => (
          <div key={item.question}>
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
          </div>
        ))}
      </div>
      <GuestLiveDashboard />
    </main>
  );
}
