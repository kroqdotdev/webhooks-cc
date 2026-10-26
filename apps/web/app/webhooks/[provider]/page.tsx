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
import { CopyButton } from "@/components/ui/copy-button";
import { highlightCode } from "@/lib/highlight";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import { providerSecretEnv, providerTestSnippet } from "@/lib/provider-test-snippet";
import {
  getRelatedProviderPages,
  getWebhookProviderPage,
  indefiniteArticle,
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

// Providers whose own tooling people compare us with.
const COMPARISON_BY_PROVIDER: Partial<Record<string, { href: string; label: string }>> = {
  stripe: { href: "/compare/stripe-cli", label: "webhooks.cc vs the Stripe CLI" },
  "standard-webhooks": { href: "/compare/svix", label: "webhooks.cc vs Svix" },
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { provider } = await params;
  const page = getWebhookProviderPage(provider);
  if (!page) return {};

  // Searches are "<provider> webhooks" far more often than "test <provider>
  // webhooks", so the title leads with the provider.
  return createPageMetadata({
    title:
      page.seo?.title ??
      (page.inSdk
        ? `${page.label} Webhooks: Free Tester, Signatures & Samples`
        : `${page.label} Webhooks: Free Tester & Live Inspector`),
    description:
      page.seo?.description ??
      (page.inSdk
        ? `Capture and inspect ${page.label} webhooks on a free endpoint, send signed sample payloads, and verify ${page.signatureHeader ?? "signature"} headers. No account required to start.`
        : `Capture and inspect ${page.label} webhooks on a free endpoint, see every header and payload live, replay deliveries, and forward them to localhost. No account required to start.`),
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
    ...(page.seo?.faq ?? []),
    {
      question: `How do I test ${page.label} webhooks without deploying anything?`,
      answer: `Create a free endpoint on webhooks.cc — sign in with GitHub, Google, or email, or use a guest endpoint without an account — then configure it as your webhook URL: ${page.configHint}. Every delivery shows up live in the dashboard with full headers, body, and query parameters. To hit a local server, run whk tunnel <port> and the CLI forwards each webhook to localhost.`,
    },
    page.inSdk
      ? {
          question: `Can I send a sample ${page.label} webhook without ${indefiniteArticle(page.label)} ${page.label} account?`,
          answer:
            page.templates.length > 0
              ? `Yes. webhooks.cc ships ${page.label} templates (${page.templates.slice(0, 3).join(", ")}) with realistic payloads${page.secretRequired ? " and correctly computed signature headers" : ""}. Send them from the dashboard, the SDK, or the MCP server to exercise your handler end-to-end.`
              : `Yes. webhooks.cc can send signed test payloads following the ${page.label} signing scheme from the dashboard, the SDK, or the MCP server.`,
        }
      : {
          question: `Can I replay ${indefiniteArticle(page.label)} ${page.label} webhook against my local server?`,
          answer: `Yes. Capture one real delivery from ${page.label}, then replay it to any URL from the dashboard, or run whk tunnel <port> to forward live deliveries to localhost. webhooks.cc has no built-in ${page.label} sample templates, but the Send button posts any payload and headers you paste in.`,
        },
  ];

  if (page.signatureHeader && !page.inSdk) {
    // Capture-only providers include Basic auth and shared-token schemes, so
    // this wording does not claim the delivery is signed, nor that every
    // delivery carries the header when the provider makes it opt-in.
    const scheme = page.signatureAlgorithmLabel ? ` (${page.signatureAlgorithmLabel})` : "";
    items.push({
      question: `How do I verify ${page.label} webhooks?`,
      answer: `${page.label} ${page.signatureOptional ? "can authenticate deliveries" : "authenticates each delivery"} with the ${page.signatureHeader} header${scheme}. ${page.signatureNote ? `${page.signatureNote} ` : ""}Capture a real delivery on webhooks.cc to inspect the exact header value, then implement the check in your handler.`,
    });
  } else if (page.signatureHeader) {
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
  const comparison = COMPARISON_BY_PROVIDER[page.slug];
  const faqItems = buildFaq(page);
  const reference = page.seo?.reference;
  const testSnippet = providerTestSnippet(page);
  const related = getRelatedProviderPages(page.slug);

  const howToSteps = [
    {
      name: "Create a webhook endpoint",
      text: "Sign in free with GitHub, Google, or email to create a persistent endpoint — or grab an instant guest URL at webhooks.cc without an account.",
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
                className="w-14 h-14 border-strong rounded-md flex items-center justify-center shrink-0 shadow-raised-sm"
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
            {page.label} sends
            {page.inSdk ? (
              <>
                , or fire realistic{page.secretRequired ? ", correctly signed" : ""} sample payloads
                at your own handler without touching a production account.
              </>
            ) : (
              <>, then replay deliveries or forward them to your local handler.</>
            )}
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
            {comparison && (
              <>
                {" "}
                Weighing the alternatives? See{" "}
                <Link href={comparison.href} className="text-primary font-bold hover:underline">
                  {comparison.label}
                </Link>
                .
              </>
            )}
          </p>
        </div>

        {reference && (
          <section className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-4">{reference.heading}</h2>
            <p className="text-muted-foreground mb-6">{reference.intro}</p>
            <div className="ui-card ui-card-static overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-strong border-line">
                    {reference.columns.map((column) => (
                      <th key={column} scope="col" className="text-left py-2 pr-6 font-bold">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reference.rows.map((row) => (
                    <tr key={row[0]} className="border-b border-foreground/10 last:border-0">
                      {row.map((cell, i) => (
                        <td
                          key={i}
                          className={`py-2 pr-6 ${i === reference.codeColumn ? "font-mono" : ""}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              Source:{" "}
              <a
                href={reference.source.href}
                className="text-primary font-bold hover:underline"
                rel="noopener"
              >
                {reference.source.label}
              </a>
              .
            </p>
          </section>
        )}

        {/* How it works */}
        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">How to test {page.label} webhooks</h2>
          <ol className="space-y-4">
            {howToSteps.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <span className="w-9 h-9 border-strong border-line rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0 shadow-raised-sm">
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
          <h2 className="text-2xl md:text-3xl font-bold mb-6">
            {page.label} webhook {page.inSdk ? "signature" : "authentication"}
          </h2>
          <div className="ui-card ui-card-static overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {page.signatureHeader && (
                  <tr className="border-b-strong border-foreground/10">
                    <th className="text-left py-2 pr-6 font-bold whitespace-nowrap">
                      {page.inSdk ? "Signature header" : "Auth header"}
                    </th>
                    <td className="py-2 font-mono">{page.signatureHeader}</td>
                  </tr>
                )}
                {page.signatureAlgorithmLabel && (
                  <tr className="border-b-strong border-foreground/10">
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
          {page.signatureNote ? (
            <p className="text-sm text-muted-foreground mt-3">{page.signatureNote}</p>
          ) : (
            !page.signatureHeader && (
              <p className="text-sm text-muted-foreground mt-3">
                {page.label} does not use a conventional signature header
                {page.slug === "adyen" ? "; the HMAC is embedded in the notification body" : ""}.
                Capture a real delivery to inspect exactly what is sent.
              </p>
            )
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
                  className="text-sm border-strong border-line rounded-md bg-muted px-2 py-1 font-mono"
                >
                  {template}
                </code>
              ))}
            </div>
            <div className="ui-code overflow-x-auto">
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

        {/* Test the handler in CI */}
        {testSnippet && (
          <section className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-4">
              Test your {page.label} webhook handler in CI
            </h2>
            <p className="text-muted-foreground mb-6">
              <code>sendTo</code> signs each request the way {page.label} does, with your test
              secret from <code>{providerSecretEnv(page.slug)}</code>, and posts it straight to your
              handler, so its signature check stays on. The second test proves the handler rejects a
              forged signature. Drop the file into a Vitest suite that runs against your app; for
              Jest, delete the first line, since Jest provides the same globals.
            </p>
            <div className="relative">
              <CopyButton text={testSnippet} />
              <pre className="ui-code syntax-highlight overflow-x-auto text-sm pr-10">
                {/* Safe: highlightCode returns Prism-encoded tokens for a snippet built from static provider metadata. */}
                <code
                  dangerouslySetInnerHTML={{ __html: highlightCode(testSnippet, "typescript") }}
                />
              </pre>
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              Let your coding agent write and run it: the{" "}
              <Link href="/docs/mcp/skills" className="text-primary font-bold hover:underline">
                webhooks.cc agent skill
              </Link>{" "}
              teaches Claude Code, Cursor, and Codex to test webhook handlers with signed payloads.
              More patterns in the{" "}
              <Link href="/docs/sdk/testing" className="text-primary font-bold hover:underline">
                SDK testing docs
              </Link>
              .
            </p>
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
              <Link key={p.slug} href={`/webhooks/${p.slug}`} className="ui-card block group">
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
        <div className="ui-card bg-foreground text-background text-center py-12">
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
