import type { Metadata } from "next";
import { SITES, mailhooksOrigin } from "@/lib/site";

/**
 * Metadata for mailhooks.cc's own pages (app/mailhooks): absolute URLs on
 * its origin, its name in titles and cards. Built when the pages are, from
 * NEXT_PUBLIC_MAILHOOKS_URL; without it the pages are never served.
 */
export function mailhooksUrl(path: string): string {
  return `${mailhooksOrigin() ?? "https://mailhooks.cc"}${path === "/" ? "" : path}`;
}

export function mailhooksMetadata({
  title,
  description,
  path,
  keywords,
}: {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
}): Metadata {
  const url = mailhooksUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      locale: "en_US",
      url,
      siteName: SITES.mailhooks.name,
      title,
      description,
    },
    twitter: { card: "summary", title, description },
    keywords,
  };
}
