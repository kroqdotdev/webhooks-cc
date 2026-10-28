import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { registerTools, type ToolServer } from "@webhooks-cc/mcp/tools";
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

/** registerTools' view of the v2 server. */
function toolServer(server: McpServer): ToolServer {
  return {
    tool(name, description, shape, handler) {
      return server.registerTool(
        name,
        { description, inputSchema: z.object(shape) },
        (args: unknown) => handler(args as Parameters<typeof handler>[0])
      );
    },
  };
}

export interface CallerAuth {
  token: string;
  clientIp: string | null;
}

function buildServer(caller: CallerAuth | undefined): McpServer {
  const server = new McpServer(
    { name: "webhooks-cc", title: "webhooks.cc", version: APP_VERSION },
    {
      instructions: INSTRUCTIONS,
      // Every caller sees the same tools; the list changes only with a deploy.
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "public" } },
    }
  );
  // A request that reached the handler was authenticated by the route.
  const client = new WebhooksCC({
    apiKey: caller?.token ?? "whcc_unauthenticated",
    baseUrl: internalApiUrl(),
    webhookUrl: publicEnv().NEXT_PUBLIC_WEBHOOK_URL,
    fetch: callerFetch(caller?.clientIp ?? null),
  });
  registerTools(toolServer(server), client, { remote: true });
  return server;
}

export const mcpHandler = createMcpHandler(
  ({ authInfo }) =>
    buildServer(
      authInfo
        ? {
            token: authInfo.token,
            clientIp: (authInfo.extra?.clientIp as string | undefined) ?? null,
          }
        : undefined
    ),
  {
    // Tool results only, no streaming: one JSON body per request.
    responseMode: "json",
    maxRequestBodySize: 1024 * 1024,
    // Mostly a client's malformed or unsupported request, not our fault: a
    // log line, never the request itself.
    // The error's name only: a JSON parse error's message quotes the body.
    onerror: (error) => console.warn(`[mcp] request refused (${error.name})`),
  }
);
