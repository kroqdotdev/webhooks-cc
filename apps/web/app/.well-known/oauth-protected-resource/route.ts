import { buildProtectedResourceMetadata } from "@/lib/agent/metadata";

/**
 * RFC 9728 OAuth Protected Resource Metadata: names the API, its scopes,
 * and this app as its authorization server (auth.md Step 1a). Static
 * (derived from NEXT_PUBLIC_APP_URL), so it is safe to cache at the edge.
 */
export async function GET() {
  return Response.json(buildProtectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
