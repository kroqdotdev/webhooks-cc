/**
 * The free browser tools under /tools (webhooks.cc only). This list is the
 * one place they are named: the index page, the sitemap, the Open Graph
 * images and the Content-Security-Policy exceptions in proxy.ts all read it.
 *
 * Each tool runs in the visitor's browser. What a person types (a webhook
 * URL, a secret, a message) is a credential or their own content, and never
 * reaches our servers: there is no API route behind any of them.
 */

export interface ToolPage {
  slug: string;
  /** The name on the index card and in breadcrumbs. */
  name: string;
  /** The page title, which is what search results show. */
  title: string;
  description: string;
  /** One or two sentences for the index card. */
  summary: string;
  /** The line under the title on the Open Graph image. */
  ogSubtitle: string;
  /**
   * The one other origin the page's script may call, added to connect-src on
   * that page only (lib/tools/csp.ts). Null for a tool that makes no requests.
   */
  connectSource: string | null;
  /** When the page's content last changed (YYYY-MM-DD); the sitemap lastmod. */
  updated: string;
}

export const TOOLS_PATH = "/tools";

export const TOOLS: readonly ToolPage[] = [
  {
    slug: "discord-webhook-tester",
    name: "Discord webhook tester",
    title: "Discord Webhook Tester: Send a Test Message & Check a URL",
    description:
      "Paste a Discord webhook URL, write a message or an embed, and send it from your browser. See Discord's answer explained: what 401, 404 and 429 mean, and whether the URL still works.",
    summary:
      "Post a message or an embed to a Discord webhook URL, or check that the URL still works without posting anything.",
    ogSubtitle: "Send a test message, read Discord's answer",
    connectSource: "https://discord.com",
    updated: "2026-11-12",
  },
  {
    slug: "slack-webhook-tester",
    name: "Slack webhook tester",
    title: "Slack Webhook Tester: Send a Test Message to an Incoming Webhook",
    description:
      "Paste a Slack incoming webhook URL, write a message or Block Kit JSON, and send it from your browser. Slack's answer is explained, from invalid_payload to channel_is_archived, with the curl command to copy.",
    summary:
      "Post text or Block Kit JSON to a Slack incoming webhook and read what Slack answers, with the matching curl command.",
    ogSubtitle: "Send a test message, read Slack's answer",
    connectSource: "https://hooks.slack.com",
    updated: "2026-11-12",
  },
  {
    slug: "webhook-signature-checker",
    name: "Webhook signature checker",
    title: "Webhook Signature Checker: HMAC Calculator With Provider Presets",
    description:
      "Compute an HMAC-SHA256, SHA-1 or SHA-512 signature in your browser and check it against a header, or check a captured request the way Stripe, GitHub, Shopify, Slack, DocuSign and other providers sign theirs.",
    summary:
      "Compute an HMAC signature, or check a request's signature headers the way Stripe, GitHub, Shopify, DocuSign and other providers sign them.",
    ogSubtitle: "HMAC in your browser, with provider presets",
    connectSource: null,
    updated: "2026-11-12",
  },
];

export const TOOL_SLUGS: readonly string[] = TOOLS.map((tool) => tool.slug);

export function toolPath(slug: string): string {
  return `${TOOLS_PATH}/${slug}`;
}

export function getTool(slug: string): ToolPage | null {
  return TOOLS.find((tool) => tool.slug === slug) ?? null;
}

/** The tool with this slug; throws for a slug the catalogue does not have. */
export function requireTool(slug: string): ToolPage {
  const tool = getTool(slug);
  if (!tool) throw new Error(`No tool named ${slug}`);
  return tool;
}

/** The newest `updated` among the tools: when the index page last changed. */
export function toolsLastModified(): Date {
  const newest = TOOLS.reduce(
    (latest, tool) => (tool.updated > latest ? tool.updated : latest),
    ""
  );
  return new Date(`${newest}T00:00:00.000Z`);
}
