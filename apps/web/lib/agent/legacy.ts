import { publicEnv } from "@/lib/env";
import { VERIFIED_EMAIL_DEPRECATED_AT, VERIFIED_EMAIL_SUNSET_AT } from "./constants";

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

/**
 * Headers on the deprecated verified_email flow: Deprecation (RFC 9745, a
 * structured date) and Sunset (RFC 8594, an HTTP date). The
 * `Link: rel="deprecation"` pointing at /auth.md comes from next.config.ts,
 * because the config's Link header replaces one set here.
 */
export function deprecationHeaders(): Record<string, string> {
  return {
    Deprecation: `@${Math.floor(Date.parse(VERIFIED_EMAIL_DEPRECATED_AT) / 1000)}`,
    Sunset: new Date(VERIFIED_EMAIL_SUNSET_AT).toUTCString(),
  };
}

/** Adds the deprecation headers to a verified_email response. */
export function deprecated(response: Response): Response {
  for (const [key, value] of Object.entries(deprecationHeaders())) {
    response.headers.set(key, value);
  }
  return response;
}
