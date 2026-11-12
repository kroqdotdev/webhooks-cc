import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { Card } from "@/components/ui/card";
import {
  COMPARE_PAIRS,
  PAIR_FACTS_CHECKED,
  comparePairName,
  type ComparePair,
  type ComparePairTool,
} from "@/lib/compare-pairs";

const linkClass = "font-semibold hover:text-primary transition-colors";

/** The metadata of a pair page, from its entry in lib/compare-pairs.ts. */
export function pairPageMetadata(pair: ComparePair) {
  return createPageMetadata({
    title: pair.title,
    description: pair.description,
    path: `/compare/${pair.slug}`,
    keywords: pair.keywords,
  });
}

function ToolCard({ tool }: { tool: ComparePairTool }) {
  return (
    <Card>
      <h3 className="text-lg font-bold mb-2">{tool.name}</h3>
      <p className="text-muted-foreground">{tool.about}</p>
    </Card>
  );
}

function PickCard({ tool }: { tool: ComparePairTool }) {
  return (
    <Card>
      <h3 className="text-xl font-bold mb-3">Pick {tool.name} when</h3>
      <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
        {tool.pick.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * An "X vs Y" page: two other tools compared with each other, then where
 * webhooks.cc fits. The same parts and classes as the /compare/<tool> pages.
 */
export function PairComparisonPage({ pair }: { pair: ComparePair }) {
  const name = comparePairName(pair);
  const others = COMPARE_PAIRS.filter(
    (other) =>
      other.slug !== pair.slug &&
      [other.a.name, other.b.name].some((tool) => tool === pair.a.name || tool === pair.b.name)
  );

  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name, path: `/compare/${pair.slug}` },
        ])}
      />
      <JsonLd data={faqSchema([...pair.faq])} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated {PAIR_FACTS_CHECKED}
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">{name}</h1>
        <p className="text-lg text-muted-foreground mb-10">{pair.intro}</p>

        {/* What each one is */}
        <h2 className="text-2xl font-bold mb-4">What each one is for</h2>
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <ToolCard tool={pair.a} />
          <ToolCard tool={pair.b} />
        </div>

        {/* Feature and price table */}
        <h2 className="text-2xl font-bold mb-4">Features and pricing</h2>
        <ComparisonTable
          tools={[{ name: pair.a.name }, { name: pair.b.name }]}
          rows={pair.rows}
          className="mb-3"
        />
        <p className="text-sm text-muted-foreground mb-10">
          {pair.sources}, in {PAIR_FACTS_CHECKED}; &quot;not documented&quot; means we did not find
          it there. Check their pricing before you buy.
        </p>

        {/* When to pick which */}
        <h2 className="text-2xl font-bold mb-4">When to pick which</h2>
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <PickCard tool={pair.a} />
          <PickCard tool={pair.b} />
        </div>

        {/* Where webhooks.cc fits */}
        <h2 className="text-2xl font-bold mb-4">Where webhooks.cc fits</h2>
        <div className="space-y-4 text-muted-foreground mb-4">
          {pair.fit.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <p className="text-sm text-muted-foreground mb-10">
          {pair.fitLinks.map((link, i) => (
            <span key={link.href}>
              {i > 0 && " · "}
              <Link href={link.href} className={linkClass}>
                {link.label}
              </Link>
            </span>
          ))}
        </p>

        <ComparisonCTA compact />

        {/* FAQ */}
        <h2 className="text-2xl font-bold mb-4">Frequently asked questions</h2>
        <div className="space-y-4 mb-4">
          {pair.faq.map((item) => (
            <Card key={item.question}>
              <h3 className="font-bold mb-2">{item.question}</h3>
              <p className="text-muted-foreground text-sm">{item.answer}</p>
            </Card>
          ))}
        </div>

        {/* More comparisons */}
        <p className="text-sm text-muted-foreground mb-0">
          See also:{" "}
          {others.map((other) => (
            <span key={other.slug}>
              <Link href={`/compare/${other.slug}`} className={linkClass}>
                {comparePairName(other)}
              </Link>
              {" · "}
            </span>
          ))}
          <Link href="/compare" className={linkClass}>
            All comparisons
          </Link>
        </p>

        {/* CTA */}
        <ComparisonCTA heading={pair.ctaHeading} />
      </article>
    </main>
  );
}
