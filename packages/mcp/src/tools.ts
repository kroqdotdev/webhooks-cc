import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebhooksCC } from "@webhooks-cc/sdk";

const MAX_BODY_SIZE = 32_768;

/** Create a text content response for MCP tools. */
function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Read response body with size limit to avoid unbounded memory usage. */
async function readBodyTruncated(response: Response, limit = MAX_BODY_SIZE): Promise<string> {
  const text = await response.text();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated, ${text.length} chars total]`;
}

/** Wrap a tool handler with error handling that returns structured MCP errors. */
function withErrorHandling<T>(
  handler: (args: T) => Promise<{ content: { type: "text"; text: string }[] }>
): (args: T) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...textContent(`Error: ${message}`), isError: true };
    }
  };
}

/** Register all 11 webhook tools on an MCP server instance. */
export function registerTools(server: McpServer, client: WebhooksCC): void {
  server.tool(
    "create_endpoint",
    "Create a new webhook endpoint. Returns the endpoint URL and slug.",
    { name: z.string().optional().describe("Display name for the endpoint") },
    withErrorHandling(async ({ name }) => {
      const endpoint = await client.endpoints.create({ name });
      return textContent(JSON.stringify(endpoint, null, 2));
    })
  );

  server.tool(
    "list_endpoints",
    "List all webhook endpoints for the authenticated user. Returns an array of endpoints with their slugs, names, and URLs.",
    {},
    withErrorHandling(async () => {
      const endpoints = await client.endpoints.list();
      return textContent(JSON.stringify(endpoints, null, 2));
    })
  );

  server.tool(
    "get_endpoint",
    "Get details for a specific webhook endpoint by its slug.",
    { slug: z.string().describe("The endpoint slug (from the URL)") },
    withErrorHandling(async ({ slug }) => {
      const endpoint = await client.endpoints.get(slug);
      return textContent(JSON.stringify(endpoint, null, 2));
    })
  );

  server.tool(
    "update_endpoint",
    "Update an endpoint's name or mock response configuration.",
    {
      slug: z.string().describe("The endpoint slug to update"),
      name: z.string().optional().describe("New display name"),
      mockResponse: z
        .object({
          status: z.number().min(100).max(599).describe("HTTP status code (100-599)"),
          body: z.string().default("").describe("Response body string (default: empty)"),
          headers: z.record(z.string()).default({}).describe("Response headers (default: none)"),
        })
        .nullable()
        .optional()
        .describe("Mock response config, or null to clear it"),
    },
    withErrorHandling(async ({ slug, name, mockResponse }) => {
      const endpoint = await client.endpoints.update(slug, { name, mockResponse });
      return textContent(JSON.stringify(endpoint, null, 2));
    })
  );

  server.tool(
    "delete_endpoint",
    "Delete a webhook endpoint and all its captured requests.",
    { slug: z.string().describe("The endpoint slug to delete") },
    withErrorHandling(async ({ slug }) => {
      await client.endpoints.delete(slug);
      return textContent(`Endpoint "${slug}" deleted.`);
    })
  );

  server.tool(
    "send_webhook",
    "Send a test webhook to an endpoint. Useful for testing webhook handling code.",
    {
      slug: z.string().describe("The endpoint slug to send to"),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
        .default("POST")
        .describe("HTTP method (default: POST)"),
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body (will be JSON-serialized)"),
      provider: z
        .enum(["stripe", "github", "shopify", "twilio"])
        .optional()
        .describe("Optional provider template to send with signed headers"),
      template: z
        .string()
        .optional()
        .describe("Optional provider-specific template preset (for example: pull_request.opened)"),
      event: z
        .string()
        .optional()
        .describe("Optional provider event/topic name when provider template is used"),
      secret: z
        .string()
        .optional()
        .describe(
          "Shared secret for provider signature generation (required when provider is set)"
        ),
    },
    withErrorHandling(
      async ({ slug, method, headers, body, provider, template, event, secret }) => {
        let response: Response;
        if (provider) {
          const templateSecret = secret?.trim();
          if (!templateSecret) {
            throw new Error("send_webhook with provider templates requires a non-empty secret");
          }
          response = await client.endpoints.sendTemplate(slug, {
            provider,
            template,
            event,
            secret: templateSecret,
            method,
            headers,
            body,
          });
        } else {
          response = await client.endpoints.send(slug, { method, headers, body });
        }
        const responseBody = await readBodyTruncated(response);
        return textContent(
          JSON.stringify(
            { status: response.status, statusText: response.statusText, body: responseBody },
            null,
            2
          )
        );
      }
    )
  );

  server.tool(
    "list_requests",
    "List captured webhook requests for an endpoint. Returns the most recent requests (default: 25).",
    {
      endpointSlug: z.string().describe("The endpoint slug"),
      limit: z.number().default(25).describe("Max number of requests to return (default: 25)"),
      since: z.number().optional().describe("Only return requests after this timestamp (ms)"),
    },
    withErrorHandling(async ({ endpointSlug, limit, since }) => {
      const requests = await client.requests.list(endpointSlug, { limit, since });
      return textContent(JSON.stringify(requests, null, 2));
    })
  );

  server.tool(
    "get_request",
    "Get full details of a specific captured webhook request by its ID. Includes method, headers, body, path, and timestamp.",
    { requestId: z.string().describe("The request ID") },
    withErrorHandling(async ({ requestId }) => {
      const request = await client.requests.get(requestId);
      return textContent(JSON.stringify(request, null, 2));
    })
  );

  server.tool(
    "wait_for_request",
    "Wait for a webhook request to arrive at an endpoint. Polls until a request is captured or timeout expires. Use this after sending a webhook to verify it was received.",
    {
      endpointSlug: z.string().describe("The endpoint slug to monitor"),
      timeout: z
        .union([z.string(), z.number()])
        .default("30s")
        .describe('How long to wait (e.g. "30s", "5m", or milliseconds as number)'),
      pollInterval: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Interval between polls (e.g. "1s", "500", or milliseconds). Default: 500ms'),
    },
    withErrorHandling(async ({ endpointSlug, timeout, pollInterval }) => {
      const request = await client.requests.waitFor(endpointSlug, { timeout, pollInterval });
      return textContent(JSON.stringify(request, null, 2));
    })
  );

  server.tool(
    "replay_request",
    "Replay a previously captured webhook request to a target URL. Sends the original method, headers, and body to the specified URL. Only use with URLs you trust — the original request data is forwarded.",
    {
      requestId: z.string().describe("The ID of the captured request to replay"),
      targetUrl: z
        .string()
        .url()
        .refine(
          (u) => {
            try {
              const p = new URL(u).protocol;
              return p === "http:" || p === "https:";
            } catch {
              return false;
            }
          },
          { message: "Only http and https URLs are supported" }
        )
        .describe("The URL to send the replayed request to (http or https only)"),
    },
    withErrorHandling(async ({ requestId, targetUrl }) => {
      const response = await client.requests.replay(requestId, targetUrl);
      const responseBody = await readBodyTruncated(response);
      return textContent(
        JSON.stringify(
          { status: response.status, statusText: response.statusText, body: responseBody },
          null,
          2
        )
      );
    })
  );

  server.tool(
    "describe",
    "Describe all available SDK operations, their parameters, and types. Useful for discovering what actions are possible.",
    {},
    withErrorHandling(async () => {
      const description = client.describe();
      return textContent(JSON.stringify(description, null, 2));
    })
  );
}
