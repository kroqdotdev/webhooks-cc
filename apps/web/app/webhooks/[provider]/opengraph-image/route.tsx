import { ogImageNotFound, ogImageResponse } from "@/lib/og/image";
import { getWebhookProviderPage, WEBHOOK_PROVIDER_SLUGS } from "@/lib/webhook-provider-pages";

// One Open Graph image per provider page, all made at build time like the pages.
export const dynamicParams = false;

export function generateStaticParams() {
  return WEBHOOK_PROVIDER_SLUGS.map((provider) => ({ provider }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const page = getWebhookProviderPage(provider);
  if (!page) return ogImageNotFound();

  return ogImageResponse({
    kind: "Webhooks",
    title: `Test ${page.label} webhooks`,
    subtitle: page.inSdk
      ? "Free endpoint, signed samples, signature checks"
      : "Free endpoint, live inspector, replay to localhost",
    path: `/webhooks/${page.slug}`,
  });
}
