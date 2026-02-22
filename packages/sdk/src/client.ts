/**
 * @fileoverview webhooks.cc SDK client for programmatic webhook management.
 *
 * @example
 * ```typescript
 * import { WebhooksCC, matchMethod } from '@webhooks-cc/sdk';
 *
 * const client = new WebhooksCC({ apiKey: 'whcc_...' });
 * const endpoint = await client.endpoints.create({ name: 'My Webhook' });
 * const request = await client.requests.waitFor(endpoint.slug, {
 *   timeout: '30s',
 *   match: matchMethod('POST'),
 * });
 * ```
 */
import type {
  ClientOptions,
  ClientHooks,
  Endpoint,
  Request,
  CreateEndpointOptions,
  UpdateEndpointOptions,
  SendOptions,
  SendTemplateOptions,
  ListRequestsOptions,
  WaitForOptions,
  SubscribeOptions,
  SDKDescription,
} from "./types";
import {
  WebhooksCCError,
  UnauthorizedError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
} from "./errors";
import { parseDuration } from "./utils";
import { parseSSE } from "./sse";
import { buildTemplateSendOptions } from "./templates";

const DEFAULT_BASE_URL = "https://webhooks.cc";
const DEFAULT_WEBHOOK_URL = "https://go.webhooks.cc";
const DEFAULT_TIMEOUT = 30000;
const SDK_VERSION = "0.3.0";

// Poll interval bounds: 10ms minimum prevents busy loops, 60s maximum prevents stale connections
const MIN_POLL_INTERVAL = 10;
const MAX_POLL_INTERVAL = 60000;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);

// Headers stripped when replaying requests (hop-by-hop + sensitive)
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie"]);

// Proxy/CDN headers added by infrastructure — not part of the original request
const PROXY_HEADERS = new Set([
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "true-client-ip",
]);

/**
 * @deprecated Use {@link WebhooksCCError} instead. Kept for backward compatibility.
 */
export const ApiError = WebhooksCCError;

/** Map HTTP status codes to typed errors with actionable recovery hints. */
function mapStatusToError(status: number, message: string, response: Response): WebhooksCCError {
  // Append recovery hints when server message is generic (< 30 chars)
  const isGeneric = message.length < 30;

  switch (status) {
    case 401: {
      const hint = isGeneric
        ? `${message} — Get an API key at https://webhooks.cc/account`
        : message;
      return new UnauthorizedError(hint);
    }
    case 404: {
      const hint = isGeneric
        ? `${message} — Use client.endpoints.list() to see available endpoints.`
        : message;
      return new NotFoundError(hint);
    }
    case 429: {
      const retryAfterHeader = response.headers.get("retry-after");
      let retryAfter: number | undefined;
      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        retryAfter = Number.isNaN(parsed) ? undefined : parsed;
      }
      return new RateLimitError(retryAfter);
    }
    default:
      return new WebhooksCCError(status, message);
  }
}

// Validates path segments to prevent traversal attacks (e.g., "../admin")
const SAFE_PATH_SEGMENT_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates that a URL path segment contains only safe characters.
 * Prevents path traversal attacks by rejecting "..", "/", and special characters.
 */
function validatePathSegment(segment: string, name: string): void {
  if (!SAFE_PATH_SEGMENT_REGEX.test(segment)) {
    throw new Error(
      `Invalid ${name}: must contain only alphanumeric characters, hyphens, and underscores`
    );
  }
}

/**
 * Client for the webhooks.cc API.
 *
 * Provides methods to create endpoints, list captured requests, and wait
 * for incoming webhooks. Handles authentication, request signing, and
 * response validation.
 */
export class WebhooksCC {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly webhookUrl: string;
  private readonly timeout: number;
  private readonly hooks: ClientHooks;

  constructor(options: ClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new Error("Missing or invalid apiKey. Get one at https://webhooks.cc/account");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.webhookUrl = stripTrailingSlashes(options.webhookUrl ?? DEFAULT_WEBHOOK_URL);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.hooks = options.hooks ?? {};
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const start = Date.now();

    try {
      this.hooks.onRequest?.({ method, url });
    } catch {
      // Hooks must not break the request flow
    }

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const durationMs = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text();
        const sanitizedError = errorText.length > 200 ? errorText.slice(0, 200) + "..." : errorText;
        const error = mapStatusToError(response.status, sanitizedError, response);
        try {
          this.hooks.onError?.({ method, url, error, durationMs });
        } catch {
          // Hooks must not break the request flow
        }
        throw error;
      }

      try {
        this.hooks.onResponse?.({ method, url, status: response.status, durationMs });
      } catch {
        // Hooks must not break the request flow
      }

      // Handle empty responses (204 No Content)
      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return undefined as T;
      }

      // Validate Content-Type before parsing JSON
      const contentType = response.headers.get("content-type");
      if (contentType && !contentType.includes("application/json")) {
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      return response.json() as Promise<T>;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new TimeoutError(this.timeout);
        try {
          this.hooks.onError?.({
            method,
            url,
            error: timeoutError,
            durationMs: Date.now() - start,
          });
        } catch {
          // Hooks must not break the request flow
        }
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Returns a static description of all SDK operations (no API call). */
  describe(): SDKDescription {
    return {
      version: SDK_VERSION,
      endpoints: {
        create: {
          description: "Create a webhook endpoint",
          params: { name: "string?" },
        },
        list: {
          description: "List all endpoints",
          params: {},
        },
        get: {
          description: "Get endpoint by slug",
          params: { slug: "string" },
        },
        update: {
          description: "Update endpoint settings",
          params: { slug: "string", name: "string?", mockResponse: "object?" },
        },
        delete: {
          description: "Delete endpoint and its requests",
          params: { slug: "string" },
        },
        send: {
          description: "Send a test webhook to endpoint",
          params: { slug: "string", method: "string?", headers: "object?", body: "unknown?" },
        },
        sendTemplate: {
          description: "Send a provider template webhook with signed headers",
          params: {
            slug: "string",
            provider: '"stripe"|"github"|"shopify"|"twilio"',
            template: "string?",
            secret: "string",
            event: "string?",
          },
        },
      },
      requests: {
        list: {
          description: "List captured requests",
          params: { endpointSlug: "string", limit: "number?", since: "number?" },
        },
        get: {
          description: "Get request by ID",
          params: { requestId: "string" },
        },
        waitFor: {
          description: "Poll until a matching request arrives",
          params: {
            endpointSlug: "string",
            timeout: "number|string?",
            match: "function?",
          },
        },
        subscribe: {
          description: "Stream requests via SSE",
          params: { slug: "string", signal: "AbortSignal?", timeout: "number|string?" },
        },
        replay: {
          description: "Replay a captured request to a URL",
          params: { requestId: "string", targetUrl: "string" },
        },
      },
    };
  }

  endpoints = {
    create: async (options: CreateEndpointOptions = {}): Promise<Endpoint> => {
      return this.request<Endpoint>("POST", "/endpoints", options);
    },

    list: async (): Promise<Endpoint[]> => {
      return this.request<Endpoint[]>("GET", "/endpoints");
    },

    get: async (slug: string): Promise<Endpoint> => {
      validatePathSegment(slug, "slug");
      return this.request<Endpoint>("GET", `/endpoints/${slug}`);
    },

    update: async (slug: string, options: UpdateEndpointOptions): Promise<Endpoint> => {
      validatePathSegment(slug, "slug");
      if (options.mockResponse && options.mockResponse !== null) {
        const { status } = options.mockResponse;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw new Error(`Invalid mock response status: ${status}. Must be an integer 100-599.`);
        }
      }
      return this.request<Endpoint>("PATCH", `/endpoints/${slug}`, options);
    },

    delete: async (slug: string): Promise<void> => {
      validatePathSegment(slug, "slug");
      await this.request("DELETE", `/endpoints/${slug}`);
    },

    send: async (slug: string, options: SendOptions = {}): Promise<Response> => {
      validatePathSegment(slug, "slug");
      const rawMethod = (options.method ?? "POST").toUpperCase();
      if (!ALLOWED_METHODS.has(rawMethod)) {
        throw new Error(
          `Invalid HTTP method: "${options.method}". Must be one of: ${[...ALLOWED_METHODS].join(", ")}`
        );
      }
      const { headers = {}, body } = options;
      const method = rawMethod;
      const url = `${this.webhookUrl}/w/${slug}`;

      const fetchHeaders: Record<string, string> = { ...headers };
      const hasContentType = Object.keys(fetchHeaders).some(
        (k) => k.toLowerCase() === "content-type"
      );
      if (body !== undefined && !hasContentType) {
        fetchHeaders["Content-Type"] = "application/json";
      }

      return fetch(url, {
        method,
        headers: fetchHeaders,
        body:
          body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(this.timeout),
      });
    },

    sendTemplate: async (slug: string, options: SendTemplateOptions): Promise<Response> => {
      validatePathSegment(slug, "slug");
      if (!options.secret || typeof options.secret !== "string") {
        throw new Error("sendTemplate requires a non-empty secret");
      }

      const endpointUrl = `${this.webhookUrl}/w/${slug}`;
      const sendOptions = await buildTemplateSendOptions(endpointUrl, options);
      return this.endpoints.send(slug, sendOptions);
    },
  };

  requests = {
    list: async (endpointSlug: string, options: ListRequestsOptions = {}): Promise<Request[]> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.since !== undefined) params.set("since", String(options.since));

      const query = params.toString();
      return this.request<Request[]>(
        "GET",
        `/endpoints/${endpointSlug}/requests${query ? `?${query}` : ""}`
      );
    },

    get: async (requestId: string): Promise<Request> => {
      validatePathSegment(requestId, "requestId");
      return this.request<Request>("GET", `/requests/${requestId}`);
    },

    /**
     * Polls for incoming requests until one matches or timeout expires.
     *
     * Fetches requests that arrived since the last successful check. On API
     * errors, continues polling without updating the timestamp to avoid
     * missing requests during transient failures.
     *
     * @param endpointSlug - Endpoint to monitor
     * @param options - Timeout, poll interval, and optional match filter
     * @returns First matching request, or first request if no match filter
     * @throws Error if timeout expires or max iterations (10000) reached
     */
    waitFor: async (endpointSlug: string, options: WaitForOptions = {}): Promise<Request> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      const timeout = parseDuration(options.timeout ?? 30000);
      const rawPollInterval = parseDuration(options.pollInterval ?? 500);
      const { match } = options;
      // Clamp pollInterval to safe bounds
      const safePollInterval = Math.max(
        MIN_POLL_INTERVAL,
        Math.min(MAX_POLL_INTERVAL, rawPollInterval)
      );
      const start = Date.now();
      // Start from 5 minutes before to catch requests that were sent just before
      // waitFor was called but haven't been flushed to the database yet
      let lastChecked = start - 5 * 60 * 1000;
      const MAX_ITERATIONS = 10000;
      let iterations = 0;

      while (Date.now() - start < timeout && iterations < MAX_ITERATIONS) {
        iterations++;
        const checkTime = Date.now();

        try {
          const requests = await this.requests.list(endpointSlug, {
            since: lastChecked,
            limit: 100,
          });

          lastChecked = checkTime;

          const matched = match ? requests.find(match) : requests[0];
          if (matched) {
            return matched;
          }
        } catch (error) {
          // Throw on non-transient errors - don't continue polling with invalid credentials
          if (error instanceof WebhooksCCError) {
            if (error instanceof UnauthorizedError) {
              throw error;
            }
            if (error instanceof NotFoundError) {
              throw error;
            }
            // Continue polling only for transient errors (5xx, rate limit)
            if (error.statusCode < 500 && !(error instanceof RateLimitError)) {
              throw error;
            }
          }
          // Continue polling for transient errors (network issues, 5xx) without updating lastChecked
          // to avoid missing requests during temporary issues
        }

        await sleep(safePollInterval);
      }

      throw new TimeoutError(timeout);
    },

    /**
     * Replay a captured request to a target URL.
     *
     * Fetches the original request by ID and re-sends it to the specified URL
     * with the original method, headers, and body. Hop-by-hop headers are stripped.
     */
    replay: async (requestId: string, targetUrl: string): Promise<Response> => {
      validatePathSegment(requestId, "requestId");

      // Validate target URL
      let parsed: URL;
      try {
        parsed = new URL(targetUrl);
      } catch {
        throw new Error(`Invalid targetUrl: "${targetUrl}" is not a valid URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Invalid targetUrl: only http and https protocols are supported`);
      }

      const captured = await this.requests.get(requestId);

      // Strip hop-by-hop and sensitive headers
      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(captured.headers)) {
        const lower = key.toLowerCase();
        if (
          !HOP_BY_HOP_HEADERS.has(lower) &&
          !SENSITIVE_HEADERS.has(lower) &&
          !PROXY_HEADERS.has(lower)
        ) {
          headers[key] = val;
        }
      }

      // Don't send body on GET/HEAD requests
      const upperMethod = captured.method.toUpperCase();
      const body =
        upperMethod === "GET" || upperMethod === "HEAD" ? undefined : (captured.body ?? undefined);

      return fetch(targetUrl, {
        method: captured.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeout),
      });
    },

    /**
     * Stream incoming requests via SSE as an async iterator.
     *
     * Connects to the SSE endpoint and yields Request objects as they arrive.
     * The connection is closed when the iterator is broken, the signal is aborted,
     * or the timeout expires.
     *
     * No automatic reconnection — if the connection drops, the iterator ends.
     */
    subscribe: (slug: string, options: SubscribeOptions = {}): AsyncIterable<Request> => {
      validatePathSegment(slug, "slug");
      const { signal, timeout } = options;
      const baseUrl = this.baseUrl;
      const apiKey = this.apiKey;
      const timeoutMs = timeout !== undefined ? parseDuration(timeout) : undefined;

      return {
        [Symbol.asyncIterator](): AsyncIterableIterator<Request> {
          const controller = new AbortController();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let iterator: AsyncGenerator<{ event: string; data: string }> | null = null;
          let started = false;

          // Link external signal to our controller
          const onAbort = () => controller.abort();
          if (signal) {
            if (signal.aborted) {
              controller.abort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          if (timeoutMs !== undefined) {
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          }

          const cleanup = () => {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            if (signal) signal.removeEventListener("abort", onAbort);
          };

          const start = async () => {
            const url = `${baseUrl}/api/stream/${slug}`;
            // Use a separate signal for connection timeout so it doesn't conflict with stream duration
            const connectController = new AbortController();
            const connectTimeout = setTimeout(() => connectController.abort(), 30000);
            // Abort connection timeout if the main controller aborts
            controller.signal.addEventListener("abort", () => connectController.abort(), {
              once: true,
            });
            let response: globalThis.Response;
            try {
              response = await fetch(url, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: connectController.signal,
              });
            } finally {
              clearTimeout(connectTimeout);
            }

            if (!response.ok) {
              cleanup();
              const text = await response.text();
              throw mapStatusToError(response.status, text, response);
            }

            if (!response.body) {
              cleanup();
              throw new Error("SSE response has no body");
            }

            // Link main controller to response body so abort cancels the stream
            controller.signal.addEventListener(
              "abort",
              () => {
                response.body?.cancel().catch(() => {
                  // Stream may already be locked/consumed by parseSSE — safe to ignore
                });
              },
              { once: true }
            );

            return parseSSE(response.body);
          };

          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next(): Promise<IteratorResult<Request>> {
              try {
                if (!started) {
                  started = true;
                  iterator = await start();
                }

                while (iterator) {
                  const { done, value } = await iterator.next();
                  if (done) {
                    cleanup();
                    return { done: true, value: undefined };
                  }

                  // Only yield actual request events
                  if (value.event === "request") {
                    try {
                      const data = JSON.parse(value.data);
                      // Validate required fields exist
                      if (!data.endpointId || !data.method || !data.headers || !data.receivedAt) {
                        continue; // Skip malformed frames
                      }
                      // Transform SSE data to Request shape
                      const req: Request = {
                        id: data._id ?? data.id,
                        endpointId: data.endpointId,
                        method: data.method,
                        path: data.path ?? "/",
                        headers: data.headers,
                        body: data.body ?? undefined,
                        queryParams: data.queryParams ?? {},
                        contentType: data.contentType ?? undefined,
                        ip: data.ip ?? "unknown",
                        size: data.size ?? 0,
                        receivedAt: data.receivedAt,
                      };
                      return { done: false, value: req };
                    } catch {
                      // Skip malformed data frames
                      continue;
                    }
                  }

                  // Close on terminal events
                  if (value.event === "timeout" || value.event === "endpoint_deleted") {
                    cleanup();
                    return { done: true, value: undefined };
                  }

                  // Skip connected, keepalive, and other events
                }

                cleanup();
                return { done: true, value: undefined };
              } catch (error) {
                cleanup();
                controller.abort();
                // AbortError means the consumer broke out or signal was aborted — that's normal
                if (error instanceof Error && error.name === "AbortError") {
                  return { done: true, value: undefined };
                }
                throw error;
              }
            },
            async return(): Promise<IteratorResult<Request>> {
              cleanup();
              controller.abort();
              if (iterator) {
                await iterator.return(undefined);
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}

/** Returns a promise that resolves after the specified milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingSlashes(url: string): string {
  let i = url.length;
  while (i > 0 && url[i - 1] === "/") i--;
  return i === url.length ? url : url.slice(0, i);
}
