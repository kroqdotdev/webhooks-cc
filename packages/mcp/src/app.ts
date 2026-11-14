import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { INSPECTOR_HASH, INSPECTOR_HTML } from "./app-html";
import { TOOL_CATALOG } from "./catalog";

/**
 * The request inspector: an MCP App (the io.modelcontextprotocol/ui
 * extension) that clients with MCP Apps render beside a get_request or
 * get_email result. The tools stay as they
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

/**
 * Every inspector name, older hashes included: a client still holding a
 * tool list from before a release (the hosted server lets clients cache it
 * for an hour) asks for the page by its old name and gets the current one.
 */
export const INSPECTOR_URI_TEMPLATE = "ui://webhooks-cc/inspector-{hash}.html";

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
 * Where an email's dashboard link rides in a tool result's _meta: MCP Apps
 * hosts hand a result's _meta to the view and keep it out of the model's
 * context, so the link costs the model nothing. The inspector never renders
 * an email's HTML part (that happens only in the dashboard's sandboxed
 * frame); it offers this link to it instead.
 */
export const DASHBOARD_URL_META = "cc.webhooks/dashboardUrl";

/** The origins of the dashboards a server links to (RegisterToolsOptions.dashboard). */
export interface DashboardOrigins {
  /** The webhooks.cc origin, which opens every endpoint. */
  webhooks: string;
  /** The mailhooks.cc origin, for endpoints listed only there; null when there is one site. */
  mailhooks?: string | null;
}

/** The public origins the local server links to, from the API base URL it talks to. */
export function localDashboardOrigins(baseUrl: string | undefined): DashboardOrigins {
  const webhooks = (baseUrl ?? "https://webhooks.cc").replace(/\/+$/, "");
  // Production serves mailhooks.cc too; another base URL (a dev server) is one site.
  return webhooks === "https://webhooks.cc"
    ? { webhooks, mailhooks: "https://mailhooks.cc" }
    : { webhooks };
}

/**
 * The dashboard's page for one request (/dashboard?endpoint=&request=), on
 * the site that lists its endpoint: mailhooks.cc for an endpoint listed only
 * there, else webhooks.cc, whose dashboard opens any endpoint by its slug.
 */
export function dashboardRequestUrl(
  origins: DashboardOrigins,
  slug: string,
  requestId: string,
  site?: string | null
): string | null {
  const origin = site === "mailhooks" && origins.mailhooks ? origins.mailhooks : origins.webhooks;
  let url: URL;
  try {
    url = new URL("/dashboard", origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.searchParams.set("endpoint", slug);
  url.searchParams.set("request", requestId);
  return url.toString();
}

const INSPECTOR_METADATA = {
  title: "Request inspector",
  description:
    "The interactive view of a captured request or email that get_request and get_email open in clients with MCP Apps.",
  mimeType: APP_MIME_TYPE,
  _meta: { ui: INSPECTOR_UI_META },
};

/** The current page, under the name it was asked for. */
function inspectorContents(uri: string) {
  return {
    contents: [
      {
        uri,
        mimeType: APP_MIME_TYPE,
        text: INSPECTOR_HTML,
        _meta: { ui: INSPECTOR_UI_META },
      },
    ],
  };
}

/** Serves the inspector from `server`; call it before connecting. */
export function attachInspector(server: McpServer): void {
  server.registerResource("request-inspector", INSPECTOR_URI, INSPECTOR_METADATA, async () =>
    inspectorContents(INSPECTOR_URI)
  );
  // Older names are answered too; resources/list names only the current one.
  server.registerResource(
    "request-inspector-any",
    new ResourceTemplate(INSPECTOR_URI_TEMPLATE, { list: undefined }),
    INSPECTOR_METADATA,
    async (uri) => inspectorContents(uri.toString())
  );
}
