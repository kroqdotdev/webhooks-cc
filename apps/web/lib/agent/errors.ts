/**
 * Error envelopes for the agent routes. /api/agent/* answers
 * `{ error, error_description }` with auth.md's profile codes; /api/oauth2/*
 * answers the RFC 6749 envelope with no-store headers. Both may carry extra
 * members (a fresh proof-of-work challenge, the claim endpoint).
 */

export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly description: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {}
  ) {
    super(code);
    this.name = "AgentError";
  }
}

export function agentErrorResponse(error: AgentError): Response {
  return Response.json(
    { error: error.code, error_description: error.description, ...error.extra },
    { status: error.status, headers: { "Cache-Control": "no-store", ...error.headers } }
  );
}

export function agentError(
  status: number,
  code: string,
  description: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Response {
  return agentErrorResponse(new AgentError(status, code, description, extra, headers));
}

/** Headers every token endpoint response carries (RFC 6749 5.1). */
export const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

export function oauthJson(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

export function oauthError(
  status: number,
  code: string,
  description: string,
  headers: Record<string, string> = {}
): Response {
  return Response.json(
    { error: code, error_description: description },
    { status, headers: { ...NO_STORE_HEADERS, ...headers } }
  );
}

/**
 * The shared rate limiter answers `{ error: "Too many requests" }`; agent
 * routes speak `rate_limited` and keep its Retry-After and X-RateLimit-*
 * headers.
 */
export function rateLimitedResponse(limited: Response): Response {
  const headers = new Headers(limited.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      error_description: "Too many requests. Wait and retry.",
    }),
    { status: 429, headers }
  );
}
