import { API_CATALOG_CONTENT_TYPE, apiCatalogUrl, buildApiCatalog } from "@/lib/api-catalog";

function catalogHeaders(): HeadersInit {
  return {
    "Content-Type": API_CATALOG_CONTENT_TYPE,
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    // RFC 9727 section 2: a HEAD request is answered with the api-catalog
    // relation. next.config.ts sends the same relation on every response,
    // and its Link header takes precedence over a route's; this one covers
    // the handler on its own.
    Link: `<${apiCatalogUrl()}>; rel="api-catalog"`,
  };
}

/** RFC 9727 API catalog: the REST API and the remote MCP server. */
export async function GET() {
  return new Response(JSON.stringify(buildApiCatalog(), null, 2), { headers: catalogHeaders() });
}

export async function HEAD() {
  return new Response(null, { headers: catalogHeaders() });
}
