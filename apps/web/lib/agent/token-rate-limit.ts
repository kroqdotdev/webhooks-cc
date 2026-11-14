import {
  checkRateLimitByKeyWithInfo,
  checkRateLimitWithInfo,
  type RateLimitInfo,
} from "@/lib/rate-limit";
import { reportError } from "@/lib/observability";
import { AUTHORIZATION_CODE_GRANT, JWT_BEARER_GRANT, REFRESH_TOKEN_GRANT } from "./constants";
import { trustedOrgIssuerOf } from "./org-id-jag";

/**
 * Which budget a token request is counted against (POST /api/oauth2/token):
 * - authorization_code and refresh_token: 600 a minute per address, since
 *   hosted MCP clients refresh for many users from few addresses;
 * - an ID-JAG from an issuer some team trusts: 600 a minute per issuer,
 *   checked before the signature, since an organisation's members share its
 *   platform's addresses (lib/agent/org-id-jag-grant.ts then counts each
 *   verified identity, 30 a minute);
 * - everything else: 60 a minute per address.
 */

export const OAUTH_TOKEN_LIMIT = 600;
export const ORG_ISSUER_LIMIT = 600;
export const AGENT_TOKEN_LIMIT = 60;

/** The issuer's bucket; issuer URLs are short and ours to compare. */
export function issuerRateKey(iss: string): string {
  return `agent-token-org-issuer:${iss}`;
}

export async function tokenRateLimit(
  request: Request,
  body: Record<string, unknown>
): Promise<RateLimitInfo> {
  if (body.grant_type === AUTHORIZATION_CODE_GRANT || body.grant_type === REFRESH_TOKEN_GRANT) {
    return checkRateLimitWithInfo(request, "oauth-token", OAUTH_TOKEN_LIMIT, 60_000);
  }
  if (body.grant_type === JWT_BEARER_GRANT && typeof body.assertion === "string") {
    let iss: string | null = null;
    try {
      iss = await trustedOrgIssuerOf(body.assertion);
    } catch (error) {
      // The trust lookup failed: count it per address, as any other grant.
      reportError("[agent] trusted issuer lookup for the token rate limit failed", error);
    }
    if (iss) return checkRateLimitByKeyWithInfo(issuerRateKey(iss), ORG_ISSUER_LIMIT, 60_000);
  }
  return checkRateLimitWithInfo(request, "agent-token", AGENT_TOKEN_LIMIT, 60_000);
}
