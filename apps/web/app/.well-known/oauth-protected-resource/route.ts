import { buildProtectedResourceMetadata } from "@/lib/agent/metadata";

/**
 * RFC 9728 — OAuth Protected Resource Metadata.
 * Advertises this app as the authorization server for the auth.md agent
 * registration protocol. The document is fully static (derived from
 * NEXT_PUBLIC_APP_URL) so it is safe to cache at the edge.
 */
export async function GET() {
  return Response.json(buildProtectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
