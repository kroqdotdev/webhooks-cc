import { buildAuthorizationServerMetadata } from "@/lib/agent/metadata";
import { hasTrustedProviders } from "@/lib/agent/trusted-providers";

// Whether an ID-JAG issuer is trusted is runtime configuration.
export const dynamic = "force-dynamic";

/**
 * RFC 8414 Authorization Server Metadata with the auth.md `agent_auth` block:
 * the registration, token and revocation endpoints, the proof-of-work
 * challenge and the sandbox limits.
 */
export async function GET() {
  return Response.json(buildAuthorizationServerMetadata({ idJagEnabled: hasTrustedProviders() }), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
