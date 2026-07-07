import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, howToSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { StartFreeCTA } from "@/components/landing/start-free-cta";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import {
  getAllWebhookProviderPages,
  getWebhookProviderPage,
  WEBHOOK_PROVIDER_SLUGS,
  type WebhookProviderPage,
} from "@/lib/webhook-provider-pages";

interface PageProps {
  params: Promise<{ provider: string }>;
}

export function generateStaticParams() {
  return WEBHOOK_PROVIDER_SLUGS.map((provider) => ({ provider }));
}

export const dynamicParams = false;

const GUIDE_BY_PROVIDER: Partial<Record<string, { href: string; label: string }>> = {
  stripe: { href: "/docs/guides/test-stripe-webhooks", label: "Test Stripe webhooks locally" },
  github: { href: "/docs/guides/test-github-webhooks", label: "Test GitHub webhooks locally" },
  shopify: { href: "/docs/guides/test-shopify-webhooks", label: "Test Shopify webhooks locally" },
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { provider } = await params;
  const page = getWebhookProviderPage(provider);
  if (!page) return {};

  return createPageMetadata({
    title: `Test ${page.label} Webhooks — Free Endpoint & Signed Samples`,
    description: `Capture and inspect ${page.label} webhooks on a free endpoint, send signed sample payloads, and verify ${page.signatureHeader ?? "signature"} headers. No account required to start.`,
    path: `/webhooks/${page.slug}`,
    keywords: [
      `test ${page.label.toLowerCase()} webhooks`,
      `${page.label.toLowerCase()} webhook tester`,
      `${page.label.toLowerCase()} webhook url`,
      `${page.label.toLowerCase()} webhook example`,
      `${page.label.toLowerCase()} webhook signature verification`,
      `${page.label.toLowerCase()} sample payload`,
    ],
  });
}

function buildFaq(page: WebhookProviderPage): FAQItem[] {
  const items: FAQItem[] = [
    {
      question: `How do I test ${page.label} webhooks without deploying anything?`,
      answer: `Create a free endpoint on webhooks.cc — sign in with GitHub or Google, or use a guest endpoint without an account — then configure it as your webhook URL: ${page.configHint}. Every delivery shows up live in the dashboard with full headers, body, and query parameters. To hit a local server, run whk tunnel <port> and the CLI forwards each webhook to localhost.`,
    },
    {
      question: `Can I send a sample ${page.label} webhook without a ${page.label} account?`,
      answer:
        page.templates.length > 0
          ? `Yes. webhooks.cc ships ${page.label} templates (${page.templates.slice(0, 3).join(", ")}) with realistic payloads${page.secretRequired ? " and correctly computed signature headers" : ""}. Send them from the dashboard, the SDK, or the MCP server to exercise your handler end-to-end.`
          : `Yes. webhooks.cc can send signed test payloads following the ${page.label} signing scheme from the dashboard, the SDK, or the MCP server.`,
    },
  ];

  if (page.signatureHeader) {
    items.push({
      question: `How do I verify ${page.label} webhook signatures?`,
      answer: `${page.label} signs each delivery with the ${page.signatureHeader} header using ${page.signatureAlgorithmLabel ?? page.signatureAlgorithm}. ${page.verifySupported ? `webhooks.cc verifies these signatures for you: add your ${page.credentialLabel.toLowerCase()} to the endpoint and every captured request is marked valid or invalid in the dashboard.` : `Capture a real delivery on webhooks.cc to inspect the exact header value, then implement verification in your handler.`}`,
    });
  }

  items.push({
    question: `Is the ${page.label} webhook tester free?`,
    answer: `Yes. A free account gets you persistent endpoints, 50 requests per day, 7-day retention, and full CLI, SDK, and MCP access — no credit card. You can also try a guest endpoint without an account: up to 25 requests for 12 hours.`,
  });

  return items;
}

export default async function ProviderWebhookPage({ params }: PageProps) {
  const { provider } = await params;
  const page = getWebhookProviderPage(provider);
  if (!page) notFound();

  const icon = getWebProviderInfo(page.slug)?.icon;
  const guide = GUIDE_BY_PROVIDER[page.slug];
  const faqItems = buildFaq(page);
  const related = getAllWebhookProviderPages()
    .filter((p) => p.category === page.category && p.slug !== page.slug)
    .slice(0, 3);

  const howToSteps = [
    {
      name: "Create a webhook endpoint",
      text: "Sign in free with GitHub or Google to create a persistent endpoint — or grab an instant guest URL at webhooks.cc without an account.",
      url: "https://webhooks.cc",
    },
    {
      name: `Point ${page.label} at your URL`,
      text: `Paste the endpoint URL into ${page.label}: ${page.configHint}.`,
    },
    {
      name: "Inspect what arrives",
      text: "Each delivery appears live in the dashboard with method, headers, body, query parameters, and source IP.",
    },
    {
      name: "Forward to localhost or assert in CI",
      text: "Run whk tunnel <port> to forward webhooks to a local server, or use the TypeScript SDK to wait for and assert on deliveries in tests.",
    },
  ];

  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Webhook Providers", path: "/webhooks" },
          { name: `${page.label} Webhooks`, path: `/webhooks/${page.slug}` },
        ])}
      />
      <JsonLd data={faqSchema(faqItems)} />
      <JsonLd
        data={howToSchema({
          name: `How to test ${page.label} webhooks`,
          description: `Capture, inspect, and test ${page.label} webhooks with a free endpoint on webhooks.cc.`,
          steps: howToSteps,
          totalTime: "PT2M",
        })}
      />

      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-6">
            {icon && (
              <span
                className="w-14 h-14 border-2 flex items-center justify-center shrink-0 shadow-neo-sm"
                style={{
                  backgroundColor: icon.background,
                  color: icon.foreground,
                  borderColor: icon.border,
                }}
              >
                <ProviderIcon glyph={icon.glyph} fallbackText={icon.text} className="h-7 w-7" />
              </span>
            )}
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
              Test {page.label} webhooks
            </h1>
          </div>
          <p className="text-xl text-muted-foreground mb-6">
            {page.blurb} Capture them on a free webhooks.cc endpoint to see exactly what{" "}
            {page.label} sends — or fire realistic{page.secretRequired ? ", correctly signed" : ""}{" "}
            sample payloads at your own handler without touching a production account.
          </p>
          <StartFreeCTA goCta="get a guest URL without an account" />
          <p className="text-sm text-muted-foreground mt-4">
            Prefer a walkthrough? Read the{" "}
            <Link
              href={guide?.href ?? "/docs/guides/test-webhooks-locally"}
              className="text-primary font-bold hover:underline"
            >
              {guide ? guide.label : "local webhook testing guide"}
            </Link>
            .
          </p>
        </div>

        {/* How it works */}
        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">How to test {page.label} webhooks</h2>
          <ol className="space-y-4">
            {howToSteps.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <span className="w-9 h-9 border-2 border-foreground bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0 shadow-neo-sm">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-bold mb-0.5">{step.name}</h3>
                  <p className="text-muted-foreground text-sm">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Signature details */}
        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">{page.label} webhook signature</h2>
          <div className="neo-card neo-card-static overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {page.signatureHeader && (
                  <tr className="border-b-2 border-foreground/10">
                    <th className="text-left py-2 pr-6 font-bold whitespace-nowrap">
                      Signature header
                    </th>
                    <td className="py-2 font-mono">{page.signatureHeader}</td>
                  </tr>
                )}
                {page.signatureAlgorithmLabel && (
                  <tr className="border-b-2 border-foreground/10">
                    <th className="text-left py-2 pr-6 font-bold whitespace-nowrap">Algorithm</th>
                    <td className="py-2">{page.signatureAlgorithmLabel}</td>
                  </tr>
                )}
                <tr>
                  <th className="text-left py-2 pr-6 font-bold whitespace-nowrap">
                    Verification in webhooks.cc
                  </th>
                  <td className="py-2">
                    {page.verifySupported ? (
                      <span className="inline-flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-primary" />
                        Supported — add your {page.credentialLabel.toLowerCase()} and every request
                        is checked automatically
                      </span>
                    ) : (
                      "Capture deliveries to inspect raw signature material"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {!page.signatureHeader && (
            <p className="text-sm text-muted-foreground mt-3">
              {page.label} does not use a conventional signature header
              {page.slug === "adyen" ? " — the HMAC is embedded in the notification body" : ""}.
              Capture a real delivery to inspect exactly what is sent.
            </p>
          )}
          <p className="text-sm text-muted-foreground mt-3">
            New to signature verification? Read the{" "}
            <Link
              href="/docs/guides/verify-webhook-signatures"
              className="text-primary font-bold hover:underline"
            >
              webhook signature verification guide
            </Link>
            .
          </p>
        </section>

        {/* Sample events */}
        {page.templates.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-4">Send sample {page.label} events</h2>
            <p className="text-muted-foreground mb-6">
              These {page.label} templates ship with realistic payloads
              {page.secretRequired ? " and valid signature headers" : ""}. Send them from the
              dashboard&apos;s Send button, the SDK, or your AI agent via MCP.
            </p>
            <div className="flex flex-wrap gap-2 mb-6">
              {page.templates.map((template) => (
                <code
                  key={template}
                  className="text-sm border-2 border-foreground bg-muted px-2 py-1 font-mono"
                >
                  {template}
                </code>
              ))}
            </div>
            <div className="neo-code overflow-x-auto">
              <pre className="text-sm">
                <code>
                  <span className="text-muted-foreground">
                    # Send a signed {page.label} sample with the SDK
                  </span>
                  {"\n"}
                  <span className="text-code-keyword">await</span> client.endpoints.sendTemplate(
                  slug, {"{"}
                  {"\n  "}provider:{" "}
                  <span className="text-code-string">&quot;{page.slug}&quot;</span>,{"\n  "}
                  template:{" "}
                  <span className="text-code-string">&quot;{page.defaultTemplate}&quot;</span>,
                  {page.secretRequired && (
                    <>
                      {"\n  "}secret:{" "}
                      <span className="text-code-string">&quot;your-test-secret&quot;</span>,
                    </>
                  )}
                  {"\n"}
                  {"}"});
                </code>
              </pre>
            </div>
          </section>
        )}

        {/* What you get */}
        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Everything in one place</h2>
          <ul className="grid sm:grid-cols-2 gap-3">
            {[
              "Live dashboard — see deliveries the moment they arrive",
              "Forward to localhost with whk tunnel",
              "Replay any captured request to any URL",
              "Mock responses with custom status, headers, and body",
              "TypeScript SDK assertions for CI",
              "MCP server for AI coding agents",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <span className="text-sm">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* FAQ */}
        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">{page.label} webhook questions</h2>
          <FAQAccordion items={faqItems} />
        </section>

        {/* Related */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">More providers</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            {related.map((p) => (
              <Link key={p.slug} href={`/webhooks/${p.slug}`} className="neo-card block group">
                <h3 className="font-bold group-hover:text-primary transition-colors">
                  {p.label} webhooks
                </h3>
                <p className="text-xs text-muted-foreground mt-1">{p.category}</p>
              </Link>
            ))}
          </div>
          <p className="mt-4 text-sm">
            <Link href="/webhooks" className="text-primary font-bold hover:underline">
              Browse all {WEBHOOK_PROVIDER_SLUGS.length} providers
              <ArrowRight className="inline-block ml-1 h-4 w-4" />
            </Link>
          </p>
        </section>

        {/* CTA */}
        <div className="neo-card bg-foreground text-background text-center py-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-3">
            Your {page.label} webhook URL is seconds away
          </h2>
          <p className="opacity-80 mb-6 max-w-md mx-auto">
            Sign up free, create an endpoint, and point {page.label} at it.
          </p>
          <div className="flex justify-center text-foreground">
            <PricingCTA />
          </div>
          <p className="text-sm opacity-80 mt-6">
            No credit card &middot; or{" "}
            <Link href="/" className="font-bold underline hover:no-underline">
              try without an account
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
