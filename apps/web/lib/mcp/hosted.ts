import { createMcpHandler, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WebhooksCC } from "@webhooks-cc/sdk";
import {
  defaultToolGroups,
  parseToolGroups,
  registerTools,
  sdkToolResult,
  toolCallFrom,
  attachSkill,
  attachInspector,
  type ToolGroup,
  type ToolServer,
} from "@webhooks-cc/mcp/tools";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicEnv, serverEnv } from "@/lib/env";
import { sendOptions } from "@/lib/forwarding/config";
import { sendForward } from "@/lib/forwarding/send";
import { APP_VERSION } from "@/lib/changelog";

/**
 * The remote MCP server at /mcp: the tools of @webhooks-cc/mcp, served
 * statelessly over streamable HTTP with the MCP 2026-07-28 revision
 * (per-request _meta, server/discover, cache hints on lists) and the
 * stateless 2025-era fallback for clients that still open with initialize.
 *
 * Every request gets a fresh server whose tools act through the SDK with
 * the caller's own bearer token, against this process over loopback: the
 * API routes then authenticate, rate-limit and audit the call as they do
 * for any client, under the caller's address. The tools that post to a URL
 * the caller names (send_to, replay_request, targetUrl) are left out, since
 * they would run from this server's network.
 */

const INSTRUCTIONS =
  "webhooks.cc captures webhooks and inbound email for testing. Start with create_endpoint, send to its URL (or point a provider at it), then wait_for_request and get_request to inspect what arrived. send_webhook sends a signed test webhook to an endpoint; verify_signature checks a captured request. Hosted servers cannot reach the user's machine: to forward to localhost, the user runs `whk tunnel` or the local MCP server (npx -y @webhooks-cc/mcp).";

/** Where the API is reached from inside this process. */
export function internalApiUrl(): string {
  const configured = serverEnv().MCP_INTERNAL_API_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

/** Statuses whose responses have no body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

async function bodyBytes(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body === undefined || body === null) return null;
  return Buffer.from(await new Response(body).arrayBuffer());
}

/**
 * Sends a request the way forwarding does: through the notify proxy when one
 * is configured, so the box's IP never shows up in a capture (send_webhook
 * posts to a capture URL, where the receiver records the sender's address).
 * The answer is the proxy's: status and the first kilobyte of the body.
 */
async function viaNotifyProxy(url: string, init: RequestInit | undefined): Promise<Response> {
  const headers: [string, string][] = [];
  new Headers(init?.headers).forEach((value, name) => headers.push([name, value]));
  const result = await sendForward(
    {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers,
      body: await bodyBytes(init?.body),
      mode: "relay",
    },
    sendOptions()
  );
  if (result.error || result.status === null) {
    throw new TypeError(result.error ?? "The request failed.");
  }
  return new Response(NULL_BODY_STATUSES.has(result.status) ? null : (result.excerpt ?? ""), {
    status: result.status,
  });
}

/**
 * The SDK's fetch: requests to the internal API carry the caller's address,
 * which the API's rate limits read (a loopback request has no Cloudflare
 * header of its own). Anything else (the receiver, for send_webhook and
 * test_webhook_flow) leaves through the notify proxy when there is one.
 */
export function callerFetch(clientIp: string | null): typeof fetch {
  const internal = internalApiUrl();
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${internal}/`)) {
      return serverEnv().NOTIFY_PROXY_URL ? viaNotifyProxy(url, init) : fetch(input, init);
    }
    if (!clientIp) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientIp);
    return fetch(input, { ...init, headers });
  };
}

/**
 * Tool calls one account may have running at once (one process serves
 * /mcp). Counted around the handler itself, not the HTTP request: a 2025-era
 * client gets its answer as a stream, so the request returns before the tool
 * finishes, and a wait tool polls the API for up to 50 seconds.
 */
export const MAX_RUNNING_TOOLS_PER_ACCOUNT = 8;
const running = new Map<string, number>();

/** registerTools' view of the v2 server, with the per-account cap. */
function toolServer(server: McpServer, account: string): ToolServer {
  return {
    tool(name, description, shape, handler, annotations, meta) {
      return server.registerTool(
        name,
        {
          title: annotations?.title,
          description,
          inputSchema: z.object(shape),
          annotations,
          ...(meta ? { _meta: meta } : {}),
        },
        async (args: unknown, ctx: ServerContext) => {
          const busy = running.get(account) ?? 0;
          if (busy >= MAX_RUNNING_TOOLS_PER_ACCOUNT) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `At most ${MAX_RUNNING_TOOLS_PER_ACCOUNT} tool calls run at once per account. Retry when one finishes.`,
                },
              ],
              isError: true,
            };
          }
          running.set(account, busy + 1);
          try {
            return sdkToolResult(
              await handler(args as Parameters<typeof handler>[0], toolCallFrom(server, ctx))
            );
          } finally {
            const left = (running.get(account) ?? 1) - 1;
            if (left > 0) running.set(account, left);
            else running.delete(account);
          }
        }
      );
    },
  };
}

export interface CallerAuth {
  token: string;
  clientIp: string | null;
  /** The account the token acts for; the cap on running tools is per account. */
  userId: string;
  /** The tool groups this caller gets (toolSelection). */
  groups: ReadonlySet<ToolGroup>;
  readOnly: boolean;
}

/**
 * Which tools a caller gets: `?tools=` (all, or groups such as core,teams)
 * and `?readonly=1` on the server's address win; else by the client's own
 * name, from this request (the 2026-07-28 per-request _meta, or a 2025-era
 * initialize) or from the OAuth app the token was granted to. Clients that
 * load tools on demand get every group; the rest get the core, since Cursor
 * stops at about 40 tools across all its servers (catalog.ts).
 */
export function toolSelection(
  url: URL,
  clientNames: (string | null | undefined)[]
): { groups: Set<ToolGroup>; readOnly: boolean } {
  const readOnly = /^(1|true|yes)$/i.test(url.searchParams.get("readonly") ?? "");
  const chosen = parseToolGroups(url.searchParams.get("tools"));
  if (chosen) return { groups: chosen.groups, readOnly };
  const name = clientNames.find((value): value is string => Boolean(value));
  return { groups: defaultToolGroups(name), readOnly };
}

/** The client name a request names itself by, if any. */
export function requestClientName(body: unknown, metaKey: string): string | null {
  if (!body || typeof body !== "object") return null;
  const params = (body as { params?: Record<string, unknown> }).params;
  if (!params || typeof params !== "object") return null;
  const meta = params._meta as Record<string, unknown> | undefined;
  const fromMeta = (meta?.[metaKey] as { name?: unknown } | undefined)?.name;
  if (typeof fromMeta === "string") return fromMeta;
  const fromInit = (params.clientInfo as { name?: unknown } | undefined)?.name;
  return typeof fromInit === "string" ? fromInit : null;
}

/** The OAuth app or agent a token's registration names itself, cached briefly. */
const registrationNames = new Map<string, { name: string | null; at: number }>();
const REGISTRATION_NAME_TTL_MS = 10 * 60_000;

export async function registrationClientName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const cached = registrationNames.get(id);
  if (cached && Date.now() - cached.at < REGISTRATION_NAME_TTL_MS) return cached.name;
  const { data, error } = await createAdminClient()
    .from("agent_registrations")
    .select("client_name")
    .eq("id", id)
    .maybeSingle();
  // A failed read only means the default tools: never a refused request.
  if (error) return null;
  const name = (data?.client_name as string | null | undefined) ?? null;
  if (registrationNames.size > 5_000) registrationNames.clear();
  registrationNames.set(id, { name, at: Date.now() });
  return name;
}

/** A fresh server for one request: the caller's tools, the skill and the request inspector. */
export function buildServer(caller: CallerAuth | undefined): McpServer {
  const server = new McpServer(
    { name: "webhooks-cc", title: "webhooks.cc", version: APP_VERSION },
    {
      // The tool list never changes within a request: no listChanged, so a
      // subscriptions/listen stream completes at once instead of holding a slot.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: INSTRUCTIONS,
      // The list depends on the caller (its client, ?tools=, ?readonly=):
      // cached per caller, and it changes otherwise only with a deploy.
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "private" } },
    }
  );
  // A request that reached the handler was authenticated by the route.
  const client = new WebhooksCC({
    apiKey: caller?.token ?? "whcc_unauthenticated",
    baseUrl: internalApiUrl(),
    webhookUrl: publicEnv().NEXT_PUBLIC_WEBHOOK_URL,
    fetch: callerFetch(caller?.clientIp ?? null),
    // Tells the remote server's calls apart from the stdio server's in analytics.
    userAgent: `webhooks-cc-mcp-remote/${APP_VERSION}`,
  });
  // The agent skill, for clients that read skills from their servers.
  attachSkill(server);
  // The request inspector (an MCP App) that get_request and get_email name.
  attachInspector(server);
  registerTools(toolServer(server, caller?.userId ?? "anonymous"), client, {
    remote: true,
    groups: caller?.groups ?? new Set<ToolGroup>(["core"]),
    readOnly: caller?.readOnly ?? false,
  });
  return server;
}

export const mcpHandler = createMcpHandler(
  ({ authInfo }) =>
    buildServer(
      authInfo
        ? {
            token: authInfo.token,
            clientIp: (authInfo.extra?.clientIp as string | undefined) ?? null,
            userId: (authInfo.extra?.userId as string | undefined) ?? authInfo.token,
            groups: (authInfo.extra?.groups as Set<ToolGroup> | undefined) ?? new Set(["core"]),
            readOnly: authInfo.extra?.readOnly === true,
          }
        : undefined
    ),
  {
    // Tool results only, no streaming: one JSON body per request.
    responseMode: "json",
    maxRequestBodySize: 1024 * 1024,
    // The server sends no change notifications; keep idle listen streams few.
    maxSubscriptions: 64,
    // Mostly a client's malformed or unsupported request, not our fault: a
    // log line, never the request itself.
    // The error's name only: a JSON parse error's message quotes the body.
    onerror: (error) => console.warn(`[mcp] request refused (${error.name})`),
  }
);
