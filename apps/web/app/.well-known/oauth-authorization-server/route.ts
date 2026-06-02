import { buildAuthorizationServerMetadata } from "@/lib/agent/metadata";

/**
 * OAuth Authorization Server Metadata, including the auth.md `agent_auth`
 * extension block that advertises all three registration flows (anonymous,
 * verified_email, identity_assertion), the claim ceremony, the revocation
 * endpoint, and the credential.revoked event. Static (derived from
 * NEXT_PUBLIC_APP_URL) so it is safe to cache at the edge.
 */
export async function GET() {
  return Response.json(buildAuthorizationServerMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
