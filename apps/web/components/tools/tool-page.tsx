import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { JsonLd, breadcrumbSchema, faqSchema, type FAQItem } from "@/lib/schemas";
import { SITE_URL } from "@/lib/seo";
import { TOOLS, TOOLS_PATH, toolPath, type ToolPage } from "@/lib/tools/catalog";

/**
 * The frame every tool page shares: breadcrumb, heading, the tool itself with
 * its privacy line, then the page's own sections, questions and links. The
 * pages are static; only the tool (a client component passed as `tool`) runs
 * in the browser.
 */

interface ToolPageFrameProps {
  page: ToolPage;
  heading: string;
  lead: ReactNode;
  /** The interactive tool. */
  tool: ReactNode;
  /** One sentence under the tool on where what is typed goes. */
  privacy: string;
  faq: FAQItem[];
  faqHeading: string;
  /** The explanatory sections, between the tool and the questions. */
  children: ReactNode;
  /** The closing links: the provider page, the product. */
  footer: ReactNode;
}

export function ToolPageFrame({
  page,
  heading,
  lead,
  tool,
  privacy,
  faq,
  faqHeading,
  children,
  footer,
}: ToolPageFrameProps) {
  const path = toolPath(page.slug);
  return (
    <main className="min-h-screen px-4 pb-20 pt-12">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Free tools", path: TOOLS_PATH },
          { name: page.name, path },
        ])}
      />
      <JsonLd data={faqSchema(faq)} />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebApplication",
          name: page.name,
          url: `${SITE_URL}${path}`,
          description: page.description,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Any",
          browserRequirements: "Requires JavaScript",
          isAccessibleForFree: true,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          provider: { "@type": "Organization", name: "webhooks.cc", url: SITE_URL },
        }}
      />

      <div className="mx-auto max-w-4xl">
        <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
          <Link href={TOOLS_PATH} className="hover:text-foreground">
            Free tools
          </Link>
          <span aria-hidden className="mx-2">
            /
          </span>
          <span aria-current="page">{page.name}</span>
        </nav>

        <header className="mb-8">
          <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">{heading}</h1>
          <p className="max-w-3xl text-xl text-muted-foreground">{lead}</p>
        </header>

        <section aria-label={page.name} className="mb-14">
          {tool}
          <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
            <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{privacy}</span>
          </p>
        </section>

        {children}

        <section className="mb-12">
          <h2 className="mb-6 text-2xl font-bold md:text-3xl">{faqHeading}</h2>
          <FAQAccordion items={faq} />
        </section>

        {footer}

        <OtherTools current={page.slug} />
      </div>
    </main>
  );
}

export function ToolSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-12">
      <h2 className="mb-4 text-2xl font-bold md:text-3xl">{title}</h2>
      <div className="space-y-4 leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-foreground [&_code]:[overflow-wrap:anywhere] [&_strong]:font-bold [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

interface ReferenceTableProps {
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  /** The column set in the mono face: status codes, field names. */
  codeColumn?: number;
  source?: readonly { label: string; href: string }[];
}

/** A table of facts with where they come from, in the provider pages' look. */
export function ReferenceTable({ columns, rows, codeColumn, source }: ReferenceTableProps) {
  return (
    <div>
      <div className="ui-card ui-card-static overflow-x-auto">
        {/* On a phone the table keeps a readable width and the card scrolls sideways. */}
        <table className="w-full min-w-[30rem] text-sm text-foreground">
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => (
                <th key={column} scope="col" className="py-2 pr-6 text-left font-bold">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-foreground/10 align-top last:border-0">
                {row.map((cell, i) => (
                  <td
                    key={i}
                    className={`py-2 pr-6 ${i === codeColumn ? "whitespace-nowrap font-mono" : ""}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {source && source.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Source:{" "}
          {source.map((item, index) => (
            <span key={item.href}>
              {index > 0 && ", "}
              <a href={item.href} rel="noopener" className="font-bold text-primary hover:underline">
                {item.label}
              </a>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}

/** A text link in the pages' link style. */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-bold text-primary hover:underline">
      {children}
    </Link>
  );
}

interface NextStepProps {
  title: string;
  children: ReactNode;
  links: readonly { href: string; label: string }[];
}

/** The closing block: what webhooks.cc itself does for the same job. */
export function NextStep({ title, children, links }: NextStepProps) {
  return (
    <section className="ui-card ui-card-static mb-12">
      <h2 className="mb-2 text-2xl font-bold">{title}</h2>
      <p className="mb-5 max-w-2xl leading-relaxed text-muted-foreground">{children}</p>
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="font-bold text-primary hover:underline">
              {link.label}
              <ArrowRight aria-hidden className="ml-1 inline-block h-4 w-4" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A link to a tool page. A plain anchor, not a client-side navigation: the two
 * sender tools need the Content-Security-Policy of their own address, which
 * only a full page load gives them (lib/tools/csp.ts).
 */
export function ToolLink({
  slug,
  className,
  children,
}: {
  slug: string;
  className?: string;
  children: ReactNode;
}) {
  const href = toolPath(slug);
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

function OtherTools({ current }: { current: string }) {
  const others = TOOLS.filter((tool) => tool.slug !== current);
  return (
    <section>
      <h2 className="mb-4 text-2xl font-bold">More free tools</h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {others.map((tool) => (
          <li key={tool.slug}>
            <ToolLink slug={tool.slug} className="ui-card group block h-full">
              <h3 className="font-bold transition-colors group-hover:text-primary">{tool.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{tool.summary}</p>
            </ToolLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
