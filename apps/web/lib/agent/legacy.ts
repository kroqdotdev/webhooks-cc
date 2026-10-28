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
    {
      error: "endpoint_moved",
      error_description: description,
      auth_md: authMd,
      upgrade: UPGRADE_NOTICE,
    },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * What the agent reading a v0.1 answer should tell its human: old MCP
 * servers (before 1.11.0) and SDKs (before 1.13.0) are the only clients of
 * these routes, and a current one needs no key and keeps its connection.
 */
export const UPGRADE_NOTICE = `This is the retired auth.md v0.1 flow (the email flow stops on ${VERIFIED_EMAIL_SUNSET_AT.slice(0, 10)}). Update: npx -y @webhooks-cc/mcp@latest (no key needed, and the connection is saved), or npm i @webhooks-cc/sdk@latest and use WebhooksCC.sandbox() or WebhooksCC.connect().`;

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

/**
 * Adds the deprecation headers to a verified_email response, and the
 * upgrade notice to its JSON body, where an agent sees it.
 */
export async function deprecated(response: Response): Promise<Response> {
  let next = response;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      next = new Response(JSON.stringify({ ...body, notice: UPGRADE_NOTICE }), {
        status: response.status,
        headers,
      });
    }
  }
  for (const [key, value] of Object.entries(deprecationHeaders())) {
    next.headers.set(key, value);
  }
  return next;
}
