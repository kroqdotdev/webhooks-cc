import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ToolLink } from "@/components/tools/tool-page";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";
import { SITE_URL, createPageMetadata } from "@/lib/seo";
import { TOOLS, TOOLS_PATH, toolPath } from "@/lib/tools/catalog";

export const metadata = createPageMetadata({
  title: "Free Webhook Tools: Discord & Slack Testers, Signature Checker",
  description:
    "Free tools that run in your browser: send a test message to a Discord or Slack webhook and read the answer, or compute and check a webhook's HMAC signature. No account, nothing stored.",
  path: TOOLS_PATH,
  keywords: [
    "webhook tools",
    "free webhook tools",
    "webhook tester",
    "discord webhook tester",
    "slack webhook tester",
    "webhook signature checker",
  ],
});

export default function ToolsPage() {
  return (
    <main className="min-h-screen px-4 pb-20 pt-12">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Free tools", path: TOOLS_PATH },
        ])}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Free webhook tools",
          itemListElement: TOOLS.map((tool, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: tool.name,
            url: `${SITE_URL}${toolPath(tool.slug)}`,
          })),
        }}
      />

      <div className="mx-auto max-w-4xl">
        <header className="mb-10">
          <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">Free webhook tools</h1>
          <p className="max-w-3xl text-xl text-muted-foreground">
            Small tools for the moments between writing a webhook and trusting it. Each one runs in
            your browser: what you type goes to the provider you are testing, or nowhere at all.
          </p>
        </header>

        <ul className="mb-14 space-y-4">
          {TOOLS.map((tool) => (
            <li key={tool.slug}>
              <ToolLink
                slug={tool.slug}
                className="ui-card group flex items-center justify-between gap-6"
              >
                <span>
                  <span className="block text-lg font-bold transition-colors group-hover:text-primary">
                    {tool.name}
                  </span>
                  <span className="mt-1 block text-muted-foreground">{tool.summary}</span>
                </span>
                <ArrowRight
                  aria-hidden
                  className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
                />
              </ToolLink>
            </li>
          ))}
        </ul>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-bold md:text-3xl">What stays in your browser</h2>
          <div className="max-w-3xl space-y-4 leading-relaxed text-muted-foreground">
            <p>
              A webhook URL and a signing secret are credentials, so these tools have no server
              behind them. The Discord and Slack testers send your message from your browser
              straight to Discord or Slack. The signature checker makes no request at all. Nothing
              you type is stored, put in the page&apos;s address, or recorded by analytics.
            </p>
          </div>
        </section>

        <section className="ui-card ui-card-static">
          <h2 className="mb-2 text-2xl font-bold">When one test is not enough</h2>
          <p className="mb-5 max-w-2xl leading-relaxed text-muted-foreground">
            webhooks.cc gives you a URL that captures every webhook sent to it: headers, body and
            signature, kept so you can read them, replay them, and forward them to your machine with{" "}
            <code className="font-mono text-foreground">whk tunnel</code>. It is free to start,
            without an account.
          </p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {[
              { href: "/", label: "Get a free endpoint" },
              { href: "/webhooks", label: "Browse webhook providers" },
              { href: "/docs", label: "Read the docs" },
            ].map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="font-bold text-primary hover:underline">
                  {link.label}
                  <ArrowRight aria-hidden className="ml-1 inline-block h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
