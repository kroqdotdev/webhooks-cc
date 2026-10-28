/**
 * CORS for the endpoints browser-based MCP clients call directly: the MCP
 * server, the token, registration and revocation endpoints and the
 * discovery documents. Any origin, because they authenticate with a bearer
 * token or a PKCE verifier in the request, never with cookies.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

/** The response with the CORS headers added. */
export function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

/** The answer to a preflight request. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
