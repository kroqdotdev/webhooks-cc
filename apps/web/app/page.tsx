import Link from "next/link";
import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { HeroCTA } from "@/components/landing/hero-cta";
import { Zap, Eye, Terminal, ArrowRight, Check, Bot } from "lucide-react";
import { GitHubCard } from "@/components/landing/github-card";
import { InstallCards } from "@/components/landing/install-cards";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, softwareApplicationSchema, faqSchema, type FAQItem } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "Webhook Testing Platform: CLI, SDK & MCP",
  description:
    "Capture and inspect webhooks in real time. Send signed Stripe, GitHub, Shopify, and Twilio test webhooks from the dashboard. Forward to localhost with the CLI, test in CI with the SDK, and connect AI coding agents via MCP.",
  path: "/",
});

interface GitHubRepoResponse {
  stargazers_count: number;
}

async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/kroqdotdev/webhooks-cc", {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GitHubRepoResponse;
    return typeof data?.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

const LANDING_FAQ: FAQItem[] = [
  {
    question: "How do I test webhooks locally?",
    answer:
      "Run whk tunnel 3000. The CLI creates a public endpoint and forwards every incoming webhook to your local port — method, headers, and body intact. No port forwarding or ngrok needed.",
  },
  {
    question: "What is a webhook CLI tunnel?",
    answer:
      "A tunnel streams HTTP requests from a public URL to your local machine. webhooks.cc creates the endpoint, receives the webhook, and replays it to localhost over SSE. Your local server handles it as if the sender called it directly.",
  },
  {
    question: "How do I test webhooks in TypeScript?",
    answer:
      "Install @webhooks-cc/sdk, create an endpoint, and call client.requests.waitFor() with composable matchers. Assert on method, headers, or body fields. Works with Vitest, Jest, and any Node.js test runner.",
  },
  {
    question: "Can I send signed Stripe, GitHub, Shopify, and Twilio webhooks?",
    answer:
      "Yes. Use the Send button in the dashboard and select a provider template. webhooks.cc generates realistic payloads and signature headers so you can test your verification code end-to-end.",
  },
  {
    question: "How do I inspect webhook payloads?",
    answer:
      "Send a webhook to your endpoint URL and open the dashboard. Each request shows method, headers, body (auto-formatted JSON and XML), query parameters, IP, and timestamp. Export as JSON or CSV.",
  },
  {
    question: "Is webhooks.cc free?",
    answer:
      "Yes. The free plan gives you 200 requests per day, 7-day retention, unlimited endpoints, and full CLI, SDK, and MCP access. Pro ($8/month) raises the limit to 500,000 requests per month with 30-day retention.",
  },
  {
    question: "How do I connect an AI coding agent?",
    answer:
      "Install the MCP server with npx @webhooks-cc/mcp and add it to Claude Code, Cursor, VS Code, Codex, or Windsurf. Your agent creates endpoints, sends test webhooks, inspects requests, and replays them — through natural language.",
  },
];

export default async function Home() {
  const stars = await getStarCount();

  return (
    <main className="min-h-screen">
      <JsonLd data={softwareApplicationSchema()} />
      <JsonLd data={faqSchema(LANDING_FAQ)} />

      {/* Navigation */}
      <FloatingNavbar />

      {/* Hero */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-8">
            <div className="max-w-3xl">
              <div className="inline-block neo-btn-secondary text-sm py-1 px-3 mb-6">
                Webhook Testing Tools
              </div>
              <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-[1.1]">
                Inspect webhooks{" "}
                <span className="bg-primary text-primary-foreground px-2">instantly</span>
              </h1>
              <p className="text-xl md:text-2xl text-muted-foreground mb-8 max-w-2xl leading-relaxed">
                Get a URL, send a webhook, inspect it instantly. Send signed Stripe, GitHub,
                Shopify, and Twilio templates from the dashboard. Forward to localhost with the CLI,
                test in CI with the SDK, and use MCP with your AI coding agent.
              </p>
              <p className="text-lg font-semibold mb-8">Start free. No credit card required.</p>
              <HeroCTA />
            </div>

            {/* GitHub */}
            <GitHubCard stars={stars} />
          </div>

          {/* Install */}
          <InstallCards />

          {/* Code preview */}
          <div className="mt-6 neo-code overflow-x-auto">
            <pre className="text-sm md:text-base">
              <code>
                <span className="text-muted-foreground"># Send manually with curl</span>
                {"\n"}
                <span className="text-primary">$</span> curl -X POST https://go.webhooks.cc/w/abc123
                \{"\n"}
                {"  "}-H{" "}
                <span className="text-code-string">&quot;Content-Type: application/json&quot;</span>{" "}
                \{"\n"}
                {"  "}-d{" "}
                <span className="text-code-string">
                  &apos;{`{"event": "payment.success", "amount": 4999}`}&apos;
                </span>
                {"\n\n"}
                <span className="text-muted-foreground">
                  # Or send a signed provider template in TypeScript
                </span>
                {"\n"}
                <span className="text-code-keyword">
                  await
                </span> client.endpoints.sendTemplate(slug, {"{"}
                {"\n"}
                {"  "}provider: <span className="text-code-string">&quot;stripe&quot;</span>,{"\n"}
                {"  "}template:{" "}
                <span className="text-code-string">&quot;checkout.session.completed&quot;</span>,
                {"\n"}
                {"  "}secret: <span className="text-code-string">&quot;whsec_test_123&quot;</span>,
                {"\n"}
                {"}"});
                {"\n\n"}
                <span className="text-muted-foreground"># Wait for it in your tests</span>
                {"\n"}
                <span className="text-code-keyword">const</span> req ={" "}
                <span className="text-code-keyword">await</span> client.requests.waitFor(slug, {"{"}{" "}
                {"\n"}
                {"  "}timeout: <span className="text-code-string">&quot;30s&quot;</span>,{"\n"}
                {"  "}match: matchHeader(
                <span className="text-code-string">&quot;stripe-signature&quot;</span>),{"\n"}
                {"}"});
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4 bg-muted">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Webhook tools that fit how you build
          </h2>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Use the dashboard, the CLI, the SDK, or your AI agent. Same webhooks, your workflow.
          </p>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-primary flex items-center justify-center mb-4 shadow-neo-sm">
                <Eye className="h-6 w-6 text-primary-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Capture & inspect</h3>
              <p className="text-muted-foreground">
                See requests the moment they arrive. Headers, body, query params — formatted and
                searchable. Export as JSON or CSV.
              </p>
            </div>

            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-secondary flex items-center justify-center mb-4 shadow-neo-sm">
                <Zap className="h-6 w-6 text-secondary-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Send signed templates</h3>
              <p className="text-muted-foreground">
                Send realistic Stripe, GitHub, Shopify, and Twilio webhooks from the dashboard.
                Signature headers are generated for each provider.
              </p>
            </div>

            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-accent flex items-center justify-center mb-4 shadow-neo-sm">
                <Terminal className="h-6 w-6 text-accent-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">CLI & TypeScript SDK</h3>
              <p className="text-muted-foreground">
                Forward webhooks to localhost with{" "}
                <code className="font-mono font-bold">whk tunnel</code>. Write test assertions with
                composable matchers. Run in CI with GitHub Actions.
              </p>
            </div>

            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-foreground flex items-center justify-center mb-4 shadow-neo-sm">
                <Bot className="h-6 w-6 text-background" />
              </div>
              <h3 className="font-bold text-xl mb-2">MCP server for AI agents</h3>
              <p className="text-muted-foreground">
                Connect Claude Code, Cursor, VS Code, or Codex. Your AI agent creates endpoints,
                sends test webhooks, and replays requests — in natural language.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-20 px-4 bg-muted">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Simple pricing</h2>
            <p className="text-xl text-muted-foreground">All features. Every tier. No gotchas.</p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* Free Plan */}
            <div className="neo-card">
              <div className="mb-6">
                <h3 className="font-bold text-2xl mb-2">Free</h3>
                <p className="text-5xl font-bold">
                  $0
                  <span className="text-lg font-normal text-muted-foreground">/forever</span>
                </p>
              </div>
              <ul className="space-y-3 mb-8">
                {[
                  "200 requests/day",
                  "7-day data retention",
                  "Unlimited endpoints",
                  "CLI, SDK & MCP access",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <Check className="h-5 w-5 text-primary flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link href="/login" className="neo-btn-outline w-full text-center block">
                Get started
              </Link>
            </div>

            {/* Pro Plan */}
            <div className="neo-card border-primary relative">
              <div className="absolute -top-3 -right-3 bg-secondary text-secondary-foreground px-3 py-1 text-sm font-bold border-2 border-foreground shadow-neo-sm">
                Popular
              </div>
              <div className="mb-6">
                <h3 className="font-bold text-2xl mb-2">Pro</h3>
                <p className="text-5xl font-bold">
                  $8
                  <span className="text-lg font-normal text-muted-foreground">/month</span>
                </p>
              </div>
              <ul className="space-y-3 mb-8">
                {[
                  "500,000 requests/month",
                  "30-day data retention",
                  "Unlimited endpoints",
                  "CLI, SDK & MCP access",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <Check className="h-5 w-5 text-primary flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link href="/login" className="neo-btn-primary w-full text-center block">
                Upgrade to Pro
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 px-4 scroll-mt-20">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Questions</h2>
          <p className="text-xl text-muted-foreground mb-10">
            Common questions about webhooks.cc, answered.
          </p>
          <FAQAccordion items={LANDING_FAQ} />
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="neo-card bg-foreground text-background text-center py-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Your next webhook is one URL away
            </h2>
            <p className="text-xl opacity-80 mb-8 max-w-xl mx-auto">
              Create an endpoint, point your service at it, and see what arrives. Takes 10 seconds.
            </p>
            <Link href="/go" className="neo-btn bg-background text-foreground">
              Try it free
              <ArrowRight className="inline-block ml-2 h-5 w-5" />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-2 border-foreground py-12 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <h4 className="font-bold text-lg mb-4">webhooks.cc</h4>
              <p className="text-muted-foreground text-sm">
                Webhook testing tools for developers. Inspect, forward, test, and automate.
              </p>
            </div>
            <div>
              <h4 className="font-bold mb-4">Product</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/docs" className="text-muted-foreground hover:text-foreground">
                    Documentation
                  </Link>
                </li>
                <li>
                  <Link
                    href="/installation"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Installation
                  </Link>
                </li>
                <li>
                  <Link href="/compare" className="text-muted-foreground hover:text-foreground">
                    Compare
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="text-muted-foreground hover:text-foreground">
                    Dashboard
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4">Resources</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/docs/cli" className="text-muted-foreground hover:text-foreground">
                    CLI Reference
                  </Link>
                </li>
                <li>
                  <Link href="/docs/sdk" className="text-muted-foreground hover:text-foreground">
                    SDK Reference
                  </Link>
                </li>
                <li>
                  <Link href="/docs/mcp" className="text-muted-foreground hover:text-foreground">
                    MCP Server
                  </Link>
                </li>
                <li>
                  <Link href="/blog" className="text-muted-foreground hover:text-foreground">
                    Blog
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/privacy" className="text-muted-foreground hover:text-foreground">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-muted-foreground hover:text-foreground">
                    Terms of Service
                  </Link>
                </li>
                <li>
                  <Link href="/support" className="text-muted-foreground hover:text-foreground">
                    Support
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t-2 border-foreground mt-12 pt-8 text-center text-muted-foreground text-sm">
            <p>&copy; {new Date().getFullYear()} webhooks.cc. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
