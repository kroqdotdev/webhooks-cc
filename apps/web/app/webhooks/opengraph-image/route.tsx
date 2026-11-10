import { ogImageResponse } from "@/lib/og/image";
import { getAllWebhookProviderPages } from "@/lib/webhook-provider-pages";

// The /webhooks hub's Open Graph image, made once at build time.
export const dynamic = "force-static";

export function GET() {
  // Rounded down to the ten, like the page's own "50+".
  const count = Math.floor(getAllWebhookProviderPages().length / 10) * 10;
  return ogImageResponse({
    kind: "Webhooks",
    title: `Test webhooks from ${count}+ providers`,
    subtitle: "Free endpoint, signed samples, signature checks",
    path: "/webhooks",
  });
}
