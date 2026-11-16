import type { Metadata } from "next";
import { SITES } from "@/lib/site";
import { currentSite } from "@/lib/site-server";

/**
 * Support serves both sites, so the titles of the pages below it (a ticket,
 * a new ticket) name the site they are shown on; the root layout's template
 * says webhooks.cc. /support itself sets its own (app/support/page.tsx).
 */
export async function generateMetadata(): Promise<Metadata> {
  const site = SITES[await currentSite()];
  return { title: { template: `%s | ${site.name}`, default: site.name } };
}

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
