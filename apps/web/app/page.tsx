import Link from "next/link";
import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { HeroCTA } from "@/components/landing/hero-cta";
import { Zap, Eye, Terminal, ArrowRight, Check, Bot } from "lucide-react";
import { GitHubCard } from "@/components/landing/github-card";
import { InstallCards } from "@/components/landing/install-cards";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { LivePreview } from "@/components/landing/live-preview";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, softwareApplicationSchema, faqSchema, type FAQItem } from "@/lib/schemas";
import { createClient } from "@supabase/supabase-js";

export const metadata = createPageMetadata({
  title: "Webhook Testing Platform: CLI, SDK & MCP",
  description:
    "Capture and inspect webhooks in real time. Send signed provider test webhooks, forward to localhost with the CLI, test in CI with the SDK, and debug faster with MCP.",
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

interface SiteStats {
  total_webhooks: number;
  total_endpoints: number;
  total_users: number;
}

// Untyped client for site_stats (not in generated Database type yet).
// Cached at module scope so it's reused across renders.
let _statsClient: ReturnType<typeof createClient> | null = null;
function getStatsClient() {
  if (_statsClient) return _statsClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _statsClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _statsClient;
}

async function getSiteStats(): Promise<SiteStats | null> {
  try {
    const supabase = getStatsClient();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("site_stats")
      .select("total_webhooks, total_endpoints, total_users")
      .eq("id", 1)
      .single();
    if (error || !data) return null;
    return data as SiteStats;
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
      "Yes. The free plan gives you 50 requests per day, 7-day retention, unlimited endpoints, and full CLI, SDK, and MCP access. Pro ($8/month) raises the limit to 100,000 requests per month with 30-day retention.",
  },
  {
    question: "How do I connect an AI coding agent?",
    answer:
      "Install the MCP server with npx @webhooks-cc/mcp and add it to Claude Code, Cursor, VS Code, Codex, or Windsurf. Your agent creates endpoints, sends test webhooks, inspects requests, and replays them — through natural language.",
  },
];

export default async function Home() {
  const [stars, stats] = await Promise.all([getStarCount(), getSiteStats()]);

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
                Free forever &middot; No credit card
              </div>
              <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-[1.2]">
                See every webhook
                <br />
                <span className="bg-primary text-primary-foreground px-2">as it arrives</span>
              </h1>
              <p className="text-xl md:text-2xl text-muted-foreground mb-8 max-w-2xl leading-relaxed">
                Get a URL, send a webhook, see it arrive. Forward to localhost with the CLI, test in
                CI with the SDK, or let your AI agent handle it with MCP.
              </p>
              <HeroCTA />

              {/* Social proof — near the CTA for maximum impact */}
              {stats && (
                <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                  {stats.total_users > 0 ? (
                    <span className="font-semibold">
                      <span className="text-foreground">{stats.total_users.toLocaleString()}</span>{" "}
                      developers
                    </span>
                  ) : null}
                  {stats.total_endpoints > 0 ? (
                    <span className="font-semibold">
                      <span className="text-foreground">
                        {stats.total_endpoints.toLocaleString()}
                      </span>{" "}
                      endpoints created
                    </span>
                  ) : null}
                  {stats.total_webhooks > 0 ? (
                    <span className="font-semibold">
                      <span className="text-foreground">
                        {stats.total_webhooks.toLocaleString()}
                      </span>{" "}
                      webhooks captured
                    </span>
                  ) : null}
                  <span className="font-semibold">Open source</span>
                </div>
              )}
            </div>

            {/* GitHub — hidden on mobile to keep CTA above the fold */}
            <div className="hidden lg:block">
              <GitHubCard stars={stars} />
            </div>
          </div>

          {/* Install */}
          <InstallCards />

          {/* Live preview */}
          <LivePreview />

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

      {/* How it works */}
      <section className="py-20 px-4 bg-muted">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold mb-12">How it works</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "1",
                title: "Get a URL",
                description: "Create an endpoint in one click. You get a unique public URL.",
              },
              {
                step: "2",
                title: "Point your service",
                description:
                  "Configure Stripe, GitHub, or any service to send webhooks to your URL.",
              },
              {
                step: "3",
                title: "See what arrives",
                description:
                  "Headers, body, query params — live. Forward to localhost or assert in tests.",
              },
            ].map((item) => (
              <div key={item.step} className="flex gap-4">
                <div className="w-10 h-10 border-2 border-foreground bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg shrink-0 shadow-neo-sm">
                  {item.step}
                </div>
                <div>
                  <h3 className="font-bold text-lg mb-1">{item.title}</h3>
                  <p className="text-muted-foreground text-sm">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4">
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
              <h3 className="font-bold text-xl mb-2">See requests the moment they arrive</h3>
              <p className="text-muted-foreground">
                Headers, body, query params — formatted, searchable, and exportable as JSON or CSV.
                Live updates, no refresh needed.
              </p>
            </div>

            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-secondary flex items-center justify-center mb-4 shadow-neo-sm">
                <Zap className="h-6 w-6 text-secondary-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Test Stripe, GitHub, and Shopify webhooks</h3>
              <p className="text-muted-foreground">
                Send signed provider templates from the dashboard. Realistic payloads with correct
                signature headers — test your verification code end-to-end.
              </p>
            </div>

            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-accent flex items-center justify-center mb-4 shadow-neo-sm">
                <Terminal className="h-6 w-6 text-accent-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Forward to localhost. Assert in CI.</h3>
              <p className="text-muted-foreground">
                <code className="font-mono font-bold">whk tunnel</code> forwards webhooks to your
                local port. The TypeScript SDK waits for events and asserts payload shape in your
                test suite.
              </p>
            </div>

            <div className="neo-card">
              <div className="w-12 h-12 border-2 border-foreground bg-foreground flex items-center justify-center mb-4 shadow-neo-sm">
                <Bot className="h-6 w-6 text-background" />
              </div>
              <h3 className="font-bold text-xl mb-2">Let your AI agent debug webhooks</h3>
              <p className="text-muted-foreground">
                Connect Claude Code, Cursor, VS Code, or Codex via MCP. Your agent creates
                endpoints, sends tests, and inspects requests — through natural language.
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
                  "50 requests/day",
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
              <PricingCTA />
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
                  "100,000 requests/month",
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
              <p className="text-sm text-muted-foreground mb-3 text-center">
                Start free, upgrade later
              </p>
              <PricingCTA />
            </div>
          </div>
        </div>
      </section>

      {/* Compare */}
      <section className="py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">See how we compare</h2>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Honest, developer-focused comparisons against popular alternatives.
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                href: "/compare/webhook-site",
                title: "vs Webhook.site",
                summary:
                  "Compare core webhook inspection features, pricing, and developer workflows.",
              },
              {
                href: "/compare/ngrok",
                title: "vs ngrok",
                summary: "Tradeoffs between a webhook-focused platform and a general tunnel tool.",
              },
              {
                href: "/compare/beeceptor",
                title: "vs Beeceptor",
                summary:
                  "How webhook inspection + SDK + MCP compare against API mocking-first workflows.",
              },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="neo-card block transition-colors hover:bg-muted group"
              >
                <h3 className="font-bold text-xl mb-2">{item.title}</h3>
                <p className="text-muted-foreground mb-4">{item.summary}</p>
                <span className="inline-flex items-center text-sm font-semibold group-hover:underline">
                  Read comparison
                  <ArrowRight className="ml-1 h-4 w-4" />
                </span>
              </Link>
            ))}
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
              Create an endpoint, point your service at it, and see what arrives.
            </p>
            <div className="flex justify-center">
              <PricingCTA />
            </div>
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
                <li>
                  <Link href="/changelog" className="text-muted-foreground hover:text-foreground">
                    Changelog
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
                <li>
                  <a
                    href="https://status.webhooks.cc"
                    className="text-muted-foreground hover:text-foreground"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Status
                  </a>
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
