/**
 * @fileoverview Sandbox surface for UNCLAIMED agent keys (WorkOS auth.md).
 *
 * Fulfills auth.md's "works immediately" promise: an anonymous agent credential
 * minted by POST /api/agent/auth is useful BEFORE it is claimed, without ever
 * granting access to a real user's account. Every user-scoped route 403s an
 * unclaimed key (see authenticateRequestRequireUser); this narrow surface is the
 * ONE exception, and it is deliberately minimal.
 *
 * Capability (bounded):
 *   - POST  — create an EPHEMERAL endpoint (bounded expiry, capacity-capped).
 *   - GET   — list THIS key's sandbox endpoints, or (?slug=) read ONLY the
 *             requests captured by one of them.
 *
 * SECURITY — cross-tenant isolation is mandatory and is the reason this file
 * exists as a dedicated surface rather than reusing the user routes:
 *
 *   Unclaimed agent keys ALL share user_id = NULL, so user_id cannot scope them
 *   — scoping by it would pool every anonymous agent's data together. Instead we
 *   scope by the SPECIFIC api_keys row id (a server-only UUID the agent never
 *   sees). Each sandbox endpoint is tagged `name = "sandbox:<keyId>"`; reads
 *   filter by that exact marker AND is_ephemeral = true. An agent therefore can
 *   only ever see endpoints/requests created under its own key — never another
 *   agent's and never a real user's (real users never own is_ephemeral rows with
 *   this marker, and the marker is set server-side, ignoring agent input).
 *
 *   Only an UNCLAIMED agent key (is_agent_issued && user_id IS NULL) is admitted
 *   here. Claimed keys, normal API keys, and session tokens are rejected — they
 *   have the full /api/endpoints surface and must not double-dip the sandbox.
 *   Once a key is claimed, its sandbox endpoints (still tagged by the old key id)
 *   are simply orphaned ephemerals and expire on their own; the now-owned key
 *   uses the regular routes.
 */
import { authenticateRequest, extractBearerToken } from "@/lib/api-auth";
import { parseJsonBody } from "@/lib/request-validation";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/supabase/api-keys";
import { serverEnv } from "@/lib/env";

/** Max sandbox endpoints a single unclaimed key may hold concurrently. */
const MAX_SANDBOX_ENDPOINTS_PER_KEY = 5;
/** Per-key sandbox-create rate limit window. */
const SANDBOX_CREATE_RATE_LIMIT = 20;
const SANDBOX_CREATE_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Marker stored in endpoints.name to bind a sandbox endpoint to its owning key. */
function sandboxMarker(keyId: string): string {
  return `sandbox:${keyId}`;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * Authenticate the bearer and require an UNCLAIMED agent key. Returns the
 * owning api_keys row id (the per-key tenant identifier) on success, or a
 * Response to return on failure.
 *
 * The id is re-derived here by hashing the raw bearer and looking it up — the
 * shared validation layer only exposes userId/plan/isAgentIssued, not the row
 * id, and we need the id to scope every read/write to exactly this key.
 */
async function authenticateSandboxKey(
  request: Request
): Promise<{ ok: true; keyId: string } | { ok: false; response: Response }> {
  const auth = await authenticateRequest(request);
  if (!auth.success) {
    // Reuses the RFC 9728 WWW-Authenticate challenge from the auth boundary.
    return { ok: false, response: auth.response };
  }

  // The sandbox is exclusively for UNCLAIMED agent credentials: an agent-issued
  // key not yet bound to a user. A claimed key (userId != null) or a non-agent
  // key has the full /api/endpoints surface and must use that instead.
  if (!auth.isAgentIssued || auth.userId !== null) {
    return {
      ok: false,
      response: jsonError(
        "The sandbox is only available to unclaimed agent credentials. Use /api/endpoints with a claimed key.",
        403
      ),
    };
  }

  // Re-derive the specific api_keys row id from the bearer. extractBearerToken
  // is guaranteed to return a value here (authenticateRequest already required
  // one), and the token must be a whcc_ key to have authenticated as an agent.
  const token = extractBearerToken(request);
  if (!token) {
    return { ok: false, response: jsonError("Missing authorization header", 401) };
  }

  const admin = createAdminClient();
  const { data: keyRow, error } = await admin
    .from("api_keys")
    .select("id, user_id, is_agent_issued")
    .eq("key_hash", hashApiKey(token))
    .maybeSingle();

  if (error) throw error;

  // Defense in depth: re-confirm the row is still an unclaimed agent key. This
  // closes a TOCTOU window where the key was claimed between validation and the
  // lookup — a claimed key must never reach the sandbox write/read path.
  if (!keyRow || keyRow.user_id !== null || keyRow.is_agent_issued !== true) {
    return {
      ok: false,
      response: jsonError(
        "The sandbox is only available to unclaimed agent credentials. Use /api/endpoints with a claimed key.",
        403
      ),
    };
  }

  return { ok: true, keyId: keyRow.id };
}

/**
 * Fetch the sandbox endpoints owned by a specific key. Strictly scoped: the
 * exact name marker plus is_ephemeral = true. The lib helpers key on user_id
 * (null for every unclaimed key — useless for isolation), so we query directly.
 */
async function listSandboxEndpointIds(
  keyId: string
): Promise<{ id: string; slug: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, slug")
    .eq("name", sandboxMarker(keyId))
    .eq("is_ephemeral", true)
    .is("user_id", null)
    .order("created_at", { ascending: false })
    .returns<{ id: string; slug: string }[]>();

  if (error) throw error;
  return data ?? [];
}

/**
 * GET /api/agent/sandbox/endpoints
 *   - no query     -> list this key's sandbox endpoints
 *   - ?slug=<slug> -> read ONLY the requests captured by that sandbox endpoint
 *
 * Reads are confined to endpoints carrying this key's marker; a slug owned by
 * another key (or any user) resolves to nothing and yields 404, so an agent can
 * never read another tenant's captured requests by guessing slugs.
 */
export async function GET(request: Request) {
  const authed = await authenticateSandboxKey(request);
  if (!authed.ok) return authed.response;

  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    const owned = await listSandboxEndpointIds(authed.keyId);

    if (slug) {
      const match = owned.find((e) => e.slug === slug.toLowerCase());
      if (!match) {
        // Unknown or not-ours: never disclose that a foreign slug exists.
        return jsonError("Sandbox endpoint not found", 404);
      }

      // The endpoint is unowned (user_id NULL), so user-scoped request helpers
      // cannot reach it. Read its captured requests directly, scoped to the
      // endpoint id we just confirmed belongs to this key.
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("requests")
        .select(
          "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, signature_verified, signature_error, signing_provider"
        )
        .eq("endpoint_id", match.id)
        .order("received_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      return Response.json({ slug: match.slug, requests: data ?? [] });
    }

    // List view: surface the public-facing endpoint shape (never the marker).
    const admin = createAdminClient();
    const ids = owned.map((e) => e.id);
    if (ids.length === 0) {
      return Response.json({ endpoints: [] });
    }
    const { data, error } = await admin
      .from("endpoints")
      .select("id, slug, is_ephemeral, expires_at, request_count, created_at")
      .in("id", ids)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const endpoints = (data ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      url: webhookUrl(row.slug),
      isEphemeral: row.is_ephemeral,
      expiresAt: row.expires_at ? Date.parse(row.expires_at) : undefined,
      requestCount: row.request_count,
      createdAt: Date.parse(row.created_at),
    }));

    return Response.json({ endpoints });
  } catch (error) {
    console.error("Failed to read sandbox endpoints:", error);
    return jsonError("Internal server error", 500);
  }
}

function webhookUrl(slug: string): string | undefined {
  const base = process.env.WEBHOOK_BASE_URL ?? process.env.NEXT_PUBLIC_WEBHOOK_URL;
  return base ? `${base}/w/${slug}` : undefined;
}

/**
 * POST /api/agent/sandbox/endpoints
 * Create a single EPHEMERAL endpoint owned by this unclaimed key. The capability
 * is intentionally minimal: no mock response, notification URL, or signing
 * config — the sandbox is for capturing webhooks, nothing that touches outbound
 * delivery or SSRF surfaces.
 */
export async function POST(request: Request) {
  const authed = await authenticateSandboxKey(request);
  if (!authed.ok) return authed.response;

  // Per-key rate limit (the key id is a stable, unforgeable identifier — better
  // than IP for an agent that may rotate IPs).
  const rateLimit = await checkRateLimitByKeyWithInfo(
    `sandbox-create:${authed.keyId}`,
    SANDBOX_CREATE_RATE_LIMIT,
    SANDBOX_CREATE_RATE_WINDOW_MS
  );
  if (rateLimit.response) {
    return rateLimit.response;
  }

  // Optional, validated name — body is allowed but its `name` is NOT used as the
  // stored name (that is reserved for the key marker); we ignore it to keep the
  // marker authoritative. Parsing still rejects oversized/garbage bodies.
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;

  try {
    // Per-key cap on concurrent sandbox endpoints.
    const owned = await listSandboxEndpointIds(authed.keyId);
    if (owned.length >= MAX_SANDBOX_ENDPOINTS_PER_KEY) {
      return applyRateLimitHeaders(
        jsonError(
          `Sandbox endpoint limit reached (${MAX_SANDBOX_ENDPOINTS_PER_KEY}). Claim your agent key for unlimited endpoints, or wait for existing ones to expire.`,
          429
        ),
        rateLimit
      );
    }

    // Create an ephemeral, unowned endpoint. createEndpointForUser enforces the
    // global MAX_EPHEMERAL_ENDPOINTS cap and applies the bounded EPHEMERAL_TTL.
    // userId is left undefined -> user_id NULL; the name marker binds it to the
    // key for isolation on every subsequent read.
    const created = await createEndpointForUser({
      isEphemeral: true,
      name: sandboxMarker(authed.keyId),
    });

    // Best-effort guard for the inherent TOCTOU in the list-count-then-create cap
    // above: concurrent POSTs can each pass the pre-check and collectively exceed
    // MAX_SANDBOX_ENDPOINTS_PER_KEY. Re-count this key's sandbox endpoints (same
    // marker filter); if we are now over the cap, roll back the row we just
    // created and return the same 429. This is not perfectly race-free, but the
    // global MAX_EPHEMERAL_ENDPOINTS cap (enforced in createEndpointForUser)
    // remains the hard backstop.
    const afterCreate = await listSandboxEndpointIds(authed.keyId);
    if (afterCreate.length > MAX_SANDBOX_ENDPOINTS_PER_KEY) {
      const admin = createAdminClient();
      await admin.from("endpoints").delete().eq("id", created.id);
      return applyRateLimitHeaders(
        jsonError(
          `Sandbox endpoint limit reached (${MAX_SANDBOX_ENDPOINTS_PER_KEY}). Claim your agent key for unlimited endpoints, or wait for existing ones to expire.`,
          429
        ),
        rateLimit
      );
    }

    return applyRateLimitHeaders(
      Response.json(
        {
          id: created.id,
          slug: created.slug,
          url: created.url,
          isEphemeral: true,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
          // Surface the bounded sandbox contract so agents know to claim.
          sandbox: true,
          ttl_hours: serverEnv().EPHEMERAL_TTL_HOURS,
          claim_hint:
            "This endpoint is part of an unclaimed-agent sandbox. Claim your credential to retain endpoints and unlock full account access.",
        },
        { status: 201 }
      ),
      rateLimit
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Too many active demo endpoints")) {
      return applyRateLimitHeaders(
        jsonError("Sandbox capacity is full. Please try again later.", 429),
        rateLimit
      );
    }
    console.error("Failed to create sandbox endpoint:", error);
    return applyRateLimitHeaders(jsonError("Internal server error", 500), rateLimit);
  }
}
