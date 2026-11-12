import Link from "next/link";
import { comparePairName, comparePairsFor } from "@/lib/compare-pairs";

/**
 * On a /compare/<tool> page: links to the "X vs Y" pages that compare that
 * tool with another one (lib/compare-pairs.ts), so the two kinds of page
 * point at each other. Renders nothing for a tool with no pair page.
 */
export function PairLinks({ tool }: { tool: `/compare/${string}` }) {
  const pairs = comparePairsFor(tool);
  if (pairs.length === 0) return null;

  return (
    <p className="text-sm text-muted-foreground mb-2">
      Tool against tool:{" "}
      {pairs.map((pair, i) => (
        <span key={pair.slug}>
          {i > 0 && " · "}
          <Link
            href={`/compare/${pair.slug}`}
            className="font-semibold hover:text-primary transition-colors"
          >
            {comparePairName(pair)}
          </Link>
        </span>
      ))}
    </p>
  );
}
