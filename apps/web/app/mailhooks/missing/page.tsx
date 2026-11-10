import type { Metadata } from "next";
import { notFound } from "next/navigation";

// The same title as app/mailhooks/not-found.tsx: the browser takes the title
// from this page's metadata once it has loaded, and without one of its own
// that is the layout's, which reads like the home page.
export const metadata: Metadata = {
  title: { absolute: "Page not found | mailhooks.cc" },
  robots: { index: false },
};

/**
 * A mailhooks.cc path that neither site serves is rewritten here (proxy.ts
 * marks it, next.config.ts rewrites it), so the visitor gets mailhooks.cc's
 * own 404 (app/mailhooks/not-found.tsx) instead of a jump to webhooks.cc's.
 */
export default function MailhooksMissing() {
  notFound();
}
