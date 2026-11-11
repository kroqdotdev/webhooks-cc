import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";

export const metadata = mailhooksMetadata({
  title: "Guides",
  description:
    "Where to start with mailhooks.cc: capturing email, layouts that read it, destinations that receive it, Zapier and Make, and plan limits.",
  path: "/guides",
  keywords: ["email parser guide", "email to json guide", "parse emails"],
});

/**
 * mailhooks.cc's way into the docs. The articles themselves stay on
 * webhooks.cc (one copy, one canonical URL), so each card says so.
 */
const GUIDES = [
  {
    path: "/docs/email-capture",
    title: "Capture email",
    summary:
      "Every endpoint has an address. Forward a mailbox to it, give it to a sender, and read what arrives.",
  },
  {
    path: "/docs/layouts",
    title: "Read emails with layouts",
    summary:
      "Pick the emails a layout applies to, name the fields to read, and turn lists and attachments into line items.",
  },
  {
    path: "/docs/forwarding",
    title: "Send it somewhere",
    summary:
      "Deliver each email as signed JSON to your webhook, as rows in Google Sheets, or as a message in Slack or Discord.",
  },
  {
    path: "/docs/zapier-make",
    title: "Zapier and Make",
    summary: "Start a Zap or a Make scenario from every email an endpoint receives.",
  },
  {
    path: "/docs/guides/test-signup-emails-playwright",
    title: "Test emails in Playwright",
    summary:
      "Sign up with a real address per test, wait for the email your app sends, and finish the flow with its code or magic link.",
  },
  {
    path: "/docs/plans-limits",
    title: "Plans and limits",
    summary: "What each plan includes: emails, parsed pages, layouts, AI assists and retention.",
  },
];

export default function MailhooksGuides() {
  return (
    <>
      <SiteHeader />
      <main className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Guides</h1>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Start here. Each guide opens the full article in the docs, which cover mailhooks.cc and
            webhooks.cc with one account.
          </p>
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {GUIDES.map((guide) => (
              <li key={guide.path}>
                <Link href={guide.path} className="ui-card block h-full">
                  <p className="font-bold text-lg mb-2">{guide.title}</p>
                  <p className="text-muted-foreground mb-4">{guide.summary}</p>
                  <span className="inline-flex items-center gap-1 text-sm font-bold text-primary">
                    Read the guide
                    <ArrowRight aria-hidden className="h-4 w-4" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <MailhooksFooter />
    </>
  );
}
