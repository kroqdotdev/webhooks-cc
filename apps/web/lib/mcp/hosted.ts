import {
  createMcpHandler,
  isCallToolResult,
  McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { WebhooksCC } from "@webhooks-cc/sdk";
import {
  defaultToolGroups,
  errorResult,
  toolInputSchema,
  parseToolGroups,
  registerTools,
  sdkToolResult,
  TARGET_URL_TOOLS,
  TOOL_GROUP_NAMES,
  toolCallFrom,
  attachSkill,
  attachInspector,
  type ToolGroup,
  type ToolServer,
} from "@webhooks-cc/mcp/tools";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicEnv, serverEnv } from "@/lib/env";
import { mailhooksOrigin, webhooksOrigin } from "@/lib/site";
import { sendOptions } from "@/lib/forwarding/config";
import { sendForward } from "@/lib/forwarding/send";
import { APP_VERSION, MCP_VERSION } from "@/lib/changelog";

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

export const INSTRUCTIONS =
  "webhooks.cc captures webhooks and inbound email for testing. Start with create_endpoint, send to its URL (or point a provider at it), then wait_for_request and get_request to inspect what arrived. send_webhook sends a signed test webhook to an endpoint; verify_signature checks a captured request. Hosted servers cannot reach the user's machine: to forward to localhost, the user runs `whk tunnel` or the local MCP server (npx -y @webhooks-cc/mcp). Clients that take long tool lists get every tool; others get the core. For the rest, add ?tools=all to the server's address, or name groups beside core: forwarding, layouts, extras (bulk changes, counts, schemas), teams, account (billing, keys, agents, share links), domains, sheets (Google Sheets) and names (preview names), as in ?tools=core,teams.";

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
 * which the API's rate limits read, and its country, which an approval's
 * page shows as where the agent asked from (a loopback request has no
 * Cloudflare headers of its own). Anything else (the receiver, for
 * send_webhook and test_webhook_flow) leaves through the notify proxy when
 * there is one.
 */
export function callerFetch(clientIp: string | null, country: string | null = null): typeof fetch {
  const internal = internalApiUrl();
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${internal}/`)) {
      return serverEnv().NOTIFY_PROXY_URL ? viaNotifyProxy(url, init) : fetch(input, init);
    }
    if (!clientIp && !country) return fetch(input, init);
    const headers = new Headers(init?.headers);
    if (clientIp) headers.set("cf-connecting-ip", clientIp);
    if (country) headers.set("cf-ipcountry", country);
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

/** Set on the parsed arguments of a call whose raw arguments named targetUrl. */
const SENT_TARGET_URL = Symbol("sentTargetUrl");

/** Said beside the result of a call that named a targetUrl the hosted server never posts to. */
export const TARGET_URL_NOTE =
  "targetUrl was ignored and nothing was posted to it: this hosted server cannot reach your machine. Posting to your own URL needs the local MCP server (npx -y @webhooks-cc/mcp).";

/**
 * The input schema of a tool whose targetUrl the hosted server leaves out:
 * the same object schema, listed the same way, but a call from a client
 * that still sends targetUrl (one with a tools/list from before it was left
 * out) is marked before the object schema drops the key, so the result can
 * say nothing was posted rather than succeed in silence.
 */
function noticingTargetUrl(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: standard.vendor,
      jsonSchema: standard.jsonSchema,
      async validate(value) {
        const result = await standard.validate(value);
        const sent =
          typeof value === "object" &&
          value !== null &&
          Object.hasOwn(value, "targetUrl") &&
          (value as { targetUrl?: unknown }).targetUrl !== undefined;
        if (result.issues || !sent) return result;
        return { value: { ...(result.value as object), [SENT_TARGET_URL]: true } };
      },
    },
  };
}

/** The tool whose description carries the note on unknown groups: in core, and read-only. */
const NOTED_TOOL = "describe";

/** registerTools' view of the v2 server, with the per-account cap. */
function toolServer(server: McpServer, account: string, note: string | null): ToolServer {
  return {
    tool(name, description, shape, handler, annotations, meta) {
      const schema = toolInputSchema(z.object(shape), Object.keys(shape));
      return server.registerTool(
        name,
        {
          title: annotations?.title,
          description: note && name === NOTED_TOOL ? `${description} ${note}` : description,
          inputSchema:
            TARGET_URL_TOOLS.has(name) && !("targetUrl" in shape)
              ? noticingTargetUrl(schema)
              : schema,
          annotations,
          ...(meta ? { _meta: meta } : {}),
        },
        async (rawArgs: unknown, ctx: ServerContext) => {
          const marked = rawArgs as Record<PropertyKey, unknown>;
          const sentTargetUrl = marked?.[SENT_TARGET_URL] === true;
          let args = rawArgs;
          if (sentTargetUrl) {
            const plain = { ...marked };
            delete plain[SENT_TARGET_URL];
            args = plain;
          }
          const busy = running.get(account) ?? 0;
          if (busy >= MAX_RUNNING_TOOLS_PER_ACCOUNT) {
            return sdkToolResult(
              errorResult(
                "rate_limited",
                `At most ${MAX_RUNNING_TOOLS_PER_ACCOUNT} tool calls run at once per account.`,
                "Retry when one finishes."
              )
            );
          }
          running.set(account, busy + 1);
          try {
            const result = sdkToolResult(
              await handler(args as Parameters<typeof handler>[0], toolCallFrom(server, ctx))
            );
            if (!sentTargetUrl || !isCallToolResult(result)) return result;
            return {
              ...result,
              content: [...result.content, { type: "text" as const, text: TARGET_URL_NOTE }],
            };
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
  /** Cloudflare's country code for the caller (CF-IPCountry), when it sent one. */
  country?: string | null;
  /** The account the token acts for; the cap on running tools is per account. */
  userId: string;
  /** The tool groups this caller gets (toolSelection). */
  groups: ReadonlySet<ToolGroup>;
  readOnly: boolean;
  /** Names in ?tools= that are no group, sanitised (toolSelection). */
  unknownGroups?: readonly string[];
}

/** At most this many unknown names are reported, each at most this long. */
const MAX_UNKNOWN_GROUPS = 5;
const MAX_UNKNOWN_GROUP_LENGTH = 32;

/** Unknown group names as they may be shown and logged: a few, short, plain characters only. */
function sanitiseUnknown(names: string[]): string[] {
  const clean = names
    .map((name) =>
      name
        .toLowerCase()
        // A "?" for each other character, never dropped, so junk such as
        // "te<a>ms" cannot read as a real group ("teams") in the note.
        .replace(/[^a-z0-9_-]/gu, "?")
        .slice(0, MAX_UNKNOWN_GROUP_LENGTH)
    )
    .filter(Boolean);
  return [...new Set(clean)].slice(0, MAX_UNKNOWN_GROUPS);
}

/** Unknown names already logged, so a client that repeats one logs it once. */
const warnedUnknown = new Set<string>();

function warnUnknown(names: string[]): void {
  for (const name of names) {
    if (warnedUnknown.has(name)) continue;
    if (warnedUnknown.size >= 1_000) warnedUnknown.clear();
    warnedUnknown.add(name);
    console.warn(`[mcp] unknown tool group in ?tools=: ${name}`);
  }
}

/** What the server says about unknown names in ?tools=, or null when there are none. */
export function unknownGroupsNote(unknown: readonly string[] | undefined): string | null {
  if (!unknown || unknown.length === 0) return null;
  const named = unknown.map((name) => `"${name}"`).join(", ");
  return `Unknown tool groups in ?tools=: ${named} (known: all, ${TOOL_GROUP_NAMES.join(", ")}).`;
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
): ToolSelectionResult {
  return selectTools(url, parseToolGroups(url.searchParams.get("tools")), clientNames);
}

type ToolSelectionResult = { groups: Set<ToolGroup>; readOnly: boolean; unknown: string[] };

function selectTools(
  url: URL,
  chosen: ReturnType<typeof parseToolGroups>,
  clientNames: (string | null | undefined)[]
): ToolSelectionResult {
  const readOnly = /^(1|true|yes)$/i.test(url.searchParams.get("readonly") ?? "");
  const unknown = sanitiseUnknown(chosen?.unknown ?? []);
  warnUnknown(unknown);
  // Only names that are no group (a typo, a group from a later release):
  // the client's default, as if ?tools= were not there, rather than core.
  if (chosen?.named) return { groups: chosen.groups, readOnly, unknown };
  const name = clientNames.find((value): value is string => Boolean(value));
  return { groups: defaultToolGroups(name), readOnly, unknown };
}

/**
 * The tools a tools/list caller gets, naming the client by the request
 * (`requestName`) or else by the OAuth app or agent its token was granted to.
 * The registration is read only when it can decide the list: the request
 * names no client and ?tools= names no group (absent, or only unknown names,
 * which fall back to the client's default).
 */
export async function listingToolSelection(
  url: URL,
  requestName: string | null,
  registrationName: () => Promise<string | null>
): Promise<ToolSelectionResult> {
  const chosen = parseToolGroups(url.searchParams.get("tools"));
  const needsRegistration = !requestName && !chosen?.named;
  return selectTools(url, chosen, [
    requestName,
    needsRegistration ? await registrationName() : null,
  ]);
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
    // The tools are @webhooks-cc/mcp's, so the server reports its version;
    // the web app's own version rides in the SDK's User-Agent below.
    { name: "webhooks-cc", title: "webhooks.cc", version: MCP_VERSION },
    {
      // The tool list never changes within a request: no listChanged, so a
      // subscriptions/listen stream completes at once instead of holding a slot.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: [INSTRUCTIONS, unknownGroupsNote(caller?.unknownGroups)]
        .filter(Boolean)
        .join(" "),
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
    fetch: callerFetch(caller?.clientIp ?? null, caller?.country ?? null),
    // Tells the remote server's calls apart from the stdio server's in analytics.
    userAgent: `webhooks-cc-mcp-remote/${APP_VERSION}`,
  });
  // The agent skill, for clients that read skills from their servers.
  attachSkill(server);
  // The request inspector (an MCP App) that get_request and get_email name.
  attachInspector(server);
  const note = unknownGroupsNote(caller?.unknownGroups);
  registerTools(toolServer(server, caller?.userId ?? "anonymous", note), client, {
    remote: true,
    groups: caller?.groups ?? new Set<ToolGroup>(["core"]),
    readOnly: caller?.readOnly ?? false,
    // The inspector's links into the dashboard, on the site that lists the endpoint.
    dashboard: { webhooks: webhooksOrigin(), mailhooks: mailhooksOrigin() },
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
            country: (authInfo.extra?.country as string | undefined) ?? null,
            userId: (authInfo.extra?.userId as string | undefined) ?? authInfo.token,
            groups: (authInfo.extra?.groups as Set<ToolGroup> | undefined) ?? new Set(["core"]),
            readOnly: authInfo.extra?.readOnly === true,
            unknownGroups: (authInfo.extra?.unknownGroups as string[] | undefined) ?? [],
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
