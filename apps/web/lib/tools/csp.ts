import { TOOLS, toolPath } from "./catalog";

/**
 * The extra connect-src origins a page gets, for proxy.ts. Two tools call a
 * provider straight from the browser (the webhook URL is a credential, so it
 * must not pass through our servers), and each gets its one origin on its own
 * page and nowhere else: an origin people can create webhooks on is also
 * somewhere an injected script could send data, so the dashboard and every
 * other page keep the policy they had.
 *
 * A document keeps the policy it was loaded with, so a tool page reached by a
 * client-side navigation reloads itself once (lib/tools/own-document.ts).
 */
const CONNECT_SOURCES: ReadonlyMap<string, string> = new Map(
  TOOLS.flatMap((tool) =>
    tool.connectSource ? [[toolPath(tool.slug), tool.connectSource] as const] : []
  )
);

export function toolConnectSources(pathname: string): string[] {
  const source = CONNECT_SOURCES.get(pathname.replace(/\/+$/, ""));
  return source ? [source] : [];
}
