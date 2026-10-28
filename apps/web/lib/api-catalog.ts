import { publicEnv } from "@/lib/env";

/**
 * The RFC 9727 API catalog served at /.well-known/api-catalog: an RFC 9264
 * linkset naming the REST API and the remote MCP server, with links to what
 * describes them. Pure builder; URLs come from NEXT_PUBLIC_APP_URL.
 *
 * Relation types, in order of preference: RFC 9727 (`api-catalog`, and
 * `item` from RFC 6573 for the catalog's members), RFC 8631 (`service-desc`
 * for the OpenAPI file, `service-doc` for documentation people read,
 * `service-meta` for machine-readable metadata such as RFC 9728 protected
 * resource metadata), and `describedby` (IANA registry, POWDER) for llms.txt.
 * Two are not registered: `auth.md`, the relation the auth.md protocol's
 * documents already use in our HTML <link> and Link header (agents look for
 * that name), and `agent-skills`, the name the agent-skills-discovery RFC
 * uses for its index. RFC 8288 would have unregistered relations be URIs;
 * these keep the bare names agents match on.
 */

export const API_CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727";

/** Content type with the profile parameter RFC 9727 section 4.2 asks for. */
export const API_CATALOG_CONTENT_TYPE = `application/linkset+json; profile="${API_CATALOG_PROFILE}"`;

export interface LinkTarget {
  href: string;
  type?: string;
  title?: string;
}

/** One link context object (RFC 9264 section 4.2.2). */
export type LinkContext = { anchor: string } & { [relation: string]: string | LinkTarget[] };

export interface ApiCatalog {
  linkset: LinkContext[];
}

export function apiCatalogUrl(appUrl = publicEnv().NEXT_PUBLIC_APP_URL): string {
  return `${appUrl}/.well-known/api-catalog`;
}

export function buildApiCatalog(appUrl = publicEnv().NEXT_PUBLIC_APP_URL): ApiCatalog {
  // Same identifiers as the protected resource metadata documents
  // (lib/agent/metadata.ts for the API, the MCP route for /mcp).
  const api = `${appUrl}/api/`;
  const mcp = `${appUrl}/mcp`;
  const authMd: LinkTarget = {
    href: `${appUrl}/auth.md`,
    type: "text/markdown",
    title: "Agent registration and OAuth for agents (auth.md)",
  };

  return {
    linkset: [
      {
        anchor: apiCatalogUrl(appUrl),
        item: [
          { href: api, title: "webhooks.cc REST API" },
          { href: mcp, title: "webhooks.cc remote MCP server (streamable HTTP)" },
        ],
      },
      {
        anchor: api,
        "service-desc": [
          {
            href: `${appUrl}/openapi.yaml`,
            type: "application/yaml",
            title: "OpenAPI 3.1 description",
          },
        ],
        "service-doc": [
          { href: `${appUrl}/docs/api`, type: "text/html", title: "REST API documentation" },
          { href: `${appUrl}/api-explorer`, type: "text/html", title: "Interactive API reference" },
        ],
        "service-meta": [
          {
            href: `${appUrl}/.well-known/oauth-protected-resource`,
            type: "application/json",
            title: "OAuth protected resource metadata (RFC 9728)",
          },
        ],
        describedby: [
          {
            href: `${appUrl}/llms.txt`,
            type: "text/markdown",
            title: "Site overview for language models (llms.txt)",
          },
        ],
        "auth.md": [authMd],
        "agent-skills": [
          {
            href: `${appUrl}/.well-known/agent-skills/index.json`,
            type: "application/json",
            title: "Agent Skills discovery index",
          },
        ],
      },
      {
        anchor: mcp,
        "service-doc": [
          { href: `${appUrl}/docs/mcp`, type: "text/html", title: "MCP server documentation" },
        ],
        "service-meta": [
          {
            href: `${appUrl}/.well-known/oauth-protected-resource/mcp`,
            type: "application/json",
            title: "OAuth protected resource metadata (RFC 9728)",
          },
        ],
        "auth.md": [authMd],
      },
    ],
  };
}
