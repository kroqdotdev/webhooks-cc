import { comparePair, comparePairName } from "@/lib/compare-pairs";
import { COMPARE_PAGE_SLUGS } from "@/lib/seo";

/**
 * How each compared tool writes its own name. A compare page missing here
 * still gets an image, named from its slug ("some-tool" reads "Some Tool"),
 * so this list only has to carry the names a slug cannot spell.
 */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  "webhook-site": "Webhook.site",
  ngrok: "ngrok",
  requestbin: "RequestBin",
  "stripe-cli": "Stripe CLI",
  smee: "Smee.io",
  localtunnel: "LocalTunnel",
  mailslurp: "MailSlurp",
};

function nameFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The tool a compare page is about, or null when there is no such page. */
export function compareToolName(slug: string): string | null {
  if (!COMPARE_PAGE_SLUGS.includes(slug)) return null;
  return Object.hasOwn(TOOL_NAMES, slug) ? TOOL_NAMES[slug] : nameFromSlug(slug);
}

/**
 * What a compare page's image says: "webhooks.cc vs <tool>" for a tool's page
 * and "<a> vs <b>" for a pair page, or null when there is no such page.
 */
export function compareImageText(slug: string): { title: string; subtitle: string } | null {
  if (!COMPARE_PAGE_SLUGS.includes(slug)) return null;
  const pair = comparePair(slug);
  if (pair) {
    return {
      title: comparePairName(pair),
      subtitle: "Features and pricing, side by side",
    };
  }
  return {
    title: `webhooks.cc vs ${compareToolName(slug)}`,
    subtitle: "Features, pricing and workflow, side by side",
  };
}
