import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebhooksCC } from "@webhooks-cc/sdk";

/** Register all 11 webhook tools on an MCP server instance. */
export function registerTools(server: McpServer, client: WebhooksCC): void {
  server.tool(
    "create_endpoint",
    "Create a new webhook endpoint. Returns the endpoint URL and slug.",
    { name: z.string().optional().describe("Display name for the endpoint") },
    async ({ name }) => {
      const endpoint = await client.endpoints.create({ name });
      return { content: [{ type: "text" as const, text: JSON.stringify(endpoint, null, 2) }] };
    }
  );

  server.tool(
    "list_endpoints",
    "List all webhook endpoints for the authenticated user.",
    {},
    async () => {
      const endpoints = await client.endpoints.list();
      return { content: [{ type: "text" as const, text: JSON.stringify(endpoints, null, 2) }] };
    }
  );

  server.tool(
    "get_endpoint",
    "Get details for a specific webhook endpoint by its slug.",
    { slug: z.string().describe("The endpoint slug (from the URL)") },
    async ({ slug }) => {
      const endpoint = await client.endpoints.get(slug);
      return { content: [{ type: "text" as const, text: JSON.stringify(endpoint, null, 2) }] };
    }
  );

  server.tool(
    "update_endpoint",
    "Update an endpoint's name or mock response configuration.",
    {
      slug: z.string().describe("The endpoint slug to update"),
      name: z.string().optional().describe("New display name"),
      mockResponse: z
        .object({
          status: z.number().describe("HTTP status code (100-599)"),
          body: z.string().describe("Response body string"),
          headers: z.record(z.string()).describe("Response headers"),
        })
        .nullable()
        .optional()
        .describe("Mock response config, or null to clear it"),
    },
    async ({ slug, name, mockResponse }) => {
      const endpoint = await client.endpoints.update(slug, { name, mockResponse });
      return { content: [{ type: "text" as const, text: JSON.stringify(endpoint, null, 2) }] };
    }
  );

  server.tool(
    "delete_endpoint",
    "Delete a webhook endpoint and all its captured requests.",
    { slug: z.string().describe("The endpoint slug to delete") },
    async ({ slug }) => {
      await client.endpoints.delete(slug);
      return { content: [{ type: "text" as const, text: `Endpoint "${slug}" deleted.` }] };
    }
  );

  server.tool(
    "send_webhook",
    "Send a test webhook to an endpoint. Useful for testing webhook handling code.",
    {
      slug: z.string().describe("The endpoint slug to send to"),
      method: z.string().default("POST").describe("HTTP method (default: POST)"),
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body (will be JSON-serialized)"),
    },
    async ({ slug, method, headers, body }) => {
      const response = await client.endpoints.send(slug, { method, headers, body });
      const responseBody = await response.text();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { status: response.status, statusText: response.statusText, body: responseBody },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "list_requests",
    "List captured webhook requests for an endpoint. Returns the most recent requests.",
    {
      endpointSlug: z.string().describe("The endpoint slug"),
      limit: z.number().optional().describe("Max number of requests to return"),
      since: z.number().optional().describe("Only return requests after this timestamp (ms)"),
    },
    async ({ endpointSlug, limit, since }) => {
      const requests = await client.requests.list(endpointSlug, { limit, since });
      return { content: [{ type: "text" as const, text: JSON.stringify(requests, null, 2) }] };
    }
  );

  server.tool(
    "get_request",
    "Get full details of a specific captured webhook request by its ID.",
    { requestId: z.string().describe("The request ID") },
    async ({ requestId }) => {
      const request = await client.requests.get(requestId);
      return { content: [{ type: "text" as const, text: JSON.stringify(request, null, 2) }] };
    }
  );

  server.tool(
    "wait_for_request",
    "Wait for a webhook request to arrive at an endpoint. Polls until a request is captured or timeout expires. Use this after sending a webhook to verify it was received.",
    {
      endpointSlug: z.string().describe("The endpoint slug to monitor"),
      timeout: z
        .string()
        .default("30s")
        .describe('How long to wait (e.g. "30s", "5m", or milliseconds as string)'),
    },
    async ({ endpointSlug, timeout }) => {
      const request = await client.requests.waitFor(endpointSlug, { timeout });
      return { content: [{ type: "text" as const, text: JSON.stringify(request, null, 2) }] };
    }
  );

  server.tool(
    "replay_request",
    "Replay a previously captured webhook request to a target URL. Sends the original method, headers, and body to the specified URL.",
    {
      requestId: z.string().describe("The ID of the captured request to replay"),
      targetUrl: z.string().url().describe("The URL to send the replayed request to"),
    },
    async ({ requestId, targetUrl }) => {
      const response = await client.requests.replay(requestId, targetUrl);
      const responseBody = await response.text();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { status: response.status, statusText: response.statusText, body: responseBody },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "describe",
    "Describe all available SDK operations, their parameters, and types. Useful for discovering what actions are possible.",
    {},
    async () => {
      const description = client.describe();
      return { content: [{ type: "text" as const, text: JSON.stringify(description, null, 2) }] };
    }
  );
}
