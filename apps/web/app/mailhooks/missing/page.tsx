import { notFound } from "next/navigation";

/**
 * proxy.ts rewrites a mailhooks.cc path that neither site serves here, so the
 * visitor gets mailhooks.cc's own 404 (app/mailhooks/not-found.tsx) instead of a jump
 * to webhooks.cc's.
 */
export default function MailhooksMissing() {
  notFound();
}
