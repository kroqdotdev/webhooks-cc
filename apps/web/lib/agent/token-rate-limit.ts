import { createHash } from "node:crypto";
import { checkRateLimitWithInfo, type RateLimitInfo } from "@/lib/rate-limit";
import { AUTHORIZATION_CODE_GRANT, JWT_BEARER_GRANT, REFRESH_TOKEN_GRANT } from "./constants";
import { orgIssuerCandidate } from "./org-id-jag";

/**
 * Which budget a token request is counted against before anything is
 * verified (POST /api/oauth2/token):
 * - authorization_code and refresh_token: 600 a minute per address, since
 *   hosted MCP clients refresh for many users from few addresses;
 * - an assertion naming an issuer under a configured organisation prefix:
 *   1,200 a minute per address and 600 a minute per (issuer, address),
 *   since an organisation's members share its platform's few addresses;
 * - everything else: 60 a minute per address.
 *
 * Nothing here is shared between addresses: an unverified assertion names
 * whatever issuer it likes, so a budget it could spend for everyone would
 * let one address lock an organisation out. The issuer's shared budget
 * (ORG_ISSUER_LIMIT) and the per-identity one are charged by
 * lib/agent/org-id-jag-grant.ts once the signature holds.
 */

export const OAUTH_TOKEN_LIMIT = 600;
/** Unverified organisation assertions from one address, any issuer. */
export const ORG_ADDRESS_LIMIT = 1200;
/** Unverified organisation assertions from one address for one issuer. */
export const ORG_ISSUER_ADDRESS_LIMIT = 600;
/** Verified assertions from one issuer, all addresses together. */
export const ORG_ISSUER_LIMIT = 600;
export const AGENT_TOKEN_LIMIT = 60;

function issuerHash(iss: string): string {
  return createHash("sha256").update(iss).digest("hex").slice(0, 32);
}

/** The issuer's shared bucket, charged only after the signature holds. */
export function issuerRateKey(iss: string): string {
  return `agent-token-org-issuer:${issuerHash(iss)}`;
}

/** The per-address scope for one issuer, before the signature is checked. */
export function issuerAddressScope(iss: string): string {
  return `agent-token-org:${issuerHash(iss)}`;
}

export async function tokenRateLimit(
  request: Request,
  body: Record<string, unknown>
): Promise<RateLimitInfo> {
  if (body.grant_type === AUTHORIZATION_CODE_GRANT || body.grant_type === REFRESH_TOKEN_GRANT) {
    return checkRateLimitWithInfo(request, "oauth-token", OAUTH_TOKEN_LIMIT, 60_000);
  }
  if (body.grant_type === JWT_BEARER_GRANT && typeof body.assertion === "string") {
    const iss = orgIssuerCandidate(body.assertion);
    if (iss) {
      const address = await checkRateLimitWithInfo(
        request,
        "agent-token-org",
        ORG_ADDRESS_LIMIT,
        60_000
      );
      if (address.response) return address;
      return checkRateLimitWithInfo(
        request,
        issuerAddressScope(iss),
        ORG_ISSUER_ADDRESS_LIMIT,
        60_000
      );
    }
  }
  return checkRateLimitWithInfo(request, "agent-token", AGENT_TOKEN_LIMIT, 60_000);
}
