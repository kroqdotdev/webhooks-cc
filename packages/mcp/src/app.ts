import type { McpServer } from "@modelcontextprotocol/server";
import { INSPECTOR_HASH, INSPECTOR_HTML } from "./app-html";
import { TOOL_CATALOG } from "./catalog";
import type { ToolResult } from "./tools";

/**
 * The request inspector: an MCP App (the io.modelcontextprotocol/ui
 * extension) that clients with MCP Apps (Claude, ChatGPT, VS Code, Cursor)
 * render beside a get_request or get_email result. The tools stay as they
 * are for every other client: the UI is a resource the tool's _meta names,
 * and clients without MCP Apps ignore it. The page is one self-contained
 * HTML document built from app/ by scripts/build-app.mjs (app-html.ts); it
 * reads the tool's result and asks the server for more through the client
 * (list_requests, get_request, get_email), never over the network itself.
 */

/** The MIME type MCP Apps hosts render. */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Where the inspector is served. The name carries the page's hash, so a
 * client that caches resources by URI never shows an older inspector.
 */
export const INSPECTOR_URI = `ui://webhooks-cc/inspector-${INSPECTOR_HASH}.html`;

/** What the resource's _meta asks of the host: a border, and the clipboard for Copy. */
const INSPECTOR_UI_META = {
  prefersBorder: true,
  permissions: { clipboardWrite: {} },
  // Everything the page shows comes from tool results: no network at all.
  csp: { connectDomains: [] },
};

/** A tool's _meta: the inspector for the tools the catalog marks, else nothing. */
export function appToolMeta(name: string): Record<string, unknown> | undefined {
  if (TOOL_CATALOG[name]?.ui !== true) return undefined;
  // The nested key is the spec's; the flat one is what older hosts read.
  return { ui: { resourceUri: INSPECTOR_URI }, "ui/resourceUri": INSPECTOR_URI };
}

/**
 * A successful answer with its JSON also as structuredContent, which the
 * inspector reads. It is the very object the text holds (parsed back from
 * it), because some clients (Claude Code) give the model structuredContent
 * instead of the text: the model sees the same data either way.
 */
export function withStructuredContent(result: ToolResult): ToolResult {
  if (result.isError || result.approval || result.content.length !== 1) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content[0].text);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
  return { ...result, structuredContent: parsed as Record<string, unknown> };
}

/**
 * A handler for registration: the inspector's tools also return
 * structuredContent, the rest are left as they are.
 */
export function appToolHandler<A, C>(
  name: string,
  handler: (args: A, call?: C) => Promise<ToolResult>
): (args: A, call?: C) => Promise<ToolResult> {
  if (TOOL_CATALOG[name]?.ui !== true) return handler;
  return async (args, call) => withStructuredContent(await handler(args, call));
}

/** Serves the inspector from `server`; call it before connecting. */
export function attachInspector(server: McpServer): void {
  server.registerResource(
    "request-inspector",
    INSPECTOR_URI,
    {
      title: "Request inspector",
      description:
        "The interactive view of a captured request or email that get_request and get_email open in clients with MCP Apps.",
      mimeType: APP_MIME_TYPE,
      _meta: { ui: INSPECTOR_UI_META },
    },
    async () => ({
      contents: [
        {
          uri: INSPECTOR_URI,
          mimeType: APP_MIME_TYPE,
          text: INSPECTOR_HTML,
          _meta: { ui: INSPECTOR_UI_META },
        },
      ],
    })
  );
}
