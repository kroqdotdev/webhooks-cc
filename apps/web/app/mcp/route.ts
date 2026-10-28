import { extractBearerToken } from "@/lib/api-auth";
import { publicEnv } from "@/lib/env";
import { getClientIp, checkRateLimitByKeyWithInfo, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { POST_CLAIM_SCOPES } from "@/lib/agent/constants";
import { mcpHandler } from "@/lib/mcp/hosted";
import { preflight, withCors } from "@/lib/oauth/cors";
import { validateApiKeyWithMetadata } from "@/lib/supabase/api-keys";
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

/**
 * Requests one token may have running at once (one process serves /mcp).
 * A wait tool polls the API for up to 50 seconds; this keeps a single token
 * from stacking hundreds of them.
 */
const MAX_INFLIGHT_PER_TOKEN = 4;
const inflight = new Map<string, number>();

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

  const key = validation.keyId ?? token;
  const running = inflight.get(key) ?? 0;
  if (running >= MAX_INFLIGHT_PER_TOKEN) {
    return withCors(
      Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: `At most ${MAX_INFLIGHT_PER_TOKEN} requests at a time per token. Retry when one finishes.`,
          },
        },
        { status: 429, headers: { "Retry-After": "5" } }
      )
    );
  }
  inflight.set(key, running + 1);
  try {
    const response = await mcpHandler.fetch(request, {
      authInfo: {
        token,
        clientId: validation.agentRegistrationId ?? "api-key",
        scopes: POST_CLAIM_SCOPES,
        extra: { clientIp: getClientIp(request) },
      },
    });
    return withCors(response);
  } finally {
    const left = (inflight.get(key) ?? 1) - 1;
    if (left > 0) inflight.set(key, left);
    else inflight.delete(key);
  }
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
