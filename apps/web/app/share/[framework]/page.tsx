import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { StartFreeCTA } from "@/components/landing/start-free-cta";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { CodeSample, InlineCode } from "@/components/share/code-sample";
import {
  getRelatedShareFrameworkPages,
  getShareFrameworkPage,
  SHARE_FRAMEWORK_SLUGS,
  shareCommand,
  type ShareFrameworkPage,
} from "@/lib/share-framework-pages";
import { Card } from "@/components/ui/card";

interface PageProps {
  params: Promise<{ framework: string }>;
}

export function generateStaticParams() {
  return SHARE_FRAMEWORK_SLUGS.map((framework) => ({ framework }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { framework } = await params;
  const page = getShareFrameworkPage(framework);
  if (!page) return {};

  return createPageMetadata({
    title: page.title,
    description: page.description,
    path: `/share/${page.slug}`,
    keywords: page.keywords,
  });
}

/** The two commands, as they are typed: the dev server, then the share. */
function commands(page: ShareFrameworkPage): string {
  return [
    "# terminal 1: the dev server",
    page.devCommand,
    "",
    "# terminal 2: the link",
    shareCommand(page),
  ].join("\n");
}

export default async function ShareFrameworkPageRoute({ params }: PageProps) {
  const { framework } = await params;
  const page = getShareFrameworkPage(framework);
  if (!page) notFound();

  const related = getRelatedShareFrameworkPages(page.slug);
  const glance: [string, string][] = [
    ["Dev server", `\`${page.devCommand}\`, port ${page.port}`],
    ["Share it", `\`${shareCommand(page)}\``],
    ["Setting to add", page.hostSetting],
    ["Without it", page.withoutIt],
    ["Hot reload", page.hotReload],
    ["URLs and cookies", page.urlsAndCookies],
  ];

  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Share localhost", path: "/share" },
          { name: page.label, path: `/share/${page.slug}` },
        ])}
      />
      <JsonLd data={faqSchema(page.faq)} />

      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <p className="text-sm text-muted-foreground mb-3">
            <Link href="/share" className="hover:text-foreground">
              Share localhost
            </Link>{" "}
            / {page.label}
          </p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">{page.h1}</h1>
          <p className="text-xl text-muted-foreground mb-6">
            <InlineCode text={page.intro} />
          </p>
          <CodeSample code={commands(page)} copy={shareCommand(page)} />
          <p className="text-sm text-muted-foreground mt-3 mb-6">
            The link is <code className="font-mono">https://&lt;name&gt;.sharehooks.cc</code> and
            works until you press Ctrl-C. No <code className="font-mono">whk</code> yet?{" "}
            <Link href="/share#install" className="text-primary font-bold hover:underline">
              Install it and log in
            </Link>
            , which takes a minute.
          </p>
          <StartFreeCTA goCta={null} />
        </div>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">{page.label} at a glance</h2>
          <Card className="text-sm divide-y divide-foreground/10" render={<dl />}>
            {glance.map(([label, value]) => (
              <div
                key={label}
                className="py-2.5 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[9.5rem_1fr] sm:gap-6"
              >
                <dt className="font-bold mb-1 sm:mb-0">{label}</dt>
                <dd className="text-muted-foreground wrap-anywhere">
                  <InlineCode text={value} />
                </dd>
              </div>
            ))}
          </Card>
          <p className="text-sm text-muted-foreground mt-3">
            Your dev server gets each request with{" "}
            <code className="font-mono">Host: localhost:{page.port}</code>; the public name travels
            in <code className="font-mono">X-Forwarded-Host</code>, with{" "}
            <code className="font-mono">X-Forwarded-Proto: https</code>.{" "}
            <Link
              href="/share#what-your-server-sees"
              className="text-primary font-bold hover:underline"
            >
              What your server sees
            </Link>{" "}
            has the rest.
          </p>
        </section>

        {page.sections.map((section) => (
          <section key={section.heading} className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-4">{section.heading}</h2>
            <div className="space-y-4 text-muted-foreground">
              {section.body.map((paragraph) => (
                <p key={paragraph}>
                  <InlineCode text={paragraph} />
                </p>
              ))}
            </div>
            {section.snippet && (
              <div className="mt-6">
                <CodeSample code={section.snippet.code} file={section.snippet.file} />
              </div>
            )}
            {section.after && (
              <p className="text-muted-foreground mt-4">
                <InlineCode text={section.after} />
              </p>
            )}
          </section>
        ))}

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">{page.label} questions</h2>
          <FAQAccordion items={page.faq} />
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-4">Sources</h2>
          <p className="text-sm text-muted-foreground mb-3">
            The {page.label} settings and messages on this page are from the official documentation
            {page.fromSource ? " and source" : ""} for {page.label} {page.version}, read on{" "}
            {page.checked}. What the link does to a request is from the{" "}
            <Link href="/docs/share" className="text-primary font-bold hover:underline">
              whk share docs
            </Link>
            .
          </p>
          <ul className="text-sm space-y-1">
            {page.sources.map((source) => (
              <li key={source.href}>
                <a
                  href={source.href}
                  className="text-primary font-bold hover:underline"
                  rel="noopener"
                >
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Other frameworks</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            {related.map((other) => (
              <Card
                interactive
                key={other.slug}
                className="block group"
                render={<Link href={`/share/${other.slug}`} />}
              >
                <h3 className="font-bold group-hover:text-primary transition-colors">
                  {other.label}
                </h3>
                <p className="text-xs text-muted-foreground mt-1 font-mono">
                  {shareCommand(other)}
                </p>
              </Card>
            ))}
          </div>
          <p className="mt-4 text-sm">
            <Link href="/share#frameworks" className="text-primary font-bold hover:underline">
              All {SHARE_FRAMEWORK_SLUGS.length} framework guides
              <ArrowRight className="inline-block ml-1 h-4 w-4" />
            </Link>
          </p>
        </section>

        <Card interactive className="bg-foreground text-background text-center py-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-3">
            Send someone your {page.label} app
          </h2>
          <p className="opacity-80 mb-6 max-w-md mx-auto">
            Sign up free, install the CLI and run {shareCommand(page)}.
          </p>
          <div className="flex justify-center">
            <PricingCTA inverted />
          </div>
          <p className="text-sm opacity-80 mt-6">No credit card</p>
        </Card>
      </div>
    </main>
  );
}
