import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import { getAllWebhookProviderPages } from "@/lib/webhook-provider-pages";

export function ProviderStrip() {
  // The strip promises signed samples, so it lists SDK providers only.
  const providers = getAllWebhookProviderPages().filter((provider) => provider.inSdk);

  return (
    <section className="py-20 px-4 bg-muted">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">
          Signed test webhooks for 30+ providers
        </h2>
        <p className="text-xl text-muted-foreground mb-10 max-w-2xl">
          Realistic sample payloads with valid signature headers. Test your verification code
          without touching a production account.
        </p>
        <div className="flex flex-wrap gap-3">
          {providers.map((provider, index) => {
            const icon = getWebProviderInfo(provider.slug)?.icon;
            return (
              <Link
                key={provider.slug}
                href={`/webhooks/${provider.slug}`}
                // Phones show the first dozen; the link below the chips lists every provider.
                className={`${index >= 12 ? "max-sm:hidden " : ""}inline-flex items-center gap-2 border border-border rounded-md bg-card px-3 py-2 font-bold text-sm shadow-surface hover:shadow-float-lg transition-all`}
              >
                {icon && (
                  <span
                    // A light chip in dark mode, so dark brand marks (GitHub, Vercel) stay visible.
                    className="w-5 h-5 flex items-center justify-center shrink-0 rounded-sm dark:bg-white"
                    // A near-white brand colour would vanish on the white chip: use the text colour.
                    style={{ color: isNearWhite(icon.background) ? undefined : icon.background }}
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
            className="inline-flex items-center gap-1 border border-border rounded-md bg-primary text-primary-foreground px-3 py-2 font-bold text-sm shadow-surface hover:shadow-float-lg transition-all"
          >
            All providers
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Whether a #rgb or #rrggbb colour is so light it cannot be seen on a white chip. */
function isNearWhite(color: string | undefined): boolean {
  const hex = color?.trim().replace(/^#/, "") ?? "";
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 225;
}
