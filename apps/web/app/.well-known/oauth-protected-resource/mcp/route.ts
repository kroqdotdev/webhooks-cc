import { buildMcpProtectedResourceMetadata, mcpSettingsQuery } from "@/lib/agent/metadata";
import { preflight, withCors } from "@/lib/oauth/cors";

/**
 * RFC 9728 Protected Resource Metadata of the remote MCP server
 * (`/mcp`): its resource identifier, scopes and authorization server. The
 * server's 401s name this document in `WWW-Authenticate`, with the settings
 * of the address that was called (`?tools=all`), which `resource` repeats.
 */
export async function GET(request: Request) {
  return withCors(
    Response.json(buildMcpProtectedResourceMetadata(mcpSettingsQuery(new URL(request.url))), {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  );
}

export function OPTIONS() {
  return preflight();
}
