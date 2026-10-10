import { publicEnv } from "@/lib/env";

/**
 * Answer for the auth.md v0.1 routes that v0.6 replaced (410). Old clients
 * get nothing usable from them: an unclaimed v0.1 key never reached the
 * sandbox. The body points at /auth.md, and so does the `Link: rel="auth.md"`
 * header next.config.ts puts on every response.
 */
export function endpointMoved(description: string): Response {
  const authMd = `${publicEnv().NEXT_PUBLIC_APP_URL}/auth.md`;
  return Response.json(
    { error: "endpoint_moved", error_description: description, auth_md: authMd },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
