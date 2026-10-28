import { extractBearerToken } from "@/lib/api-auth";
import { publicEnv } from "@/lib/env";
import { getClientIp, checkRateLimitByKeyWithInfo, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { POST_CLAIM_SCOPES } from "@/lib/agent/constants";
import { mcpHandler } from "@/lib/mcp/hosted";
import { preflight, withCors } from "@/lib/oauth/cors";
import { validateApiKeyWithMetadata } from "@/lib/supabase/api-keys";
import { readBoundedBody } from "@/lib/agent/http";
import { reportError } from "@/lib/observability";

// Authenticated per request, never cached.
export const dynamic = "force-dynamic";

/**
 * The remote MCP server (streamable HTTP, stateless). Takes a whcc_ bearer:
 * an access token from the OAuth flow (the usual way, for claude.ai,
 * ChatGPT and other hosted clients), a claimed agent's token, or a
 * dashboard API key. Without one it answers 401 with the RFC 9728
 * challenge that starts the client's OAuth flow.
 */

function challenge(error?: { code: string; description: string }): string {
  const app = publicEnv().NEXT_PUBLIC_APP_URL;
  const parts = [
    `resource_metadata="${app}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${POST_CLAIM_SCOPES.join(" ")}"`,
  ];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

const MAX_BODY_BYTES = 1024 * 1024;

function rpcError(status: number, code: number, message: string): Response {
  return withCors(
    Response.json(
      { jsonrpc: "2.0", id: null, error: { code, message } },
      { status, headers: { "Cache-Control": "no-store" } }
    )
  );
}

function refuse(status: 401 | 403, error?: { code: string; description: string }): Response {
  return withCors(
    Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: error?.description ?? "Authorization required: connect webhooks.cc first.",
        },
      },
      { status, headers: { "WWW-Authenticate": challenge(error), "Cache-Control": "no-store" } }
    )
  );
}

async function handle(request: Request): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    const limit = await checkRateLimitWithInfo(request, "mcp-anonymous", 120, 60_000);
    if (limit.response) return withCors(limit.response);
    return refuse(401);
  }

  let validation;
  try {
    validation = token.startsWith("whcc_") ? await validateApiKeyWithMetadata(token) : null;
  } catch (error) {
    reportError("MCP token validation failed", error);
    return withCors(
      Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Try again shortly." } },
        { status: 503, headers: { "Retry-After": "5" } }
      )
    );
  }
  if (!validation) {
    return refuse(401, { code: "invalid_token", description: "The token is unknown or expired." });
  }
  if (validation.userId === null) {
    // An unclaimed agent's token only reaches the sandbox routes.
    return refuse(403, {
      code: "insufficient_scope",
      description:
        "A sandbox token cannot use the MCP server. Connect an account (see /auth.md, Step 4).",
    });
  }

  const limit = await checkRateLimitByKeyWithInfo(`mcp:${validation.keyId}`, 300, 60_000);
  if (limit.response) return withCors(limit.response);

  // One message per request: a JSON-RPC batch (2025-era clients may send
  // one) would start many tools from a single request.
  let parsedBody: unknown;
  if (request.method === "POST") {
    const raw = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!raw) return rpcError(413, -32600, "The request body is too large.");
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return rpcError(400, -32700, "The request body is not JSON.");
    }
    if (Array.isArray(parsedBody)) {
      return rpcError(400, -32600, "Batches are not supported; send one message per request.");
    }
  }

  const response = await mcpHandler.fetch(request, {
    parsedBody,
    authInfo: {
      token,
      clientId: validation.agentRegistrationId ?? "api-key",
      scopes: POST_CLAIM_SCOPES,
      extra: { clientIp: getClientIp(request), userId: validation.userId },
    },
  });
  return withCors(response);
}

export function POST(request: Request) {
  return handle(request);
}

export function GET(request: Request) {
  return handle(request);
}

export function DELETE(request: Request) {
  return handle(request);
}

export function OPTIONS() {
  return preflight();
}
