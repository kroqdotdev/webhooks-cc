import { PairComparisonPage, pairPageMetadata } from "@/components/compare/pair-comparison-page";
import { requireComparePair } from "@/lib/compare-pairs";

// The page's content is its entry in lib/compare-pairs.ts.
const pair = requireComparePair("ngrok-vs-hookdeck");

export const metadata = pairPageMetadata(pair);

export default function NgrokVsHookdeckPage() {
  return <PairComparisonPage pair={pair} />;
}
