import type { Metadata } from "next";
import { SiteProvider } from "@/components/providers/site-provider";
import { SITES } from "@/lib/site";
import { mailhooksUrl } from "@/lib/mailhooks-seo";

/**
 * mailhooks.cc's own pages, served at its root by next.config.ts's host
 * rewrites (proxy.ts keeps them off webhooks.cc). Static, like webhooks.cc's
 * marketing pages: the site is fixed here, not read from the request.
 */
export const metadata: Metadata = {
  title: {
    default: `${SITES.mailhooks.name}: ${SITES.mailhooks.tagline}`,
    template: "%s | mailhooks.cc",
  },
  description:
    "Give each sender an address, describe its emails once, and get orders, bookings, receipts and reports as JSON, Google Sheets rows or chat messages.",
  metadataBase: new URL(mailhooksUrl("/")),
  applicationName: SITES.mailhooks.name,
  alternates: { canonical: mailhooksUrl("/"), types: {} },
};

export default function MailhooksLayout({ children }: { children: React.ReactNode }) {
  return <SiteProvider site="mailhooks">{children}</SiteProvider>;
}
