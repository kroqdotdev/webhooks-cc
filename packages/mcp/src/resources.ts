import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request, WebhooksCC } from "@webhooks-cc/sdk";

const ENDPOINTS_RESOURCE_URI = "webhooks://endpoints";
const ENDPOINT_RECENT_TEMPLATE_URI = "webhooks://endpoint/{slug}/recent";
const REQUEST_TEMPLATE_URI = "webhooks://request/{id}";
const MAX_ENDPOINT_RESOURCE_ITEMS = 25;
const RECENT_REQUEST_LIMIT = 10;

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function summarizeRequest(request: Request) {
  return {
    id: request.id,
    method: request.method,
    path: request.path,
    receivedAt: request.receivedAt,
    contentType: request.contentType ?? null,
  };
}

function variableToString(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing resource variable "${name}"`);
}

async function listEndpointSummaries(client: WebhooksCC) {
  const endpoints = (await client.endpoints.list())
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt);
  const truncated = endpoints.length > MAX_ENDPOINT_RESOURCE_ITEMS;
  const visible = endpoints.slice(0, MAX_ENDPOINT_RESOURCE_ITEMS);

  const summaries = await Promise.all(
    visible.map(async (endpoint) => {
      const recent = await client.requests.list(endpoint.slug, { limit: 1 });
      return {
        ...endpoint,
        lastRequest: recent[0] ? summarizeRequest(recent[0]) : null,
      };
    })
  );

  return {
    endpoints: summaries,
    total: endpoints.length,
    truncated,
  };
}

export function registerResources(server: McpServer, client: WebhooksCC): void {
  server.registerResource(
    "endpoints-overview",
    ENDPOINTS_RESOURCE_URI,
    {
      title: "Endpoints Overview",
      description: "All endpoints with a summary of recent activity.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource(ENDPOINTS_RESOURCE_URI, await listEndpointSummaries(client));
    }
  );

  server.registerResource(
    "endpoint-recent-requests",
    new ResourceTemplate(ENDPOINT_RECENT_TEMPLATE_URI, {
      list: async () => {
        const endpoints = await client.endpoints.list();
        return {
          resources: endpoints.map((endpoint) => ({
            uri: `webhooks://endpoint/${endpoint.slug}/recent`,
            name: `${endpoint.slug} recent requests`,
            description: `Recent requests for endpoint ${endpoint.slug}`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        slug: async (value) => {
          const endpoints = await client.endpoints.list();
          return endpoints
            .map((endpoint) => endpoint.slug)
            .filter((slug) => slug.startsWith(value))
            .slice(0, 20);
        },
      },
    }),
    {
      title: "Endpoint Recent Requests",
      description: "Last 10 captured requests for an endpoint.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const slug = variableToString(variables.slug, "slug");
      const [endpoint, requests] = await Promise.all([
        client.endpoints.get(slug),
        client.requests.list(slug, { limit: RECENT_REQUEST_LIMIT }),
      ]);

      return jsonResource(uri.toString(), {
        endpoint,
        requests,
      });
    }
  );

  server.registerResource(
    "request-details",
    new ResourceTemplate(REQUEST_TEMPLATE_URI, {
      list: undefined,
      complete: {},
    }),
    {
      title: "Request Details",
      description: "Full details for a captured request by ID.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = variableToString(variables.id, "id");
      const request = await client.requests.get(id);
      return jsonResource(uri.toString(), request);
    }
  );
}
