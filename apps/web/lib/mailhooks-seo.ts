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

/** The share image every mailhooks.cc page names, on its own origin. */
export const MAILHOOKS_OG_IMAGE = mailhooksUrl("/og-image.jpg");

export function mailhooksMetadata({
  title,
  description,
  path,
  keywords,
  absoluteTitle = false,
}: {
  /** The page title is the whole title (the home page, which no template reaches). */
  absoluteTitle?: boolean;
  title: string;
  description: string;
  path: string;
  keywords?: string[];
}): Metadata {
  const url = mailhooksUrl(path);
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      locale: "en_US",
      url,
      siteName: SITES.mailhooks.name,
      title,
      description,
      // A page's openGraph replaces the root layout's whole, images included.
      images: [MAILHOOKS_OG_IMAGE],
    },
    twitter: { card: "summary_large_image", title, description, images: [MAILHOOKS_OG_IMAGE] },
    keywords,
  };
}
