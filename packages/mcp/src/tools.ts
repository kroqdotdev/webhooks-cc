import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diffRequests,
  extractJsonField,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  verifySignature,
  WebhooksCCError,
  type Request,
  type TemplateProvider,
  type VerifyProvider,
  type WebhooksCC,
} from "@webhooks-cc/sdk";

const MAX_BODY_SIZE = 32_768;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const TEMPLATE_PROVIDER_VALUES = [
  "stripe",
  "github",
  "shopify",
  "twilio",
  "slack",
  "paddle",
  "linear",
  "standard-webhooks",
] as const satisfies readonly TemplateProvider[];
const VERIFY_PROVIDER_VALUES = [
  ...TEMPLATE_PROVIDER_VALUES,
  "discord",
] as const satisfies readonly VerifyProvider[];
const TIME_SEPARATOR = " — ";

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Only http and https URLs are supported" }
  );
const methodSchema = z.enum(HTTP_METHODS).default("POST").describe("HTTP method (default: POST)");
const durationOrTimestampSchema = z.union([z.string(), z.number()]);
const mockResponseSchema = z.object({
  status: z.number().int().min(100).max(599).describe("HTTP status code (100-599)"),
  body: z.string().default("").describe("Response body string (default: empty)"),
  headers: z.record(z.string()).default({}).describe("Response headers (default: none)"),
});

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

/** Create a text content response for MCP tools. */
function textContent(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function serializeJson(value: unknown, limit = MAX_BODY_SIZE): string {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= limit) {
    return full;
  }

  if (Array.isArray(value)) {
    let low = 0;
    let high = value.length;
    let best = JSON.stringify(
      { items: [], truncated: true, total: value.length, returned: 0 },
      null,
      2
    );

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = JSON.stringify(
        {
          items: value.slice(0, mid),
          truncated: true,
          total: value.length,
          returned: mid,
        },
        null,
        2
      );

      if (candidate.length <= limit) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return best;
  }

  return full.slice(0, limit) + `\n... [truncated, ${full.length} chars total]`;
}

function jsonContent(value: unknown): ToolResult {
  return textContent(serializeJson(value));
}

/** Read response body with size limit to avoid unbounded memory usage. */
async function readBodyTruncated(response: Response, limit = MAX_BODY_SIZE): Promise<string> {
  const text = await response.text();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated, ${text.length} chars total]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitHint(message: string): { message: string; hint: string | null } {
  const separatorIndex = message.indexOf(TIME_SEPARATOR);
  if (separatorIndex === -1) {
    return { message, hint: null };
  }

  return {
    message: message.slice(0, separatorIndex),
    hint: message.slice(separatorIndex + TIME_SEPARATOR.length) || null,
  };
}

function serializeError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const { message, hint } = splitHint(rawMessage);

  const payload: {
    error: true;
    code:
      | "unauthorized"
      | "not_found"
      | "rate_limited"
      | "timeout"
      | "validation_error"
      | "server_error";
    message: string;
    hint: string | null;
    retryAfter: number | null;
  } = {
    error: true,
    code: "validation_error",
    message,
    hint,
    retryAfter: null,
  };

  if (error instanceof UnauthorizedError) {
    payload.code = "unauthorized";
  } else if (error instanceof NotFoundError) {
    payload.code = "not_found";
  } else if (error instanceof RateLimitError) {
    payload.code = "rate_limited";
    payload.retryAfter = error.retryAfter ?? null;
  } else if (error instanceof TimeoutError) {
    payload.code = "timeout";
  } else if (error instanceof WebhooksCCError) {
    payload.code = error.statusCode >= 500 ? "server_error" : "validation_error";
  }

  return JSON.stringify(payload, null, 2);
}

/** Wrap a tool handler with error handling that returns structured MCP errors. */
function withErrorHandling<T>(
  handler: (args: T) => Promise<ToolResult>
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      return { ...textContent(serializeError(error)), isError: true };
    }
  };
}

function filterRequestsByMethod(requests: Request[], method?: string): Request[] {
  if (!method) {
    return requests;
  }

  const target = method.toUpperCase();
  return requests.filter((request) => request.method.toUpperCase() === target);
}

async function waitForMultipleRequests(
  client: WebhooksCC,
  endpointSlug: string,
  options: {
    count: number;
    timeout?: number | string;
    pollInterval?: number | string;
    method?: string;
  }
): Promise<{ requests: Request[]; complete: boolean; timedOut: boolean; expectedCount: number }> {
  const timeoutMs =
    typeof options.timeout === "number"
      ? options.timeout
      : options.timeout
        ? Number.isNaN(Number(options.timeout))
          ? parseDurationLike(options.timeout)
          : Number(options.timeout)
        : 30_000;
  const pollIntervalMs =
    typeof options.pollInterval === "number"
      ? options.pollInterval
      : options.pollInterval
        ? Number.isNaN(Number(options.pollInterval))
          ? parseDurationLike(options.pollInterval)
          : Number(options.pollInterval)
        : 500;

  const startedAt = Date.now();
  let since = startedAt;
  const seenIds = new Set<string>();
  const requests: Request[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const checkTime = Date.now();
    const page = await client.requests.list(endpointSlug, {
      since,
      limit: Math.max(100, options.count * 5),
    });
    since = checkTime;

    const filtered = filterRequestsByMethod(page, options.method)
      .slice()
      .sort((left, right) => left.receivedAt - right.receivedAt);

    for (const request of filtered) {
      if (seenIds.has(request.id)) {
        continue;
      }

      seenIds.add(request.id);
      requests.push(request);

      if (requests.length >= options.count) {
        return {
          requests,
          complete: true,
          timedOut: false,
          expectedCount: options.count,
        };
      }
    }

    await sleep(Math.max(10, pollIntervalMs));
  }

  return {
    requests,
    complete: requests.length >= options.count,
    timedOut: true,
    expectedCount: options.count,
  };
}

function parseDurationLike(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Duration value cannot be empty");
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  const match = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration: "${value}"`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return amount * multiplier;
}

function ensureVerifyArgs(args: {
  provider: VerifyProvider;
  secret?: string;
  publicKey?: string;
  url?: string;
}):
  | { provider: "discord"; publicKey: string }
  | { provider: Exclude<VerifyProvider, "discord">; secret: string; url?: string } {
  if (args.provider === "discord") {
    const publicKey = args.publicKey?.trim();
    if (!publicKey) {
      throw new Error('verify_signature for provider "discord" requires publicKey');
    }

    return {
      provider: "discord",
      publicKey,
    };
  }

  const secret = args.secret?.trim();
  if (!secret) {
    throw new Error(`verify_signature for provider "${args.provider}" requires secret`);
  }

  return {
    provider: args.provider,
    secret,
    ...(args.url ? { url: args.url } : {}),
  };
}

async function summarizeResponse(response: Response): Promise<{
  status: number;
  statusText: string;
  body: string;
}> {
  return {
    status: response.status,
    statusText: response.statusText,
    body: await readBodyTruncated(response),
  };
}

/** Register all webhook tools on an MCP server instance. */
export function registerTools(server: McpServer, client: WebhooksCC): void {
  server.tool(
    "create_endpoint",
    "Create a webhook endpoint. Returns the endpoint slug, URL, and metadata.",
    {
      name: z.string().optional().describe("Display name for the endpoint"),
      ephemeral: z.boolean().optional().describe("Create a temporary endpoint that auto-expires"),
      expiresIn: durationOrTimestampSchema
        .optional()
        .describe('Auto-expire after this duration, for example "12h"'),
      mockResponse: mockResponseSchema
        .optional()
        .describe("Optional mock response to return when the endpoint receives a request"),
    },
    withErrorHandling(async ({ name, ephemeral, expiresIn, mockResponse }) => {
      const endpoint = await client.endpoints.create({ name, ephemeral, expiresIn, mockResponse });
      return jsonContent(endpoint);
    })
  );

  server.tool(
    "list_endpoints",
    "List all webhook endpoints for the authenticated user.",
    {},
    withErrorHandling(async () => {
      const endpoints = await client.endpoints.list();
      return jsonContent(endpoints);
    })
  );

  server.tool(
    "get_endpoint",
    "Get details for a specific webhook endpoint by slug.",
    { slug: z.string().describe("The endpoint slug") },
    withErrorHandling(async ({ slug }) => {
      const endpoint = await client.endpoints.get(slug);
      return jsonContent(endpoint);
    })
  );

  server.tool(
    "update_endpoint",
    "Update an endpoint name or mock response configuration.",
    {
      slug: z.string().describe("The endpoint slug to update"),
      name: z.string().optional().describe("New display name"),
      mockResponse: mockResponseSchema
        .nullable()
        .optional()
        .describe("Mock response config, or null to clear it"),
    },
    withErrorHandling(async ({ slug, name, mockResponse }) => {
      const endpoint = await client.endpoints.update(slug, { name, mockResponse });
      return jsonContent(endpoint);
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
    "create_endpoints",
    "Create multiple webhook endpoints in one call.",
    {
      count: z.number().int().min(1).max(20).describe("Number of endpoints to create"),
      namePrefix: z.string().optional().describe("Optional prefix for endpoint names"),
      ephemeral: z.boolean().optional().describe("Create temporary endpoints that auto-expire"),
      expiresIn: durationOrTimestampSchema
        .optional()
        .describe('Auto-expire after this duration, for example "12h"'),
    },
    withErrorHandling(async ({ count, namePrefix, ephemeral, expiresIn }) => {
      const endpoints = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          client.endpoints.create({
            name: namePrefix ? `${namePrefix}-${index + 1}` : undefined,
            ephemeral,
            expiresIn,
          })
        )
      );

      return jsonContent({ endpoints });
    })
  );

  server.tool(
    "delete_endpoints",
    "Delete multiple webhook endpoints in one call.",
    {
      slugs: z.array(z.string()).min(1).max(100).describe("Endpoint slugs to delete"),
    },
    withErrorHandling(async ({ slugs }) => {
      const settled = await Promise.allSettled(
        slugs.map(async (slug) => {
          await client.endpoints.delete(slug);
          return slug;
        })
      );

      return jsonContent({
        deleted: settled
          .filter(
            (result): result is PromiseFulfilledResult<string> => result.status === "fulfilled"
          )
          .map((result) => result.value),
        failed: settled.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                {
                  slug: slugs[index],
                  message:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                },
              ]
            : []
        ),
      });
    })
  );

  server.tool(
    "send_webhook",
    "Send a test webhook to a hosted endpoint. Supports provider templates and signing.",
    {
      slug: z.string().describe("The endpoint slug to send to"),
      method: methodSchema,
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body"),
      provider: z
        .enum(TEMPLATE_PROVIDER_VALUES)
        .optional()
        .describe("Optional provider template to send with signed headers"),
      template: z.string().optional().describe("Provider-specific template preset"),
      event: z.string().optional().describe("Provider event or topic name"),
      secret: z.string().optional().describe("Signing secret. Required when provider is set."),
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
        return jsonContent({
          status: response.status,
          statusText: response.statusText,
          body: responseBody,
        });
      }
    )
  );

  server.tool(
    "list_requests",
    "List recent captured requests for an endpoint.",
    {
      endpointSlug: z.string().describe("The endpoint slug"),
      limit: z.number().int().min(1).max(100).default(25).describe("Max requests to return"),
      since: z.number().optional().describe("Only return requests after this timestamp in ms"),
    },
    withErrorHandling(async ({ endpointSlug, limit, since }) => {
      const requests = await client.requests.list(endpointSlug, { limit, since });
      return jsonContent(requests);
    })
  );

  server.tool(
    "search_requests",
    "Search captured webhook requests across endpoints using retained full-text search.",
    {
      slug: z.string().optional().describe("Filter to a specific endpoint slug"),
      method: z.string().optional().describe("Filter by HTTP method"),
      q: z.string().optional().describe("Free-text search across path, body, and headers"),
      from: durationOrTimestampSchema
        .optional()
        .describe('Start time as a timestamp or duration like "1h" or "7d"'),
      to: durationOrTimestampSchema
        .optional()
        .describe('End time as a timestamp or duration like "1h" or "7d"'),
      limit: z.number().int().min(1).max(200).default(50).describe("Max results to return"),
      offset: z.number().int().min(0).max(10_000).default(0).describe("Result offset"),
      order: z.enum(["asc", "desc"]).default("desc").describe("Sort order by received time"),
    },
    withErrorHandling(async ({ slug, method, q, from, to, limit, offset, order }) => {
      const results = await client.requests.search({
        slug,
        method,
        q,
        from,
        to,
        limit,
        offset,
        order,
      });
      return jsonContent(results);
    })
  );

  server.tool(
    "count_requests",
    "Count captured webhook requests that match the given filters.",
    {
      slug: z.string().optional().describe("Filter to a specific endpoint slug"),
      method: z.string().optional().describe("Filter by HTTP method"),
      q: z.string().optional().describe("Free-text search across path, body, and headers"),
      from: durationOrTimestampSchema
        .optional()
        .describe('Start time as a timestamp or duration like "1h" or "7d"'),
      to: durationOrTimestampSchema
        .optional()
        .describe('End time as a timestamp or duration like "1h" or "7d"'),
    },
    withErrorHandling(async ({ slug, method, q, from, to }) => {
      const count = await client.requests.count({ slug, method, q, from, to });
      return jsonContent({ count });
    })
  );

  server.tool(
    "get_request",
    "Get full details for a specific captured request by ID.",
    { requestId: z.string().describe("The request ID") },
    withErrorHandling(async ({ requestId }) => {
      const request = await client.requests.get(requestId);
      return jsonContent(request);
    })
  );

  server.tool(
    "wait_for_request",
    "Wait for a request to arrive at an endpoint.",
    {
      endpointSlug: z.string().describe("The endpoint slug to monitor"),
      timeout: durationOrTimestampSchema
        .default("30s")
        .describe('How long to wait, for example "30s"'),
      pollInterval: durationOrTimestampSchema
        .optional()
        .describe('Interval between polls, for example "500ms" or "1s"'),
    },
    withErrorHandling(async ({ endpointSlug, timeout, pollInterval }) => {
      const request = await client.requests.waitFor(endpointSlug, { timeout, pollInterval });
      return jsonContent(request);
    })
  );

  server.tool(
    "wait_for_requests",
    "Wait for multiple requests to arrive at an endpoint.",
    {
      endpointSlug: z.string().describe("The endpoint slug to monitor"),
      count: z.number().int().min(1).max(20).describe("Number of requests to collect"),
      timeout: durationOrTimestampSchema
        .default("30s")
        .describe('How long to wait, for example "30s"'),
      pollInterval: durationOrTimestampSchema
        .optional()
        .describe('Interval between polls, for example "500ms" or "1s"'),
      method: z.string().optional().describe("Only collect requests with this HTTP method"),
    },
    withErrorHandling(async ({ endpointSlug, count, timeout, pollInterval, method }) => {
      const result = await waitForMultipleRequests(client, endpointSlug, {
        count,
        timeout,
        pollInterval,
        method,
      });
      return jsonContent(result);
    })
  );

  server.tool(
    "replay_request",
    "Replay a previously captured request to a target URL.",
    {
      requestId: z.string().describe("The captured request ID"),
      targetUrl: httpUrlSchema.describe("The URL to replay the request to"),
    },
    withErrorHandling(async ({ requestId, targetUrl }) => {
      const response = await client.requests.replay(requestId, targetUrl);
      const responseBody = await readBodyTruncated(response);
      return jsonContent({
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
    })
  );

  server.tool(
    "compare_requests",
    "Compare two captured requests and show the structured differences.",
    {
      leftRequestId: z.string().describe("The first request ID"),
      rightRequestId: z.string().describe("The second request ID"),
      ignoreHeaders: z.array(z.string()).optional().describe("Headers to ignore during comparison"),
    },
    withErrorHandling(async ({ leftRequestId, rightRequestId, ignoreHeaders }) => {
      const [leftRequest, rightRequest] = await Promise.all([
        client.requests.get(leftRequestId),
        client.requests.get(rightRequestId),
      ]);

      const diff = diffRequests(leftRequest, rightRequest, { ignoreHeaders });
      return jsonContent(diff);
    })
  );

  server.tool(
    "extract_from_request",
    "Extract specific JSON fields from a captured request body.",
    {
      requestId: z.string().describe("The request ID"),
      jsonPaths: z.array(z.string()).min(1).max(50).describe("Dot-notation JSON paths to extract"),
    },
    withErrorHandling(async ({ requestId, jsonPaths }) => {
      const request = await client.requests.get(requestId);
      const extracted = Object.fromEntries(
        jsonPaths.map((path) => [path, extractJsonField(request, path) ?? null])
      );
      return jsonContent(extracted);
    })
  );

  server.tool(
    "verify_signature",
    "Verify the webhook signature on a captured request.",
    {
      requestId: z.string().describe("The captured request ID"),
      provider: z
        .enum(VERIFY_PROVIDER_VALUES)
        .describe("Provider whose signature scheme should be verified"),
      secret: z
        .string()
        .optional()
        .describe("Shared signing secret. Required for non-Discord providers."),
      publicKey: z
        .string()
        .optional()
        .describe("Discord application public key. Required for provider=discord."),
      url: httpUrlSchema
        .optional()
        .describe("Original signed URL. Required for Twilio verification."),
    },
    withErrorHandling(async ({ requestId, provider, secret, publicKey, url }) => {
      const request = await client.requests.get(requestId);
      const verificationOptions = ensureVerifyArgs({ provider, secret, publicKey, url });
      const result = await verifySignature(request, verificationOptions);
      return jsonContent({
        valid: result.valid,
        details: result.valid ? "Signature is valid." : "Signature did not match.",
      });
    })
  );

  server.tool(
    "clear_requests",
    "Delete captured requests for an endpoint without deleting the endpoint itself.",
    {
      slug: z.string().describe("The endpoint slug to clear"),
      before: durationOrTimestampSchema
        .optional()
        .describe('Only clear requests older than this timestamp or duration like "1h"'),
    },
    withErrorHandling(async ({ slug, before }) => {
      await client.requests.clear(slug, { before });
      return jsonContent({ slug, cleared: true, before: before ?? null });
    })
  );

  server.tool(
    "send_to",
    "Send a webhook directly to any URL with optional provider signing.",
    {
      url: httpUrlSchema.describe("Target URL"),
      method: methodSchema,
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body"),
      provider: z
        .enum(TEMPLATE_PROVIDER_VALUES)
        .optional()
        .describe("Optional provider template for signing"),
      template: z.string().optional().describe("Provider-specific template preset"),
      event: z.string().optional().describe("Provider event or topic name"),
      secret: z.string().optional().describe("Signing secret. Required when provider is set."),
    },
    withErrorHandling(async ({ url, method, headers, body, provider, template, event, secret }) => {
      const response = await client.sendTo(url, {
        method,
        headers,
        body,
        provider,
        template,
        event,
        secret,
      });
      const responseBody = await readBodyTruncated(response);
      return jsonContent({
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
    })
  );

  server.tool(
    "preview_webhook",
    "Preview a webhook request without sending it. Returns the exact URL, method, headers, and body.",
    {
      url: httpUrlSchema.describe("Target URL"),
      method: methodSchema,
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body"),
      provider: z
        .enum(TEMPLATE_PROVIDER_VALUES)
        .optional()
        .describe("Optional provider template for signing"),
      template: z.string().optional().describe("Provider-specific template preset"),
      event: z.string().optional().describe("Provider event or topic name"),
      secret: z.string().optional().describe("Signing secret. Required when provider is set."),
    },
    withErrorHandling(async ({ url, method, headers, body, provider, template, event, secret }) => {
      const preview = await client.buildRequest(url, {
        method,
        headers,
        body,
        provider,
        template,
        event,
        secret,
      });
      return jsonContent(preview);
    })
  );

  server.tool(
    "list_provider_templates",
    "List supported webhook providers, templates, and signing metadata.",
    {
      provider: z.enum(TEMPLATE_PROVIDER_VALUES).optional().describe("Filter to a single provider"),
    },
    withErrorHandling(async ({ provider }) => {
      if (provider) {
        return jsonContent([client.templates.get(provider)]);
      }

      return jsonContent(
        client.templates.listProviders().map((name) => client.templates.get(name))
      );
    })
  );

  server.tool(
    "get_usage",
    "Check current request usage, remaining quota, plan, and period end.",
    {},
    withErrorHandling(async () => {
      const usage = await client.usage();
      return jsonContent({
        ...usage,
        periodEnd: usage.periodEnd ? new Date(usage.periodEnd).toISOString() : null,
      });
    })
  );

  server.tool(
    "test_webhook_flow",
    "Run a full webhook test flow: create endpoint, optionally mock, send, wait, verify, replay, and clean up.",
    {
      provider: z
        .enum(TEMPLATE_PROVIDER_VALUES)
        .optional()
        .describe("Optional provider template to use when sending the webhook"),
      event: z.string().optional().describe("Optional provider event or topic name"),
      secret: z
        .string()
        .optional()
        .describe(
          "Signing secret. Required when provider is set or signature verification is enabled."
        ),
      mockStatus: z
        .number()
        .int()
        .min(100)
        .max(599)
        .optional()
        .describe("Optional mock response status to configure before sending"),
      targetUrl: httpUrlSchema
        .optional()
        .describe("Optional URL to replay the captured request to after capture"),
      verifySignature: z
        .boolean()
        .default(false)
        .describe("Verify the captured request signature after capture"),
      cleanup: z
        .boolean()
        .default(true)
        .describe("Delete the created endpoint after the flow completes"),
    },
    withErrorHandling(
      async ({
        provider,
        event,
        secret,
        mockStatus,
        targetUrl,
        verifySignature: shouldVerify,
        cleanup,
      }) => {
        const flow = client
          .flow()
          .createEndpoint({ expiresIn: "1h" })
          .waitForCapture({ timeout: "30s" });

        if (mockStatus !== undefined) {
          flow.setMock({
            status: mockStatus,
            body: "",
            headers: {},
          });
        }

        if (provider) {
          const templateSecret = secret?.trim();
          if (!templateSecret) {
            throw new Error(
              "test_webhook_flow with provider templates requires a non-empty secret"
            );
          }

          flow.sendTemplate({
            provider,
            event,
            secret: templateSecret,
          });

          if (shouldVerify) {
            flow.verifySignature({
              provider,
              secret: templateSecret,
            });
          }
        } else {
          if (shouldVerify) {
            throw new Error("test_webhook_flow cannot verify signatures without a provider");
          }

          flow.send();
        }

        if (targetUrl) {
          flow.replayTo(targetUrl);
        }
        if (cleanup) {
          flow.cleanup();
        }

        const result = await flow.run();
        return jsonContent({
          endpoint: result.endpoint,
          request: result.request ?? null,
          verification: result.verification ?? null,
          replayResponse: result.replayResponse
            ? await summarizeResponse(result.replayResponse)
            : null,
          cleanedUp: result.cleanedUp,
        });
      }
    )
  );

  server.tool(
    "describe",
    "Describe all available SDK operations, parameters, and types.",
    {},
    withErrorHandling(async () => {
      const description = client.describe();
      return jsonContent(description);
    })
  );
}
