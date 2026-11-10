"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useSite } from "@/components/providers/site-provider";
import { servedOnMailhooks, webhooksOrigin } from "@/lib/site";

/**
 * A link that stays a client-side link where the page is shown. On
 * mailhooks.cc a path only webhooks.cc serves (the blog, comparisons, the
 * installation page) becomes a plain link to webhooks.cc: next/link would
 * fetch it from mailhooks.cc, get the proxy's redirect to the other origin,
 * fail that fetch and only then load the page.
 */
export function SiteLink({ href, ...props }: Omit<ComponentProps<"a">, "href"> & { href: string }) {
  const site = useSite();
  if (site.key === "mailhooks" && href.startsWith("/") && !href.startsWith("//")) {
    const path = href.split(/[?#]/, 1)[0] || "/";
    if (!servedOnMailhooks(path)) return <a href={`${webhooksOrigin()}${href}`} {...props} />;
  }
  return <Link href={href} {...props} />;
}
