import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { verifyLogoutToken } from "@/lib/agent/id-jag";
import { revokeForIssuerSubject } from "@/lib/agent/agent-auth";
import { sendError } from "@appsignal/nodejs";

/**
 * POST /api/agent/auth/revoke — provider-driven revocation (auth.md logout+jwt).
 *
 * Only the identity provider calls this endpoint; agents never do. The provider
 * delivers a `logout+jwt` either as the raw JWT (Content-Type
 * application/logout+jwt, per the OIDC back-channel logout convention) or
 * wrapped in JSON ({ "logout_token": "<jwt>" }). The token is verified through
 * the same issuer-JWKS trust path as ID-JAG (typ:'logout+jwt', signature, jti
 * replay with purpose 'logout'); on success all credentials issued for that
 * (iss, sub) identity are invalidated.
 *
 * Returns 200 on success, 400 on any verification failure (per spec), 500 on
 * an unexpected server error.
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, 30);
  if (rateLimited) return rateLimited;

  // Body size cap (matches parseJsonBody's cap on the JSON branch).
  const MAX_BODY_SIZE = 16 * 1024;

  try {
    // The token may arrive as the raw JWT (application/logout+jwt) or wrapped
    // in JSON. Read it from whichever the provider used.
    const contentType = request.headers.get("Content-Type") ?? "";
    let jwt: string | null = null;

    if (contentType.includes("application/logout+jwt")) {
      // The body IS the JWT. Enforce the same size cap as the JSON branch
      // (parseJsonBody only guards the JSON path). Check Content-Length first
      // (fast path), then the actual byte size to defend against a missing or
      // spoofed Content-Length.
      const contentLength = request.headers.get("Content-Length");
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!isNaN(size) && size > MAX_BODY_SIZE) {
          return Response.json(
            { error: `Request body too large (max ${MAX_BODY_SIZE} bytes)` },
            { status: 413 }
          );
        }
      }
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_SIZE) {
        return Response.json(
          { error: `Request body too large (max ${MAX_BODY_SIZE} bytes)` },
          { status: 413 }
        );
      }
      jwt = new TextDecoder().decode(buffer).trim();
    } else {
      const parsed = await parseJsonBody(request, MAX_BODY_SIZE);
      if ("error" in parsed) return parsed.error;
      const body = parsed.data as Record<string, unknown>;
      if (typeof body.logout_token === "string") {
        jwt = body.logout_token.trim();
      }
    }

    if (!jwt) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const result = await verifyLogoutToken(jwt);
    if (!result.ok) {
      // 400 on verification failure per the logout+jwt spec.
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    await revokeForIssuerSubject(result.iss, result.sub);

    return new Response(null, { status: 200 });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
