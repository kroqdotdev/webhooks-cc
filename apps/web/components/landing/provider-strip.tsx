import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import { getAllWebhookProviderPages } from "@/lib/webhook-provider-pages";

export function ProviderStrip() {
  const providers = getAllWebhookProviderPages();

  return (
    <section className="py-20 px-4 bg-muted">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">
          Signed test webhooks for 30+ providers
        </h2>
        <p className="text-xl text-muted-foreground mb-10 max-w-2xl">
          Realistic sample payloads with valid signature headers — test your verification code
          without touching a production account.
        </p>
        <div className="flex flex-wrap gap-3">
          {providers.map((provider) => {
            const icon = getWebProviderInfo(provider.slug)?.icon;
            return (
              <Link
                key={provider.slug}
                href={`/webhooks/${provider.slug}`}
                className="inline-flex items-center gap-2 border-2 border-foreground bg-card px-3 py-2 font-bold text-sm shadow-neo-sm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-neo-lg transition-all"
              >
                {icon && (
                  <span
                    className="w-5 h-5 flex items-center justify-center shrink-0"
                    style={{ color: icon.background }}
                  >
                    <ProviderIcon glyph={icon.glyph} fallbackText={icon.text} className="h-4 w-4" />
                  </span>
                )}
                {provider.label}
              </Link>
            );
          })}
          <Link
            href="/webhooks"
            className="inline-flex items-center gap-1 border-2 border-foreground bg-primary text-primary-foreground px-3 py-2 font-bold text-sm shadow-neo-sm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-neo-lg transition-all"
          >
            All providers
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
