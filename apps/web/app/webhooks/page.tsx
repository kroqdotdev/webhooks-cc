import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import {
  getAllWebhookProviderPages,
  WEBHOOK_PROVIDER_CATEGORIES,
} from "@/lib/webhook-provider-pages";

export const metadata = createPageMetadata({
  title: "Test Webhooks From 30+ Providers — Stripe, GitHub, Shopify & More",
  description:
    "Capture, inspect, and test webhooks from Stripe, GitHub, Shopify, Slack, PayPal, and 30+ other providers. Free endpoint, signed sample payloads, signature verification.",
  path: "/webhooks",
  keywords: [
    "webhook tester",
    "test webhooks online",
    "webhook providers",
    "sample webhook payloads",
    "signed webhook examples",
    "webhook signature verification",
  ],
});

export default function WebhooksHubPage() {
  const providers = getAllWebhookProviderPages();

  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Webhook Providers", path: "/webhooks" },
        ])}
      />

      <div className="max-w-6xl mx-auto">
        <div className="max-w-3xl mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            Test webhooks from any provider
          </h1>
          <p className="text-xl text-muted-foreground mb-6">
            Point a provider at a webhooks.cc URL and inspect every delivery — or send realistic,
            correctly-signed sample payloads without touching a production account. Pick your
            provider for setup steps, signature details, and sample events.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/go" className="neo-btn-primary">
              Get a free webhook URL
              <ArrowRight className="inline-block ml-2 h-5 w-5" />
            </Link>
            <Link href="/docs/endpoints/provider-templates" className="neo-btn-outline">
              Provider templates docs
            </Link>
          </div>
        </div>

        {WEBHOOK_PROVIDER_CATEGORIES.map((category) => {
          const group = providers.filter((p) => p.category === category);
          if (group.length === 0) return null;
          return (
            <section key={category} className="mb-12">
              <h2 className="text-2xl font-bold mb-6">{category}</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {group.map((provider) => {
                  const icon = getWebProviderInfo(provider.slug)?.icon;
                  return (
                    <Link
                      key={provider.slug}
                      href={`/webhooks/${provider.slug}`}
                      className="neo-card block group"
                    >
                      <div className="flex items-center gap-3 mb-2">
                        {icon && (
                          <span
                            className="w-8 h-8 border-2 flex items-center justify-center shrink-0"
                            style={{
                              backgroundColor: icon.background,
                              color: icon.foreground,
                              borderColor: icon.border,
                            }}
                          >
                            <ProviderIcon
                              glyph={icon.glyph}
                              fallbackText={icon.text}
                              className="h-4 w-4"
                            />
                          </span>
                        )}
                        <h3 className="font-bold text-lg group-hover:text-primary transition-colors">
                          {provider.label}
                        </h3>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2">{provider.blurb}</p>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}

        <div className="neo-card neo-card-static bg-muted mt-4">
          <h2 className="font-bold text-xl mb-2">Using a provider we don&apos;t list?</h2>
          <p className="text-muted-foreground">
            Every webhooks.cc endpoint accepts any HTTP webhook — the provider pages just add signed
            sample payloads and signature verification.{" "}
            <Link href="/go" className="text-primary font-bold hover:underline">
              Create a free endpoint
            </Link>{" "}
            and point your service at it, or use the{" "}
            <Link
              href="/docs/guides/verify-webhook-signatures"
              className="text-primary font-bold hover:underline"
            >
              generic HMAC verification
            </Link>{" "}
            for custom senders.
          </p>
        </div>
      </div>
    </main>
  );
}
