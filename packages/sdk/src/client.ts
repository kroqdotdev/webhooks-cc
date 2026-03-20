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
  MockResponse,
  Request,
  UsageInfo,
  CreateEndpointOptions,
  UpdateEndpointOptions,
  SendOptions,
  SendTemplateOptions,
  SendToOptions,
  TemplateProvider,
  TemplateProviderInfo,
  ListRequestsOptions,
  ListPaginatedRequestsOptions,
  PaginatedResult,
  ClearRequestsOptions,
  ExportRequestsOptions,
  RequestsExport,
  SearchFilters,
  SearchResult,
  WaitForOptions,
  WaitForAllOptions,
  SubscribeOptions,
  RetryOptions,
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
import { buildTemplateSendOptions, TEMPLATE_METADATA, TEMPLATE_PROVIDERS } from "./templates";
import { buildCurlExport, buildHarExport } from "./request-export";
import { WebhookFlowBuilder } from "./flow";

const DEFAULT_BASE_URL = "https://webhooks.cc";
const DEFAULT_WEBHOOK_URL = "https://go.webhooks.cc";
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRY_ATTEMPTS = 1;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504];
const SDK_VERSION = "0.6.0";
const WAIT_FOR_LOOKBACK_MS = 5 * 60 * 1000;
const DEFAULT_EXPORT_PAGE_SIZE = 100;
const PROVIDER_PARAM_DESCRIPTION = TEMPLATE_PROVIDERS.map((provider) => `"${provider}"`).join("|");

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

function resolveTimestampFilter(value: number | string, now: number): number {
  if (typeof value === "number") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid timestamp filter: value cannot be empty");
  }

  const asNumber = Number(trimmed);
  if (!Number.isNaN(asNumber)) {
    return asNumber;
  }

  return now - parseDuration(trimmed);
}

function buildSearchQuery(filters: SearchFilters, includePagination: boolean): string {
  const params = new URLSearchParams();
  const now = Date.now();

  if (filters.slug !== undefined) {
    validatePathSegment(filters.slug, "slug");
    params.set("slug", filters.slug);
  }
  if (filters.method !== undefined) {
    params.set("method", filters.method);
  }
  if (filters.q !== undefined) {
    params.set("q", filters.q);
  }
  if (filters.from !== undefined) {
    params.set("from", String(resolveTimestampFilter(filters.from, now)));
  }
  if (filters.to !== undefined) {
    params.set("to", String(resolveTimestampFilter(filters.to, now)));
  }
  if (includePagination && filters.limit !== undefined) {
    params.set("limit", String(filters.limit));
  }
  if (includePagination && filters.offset !== undefined) {
    params.set("offset", String(filters.offset));
  }
  if (includePagination && filters.order !== undefined) {
    params.set("order", filters.order);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

function buildClearQuery(options: ClearRequestsOptions = {}): string {
  const params = new URLSearchParams();
  if (options.before !== undefined) {
    params.set("before", String(resolveTimestampFilter(options.before, Date.now())));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function buildPaginatedListQuery(options: ListPaginatedRequestsOptions = {}): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.cursor !== undefined) {
    params.set("cursor", options.cursor);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function parseRetryAfterHeader(response: Response): number | undefined {
  const retryAfterHeader = response.headers.get("retry-after");
  if (!retryAfterHeader) {
    return undefined;
  }

  const parsedSeconds = parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(parsedSeconds) && parsedSeconds >= 0) {
    return parsedSeconds;
  }

  return undefined;
}

function normalizeRetryOptions(retry?: RetryOptions): {
  maxAttempts: number;
  backoffMs: number;
  retryOn: Set<number>;
} {
  const maxAttempts = Math.max(1, Math.floor(retry?.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS));
  const backoffMs = Math.max(0, Math.floor(retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS));
  return {
    maxAttempts,
    backoffMs,
    retryOn: new Set(retry?.retryOn ?? DEFAULT_RETRY_STATUSES),
  };
}

function normalizeExportPageSize(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_EXPORT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(DEFAULT_EXPORT_PAGE_SIZE, Math.floor(limit)));
}

function buildStreamPath(slug: string, since?: number): string {
  const params = new URLSearchParams();
  if (since !== undefined) {
    params.set("since", String(Math.max(0, Math.floor(since))));
  }
  const query = params.toString();
  return `/api/stream/${slug}${query ? `?${query}` : ""}`;
}

function normalizeReconnectBackoff(value: number | string | undefined): number {
  if (value === undefined) {
    return DEFAULT_RETRY_BACKOFF_MS;
  }
  return Math.max(0, parseDuration(value));
}

function shouldReconnectStreamError(error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof NotFoundError) {
    return false;
  }

  if (error instanceof WebhooksCCError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }

  return error instanceof Error;
}

function parseStreamRequest(data: string): Request | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (
      typeof parsed.endpointId !== "string" ||
      typeof parsed.method !== "string" ||
      typeof parsed.receivedAt !== "number" ||
      typeof parsed.headers !== "object" ||
      parsed.headers === null
    ) {
      return null;
    }

    return {
      id:
        typeof parsed._id === "string"
          ? parsed._id
          : typeof parsed.id === "string"
            ? parsed.id
            : "",
      endpointId: parsed.endpointId,
      method: parsed.method,
      path: typeof parsed.path === "string" ? parsed.path : "/",
      headers: parsed.headers as Record<string, string>,
      body: typeof parsed.body === "string" ? parsed.body : undefined,
      queryParams:
        typeof parsed.queryParams === "object" && parsed.queryParams !== null
          ? (parsed.queryParams as Record<string, string>)
          : {},
      contentType: typeof parsed.contentType === "string" ? parsed.contentType : undefined,
      ip: typeof parsed.ip === "string" ? parsed.ip : "unknown",
      size: typeof parsed.size === "number" ? parsed.size : 0,
      receivedAt: parsed.receivedAt,
    };
  } catch {
    return null;
  }
}

async function collectMatchingRequests(
  fetchRequests: (since: number) => Promise<Request[]>,
  options: WaitForAllOptions
): Promise<Request[]> {
  const timeout = parseDuration(options.timeout ?? 30000);
  const rawPollInterval = parseDuration(options.pollInterval ?? 500);
  const safePollInterval = Math.max(
    MIN_POLL_INTERVAL,
    Math.min(MAX_POLL_INTERVAL, rawPollInterval)
  );
  const desiredCount = Math.max(1, Math.floor(options.count));
  const start = Date.now();
  let lastChecked = start - WAIT_FOR_LOOKBACK_MS;
  let iterations = 0;
  const MAX_ITERATIONS = 10000;
  const collected: Request[] = [];
  const seenRequestIds = new Set<string>();

  while (Date.now() - start < timeout && iterations < MAX_ITERATIONS) {
    iterations++;
    const checkTime = Date.now();

    try {
      const requests = (await fetchRequests(lastChecked))
        .slice()
        .sort((left, right) => left.receivedAt - right.receivedAt);

      lastChecked = checkTime;

      for (const request of requests) {
        if (seenRequestIds.has(request.id)) {
          continue;
        }
        seenRequestIds.add(request.id);

        if (options.match && !options.match(request)) {
          continue;
        }

        collected.push(request);
        if (collected.length >= desiredCount) {
          return collected.slice(0, desiredCount);
        }
      }
    } catch (error) {
      if (error instanceof WebhooksCCError) {
        if (error instanceof UnauthorizedError || error instanceof NotFoundError) {
          throw error;
        }
        if (error.statusCode < 500 && !(error instanceof RateLimitError)) {
          throw error;
        }
      }
    }

    await sleep(safePollInterval);
  }

  throw new TimeoutError(timeout);
}

function validateMockResponse(mockResponse: MockResponse, fieldName: string): void {
  const { status, delay } = mockResponse;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`Invalid ${fieldName} status: ${status}. Must be an integer 100-599.`);
  }
  if (delay !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > 30000)) {
    throw new Error(`Invalid ${fieldName} delay: ${delay}. Must be an integer 0-30000.`);
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
  private readonly retry: ReturnType<typeof normalizeRetryOptions>;
  private readonly hooks: ClientHooks;

  constructor(options: ClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new Error("Missing or invalid apiKey. Get one at https://webhooks.cc/account");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.webhookUrl = stripTrailingSlashes(options.webhookUrl ?? DEFAULT_WEBHOOK_URL);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.retry = normalizeRetryOptions(options.retry);
    this.hooks = options.hooks ?? {};
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    let attempt = 0;

    while (true) {
      attempt++;
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
          const sanitizedError =
            errorText.length > 200 ? errorText.slice(0, 200) + "..." : errorText;
          const error = mapStatusToError(response.status, sanitizedError, response);
          try {
            this.hooks.onError?.({ method, url, error, durationMs });
          } catch {
            // Hooks must not break the request flow
          }

          if (attempt < this.retry.maxAttempts && this.retry.retryOn.has(response.status)) {
            const retryDelayMs =
              response.status === 429 && parseRetryAfterHeader(response) !== undefined
                ? (parseRetryAfterHeader(response) ?? 0) * 1000
                : this.retry.backoffMs * 2 ** (attempt - 1);
            await sleep(retryDelayMs);
            continue;
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
        if (error instanceof WebhooksCCError) {
          throw error;
        }

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

          if (attempt < this.retry.maxAttempts) {
            await sleep(this.retry.backoffMs * 2 ** (attempt - 1));
            continue;
          }

          throw timeoutError;
        }

        const isNetworkError = error instanceof Error;
        if (isNetworkError) {
          try {
            this.hooks.onError?.({
              method,
              url,
              error,
              durationMs: Date.now() - start,
            });
          } catch {
            // Hooks must not break the request flow
          }
        }

        if (attempt < this.retry.maxAttempts && isNetworkError) {
          await sleep(this.retry.backoffMs * 2 ** (attempt - 1));
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  /** Returns a static description of all SDK operations (no API call). */
  describe(): SDKDescription {
    return {
      version: SDK_VERSION,
      endpoints: {
        create: {
          description: "Create a webhook endpoint",
          params: {
            name: "string?",
            ephemeral: "boolean?",
            expiresIn: "number|string?",
            mockResponse: "object?",
          },
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
            provider: PROVIDER_PARAM_DESCRIPTION,
            template: "string?",
            secret: "string",
            event: "string?",
          },
        },
      },
      templates: {
        listProviders: {
          description: "List supported template providers",
          params: {},
        },
        get: {
          description: "Get static metadata for a template provider",
          params: {
            provider: PROVIDER_PARAM_DESCRIPTION,
          },
        },
      },
      usage: {
        description: "Get current request usage and remaining quota",
        params: {},
      },
      flow: {
        description: "Create a fluent webhook flow builder for common capture/verify/replay flows",
        params: {},
      },
      sendTo: {
        description: "Send a webhook directly to any URL with optional provider signing",
        params: {
          url: "string",
          provider: `${PROVIDER_PARAM_DESCRIPTION}?`,
          secret: "string?",
          body: "unknown?",
          headers: "Record<string, string>?",
        },
      },
      buildRequest: {
        description:
          "Build a request without sending it — returns computed method, URL, headers, and body including provider signatures",
        params: {
          url: "string",
          provider: `${PROVIDER_PARAM_DESCRIPTION}?`,
          secret: "string?",
          body: "unknown?",
          headers: "Record<string, string>?",
        },
      },
      requests: {
        list: {
          description: "List captured requests",
          params: { endpointSlug: "string", limit: "number?", since: "number?" },
        },
        listPaginated: {
          description: "List captured requests with cursor-based pagination",
          params: { endpointSlug: "string", limit: "number?", cursor: "string?" },
        },
        get: {
          description: "Get request by ID",
          params: { requestId: "string" },
        },
        waitForAll: {
          description: "Poll until multiple matching requests arrive",
          params: {
            endpointSlug: "string",
            count: "number",
            timeout: "number|string?",
            pollInterval: "number|string?",
            match: "function?",
          },
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
          params: {
            slug: "string",
            signal: "AbortSignal?",
            timeout: "number|string?",
            reconnect: "boolean?",
            maxReconnectAttempts: "number?",
            reconnectBackoffMs: "number|string?",
            onReconnect: "function?",
          },
        },
        replay: {
          description: "Replay a captured request to a URL",
          params: { requestId: "string", targetUrl: "string" },
        },
        export: {
          description: "Export captured requests as HAR or cURL commands",
          params: {
            endpointSlug: "string",
            format: '"har"|"curl"',
            limit: "number?",
            since: "number?",
          },
        },
        search: {
          description: "Search retained requests across path, body, and headers",
          params: {
            slug: "string?",
            method: "string?",
            q: "string?",
            from: "number|string?",
            to: "number|string?",
            limit: "number?",
            offset: "number?",
            order: '"asc"|"desc"?',
          },
        },
        count: {
          description: "Count retained requests matching search filters",
          params: {
            slug: "string?",
            method: "string?",
            q: "string?",
            from: "number|string?",
            to: "number|string?",
          },
        },
        clear: {
          description: "Delete captured requests for an endpoint",
          params: {
            endpointSlug: "string",
            before: "number|string?",
          },
        },
      },
    };
  }

  endpoints = {
    create: async (options: CreateEndpointOptions = {}): Promise<Endpoint> => {
      if (options.mockResponse) {
        validateMockResponse(options.mockResponse, "mock response");
      }

      const body: Record<string, unknown> = {};
      if (options.name !== undefined) {
        body.name = options.name;
      }
      if (options.mockResponse !== undefined) {
        body.mockResponse = options.mockResponse;
      }

      const isEphemeral = options.ephemeral === true || options.expiresIn !== undefined;
      if (isEphemeral) {
        body.isEphemeral = true;
      }
      if (options.expiresIn !== undefined) {
        const durationMs = parseDuration(options.expiresIn);
        if (durationMs <= 0) {
          throw new Error("expiresIn must be greater than 0");
        }
        body.expiresAt = Date.now() + durationMs;
      }

      return this.request<Endpoint>("POST", "/endpoints", body);
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
        validateMockResponse(options.mockResponse, "mock response");
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

  templates = {
    listProviders: (): TemplateProvider[] => {
      return [...TEMPLATE_PROVIDERS];
    },

    get: (provider: TemplateProvider): TemplateProviderInfo => {
      return TEMPLATE_METADATA[provider];
    },
  };

  usage = async (): Promise<UsageInfo> => {
    return this.request<UsageInfo>("GET", "/usage");
  };

  flow = (): WebhookFlowBuilder => {
    return new WebhookFlowBuilder(this);
  };

  /**
   * Build a request without sending it. Returns the computed method, URL,
   * headers, and body — including any provider signatures. Useful for
   * debugging what sendTo would actually send.
   *
   * @param url - Target URL (http or https)
   * @param options - Same options as sendTo
   * @returns The computed request details
   */
  buildRequest = async (
    url: string,
    options: SendToOptions = {}
  ): Promise<{ url: string; method: string; headers: Record<string, string>; body?: string }> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: "${url}" is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Invalid URL: only http and https protocols are supported");
    }

    if (options.provider) {
      if (!options.secret || typeof options.secret !== "string") {
        throw new Error("buildRequest with a provider requires a non-empty secret");
      }
      const sendOptions = await buildTemplateSendOptions(url, {
        provider: options.provider,
        template: options.template,
        secret: options.secret,
        event: options.event,
        body: options.body,
        method: options.method,
        headers: options.headers,
        timestamp: options.timestamp,
      });

      return {
        url,
        method: (sendOptions.method ?? "POST").toUpperCase(),
        headers: sendOptions.headers ?? {},
        body:
          sendOptions.body !== undefined
            ? typeof sendOptions.body === "string"
              ? sendOptions.body
              : JSON.stringify(sendOptions.body)
            : undefined,
      };
    }

    // Plain request without provider signing
    const method = (options.method ?? "POST").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(
        `Invalid HTTP method: "${options.method}". Must be one of: ${[...ALLOWED_METHODS].join(", ")}`
      );
    }
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (options.body !== undefined && !hasContentType) {
      headers["Content-Type"] = "application/json";
    }

    return {
      url,
      method,
      headers,
      body:
        options.body !== undefined
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
    };
  };

  /**
   * Send a webhook directly to any URL with optional provider signing.
   * Use this for local integration testing — send properly signed webhooks
   * to localhost handlers without routing through webhooks.cc infrastructure.
   *
   * @param url - Target URL to send the webhook to (http or https)
   * @param options - Method, headers, body, and optional provider signing
   * @returns Raw fetch Response from the target
   */
  sendTo = async (url: string, options: SendToOptions = {}): Promise<Response> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: "${url}" is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Invalid URL: only http and https protocols are supported");
    }

    if (options.provider) {
      if (!options.secret || typeof options.secret !== "string") {
        throw new Error("sendTo with a provider requires a non-empty secret");
      }
      const sendOptions = await buildTemplateSendOptions(url, {
        provider: options.provider,
        template: options.template,
        secret: options.secret,
        event: options.event,
        body: options.body,
        method: options.method,
        headers: options.headers,
        timestamp: options.timestamp,
      });

      const method = (sendOptions.method ?? "POST").toUpperCase();
      return fetch(url, {
        method,
        headers: sendOptions.headers ?? {},
        body:
          sendOptions.body !== undefined
            ? typeof sendOptions.body === "string"
              ? sendOptions.body
              : JSON.stringify(sendOptions.body)
            : undefined,
        signal: AbortSignal.timeout(this.timeout),
      });
    }

    // Plain request without provider signing
    const method = (options.method ?? "POST").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(
        `Invalid HTTP method: "${options.method}". Must be one of: ${[...ALLOWED_METHODS].join(", ")}`
      );
    }
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (options.body !== undefined && !hasContentType) {
      headers["Content-Type"] = "application/json";
    }

    return fetch(url, {
      method,
      headers,
      body:
        options.body !== undefined
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
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

    listPaginated: async (
      endpointSlug: string,
      options: ListPaginatedRequestsOptions = {}
    ): Promise<PaginatedResult<Request>> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      return this.request<PaginatedResult<Request>>(
        "GET",
        `/endpoints/${endpointSlug}/requests/paginated${buildPaginatedListQuery(options)}`
      );
    },

    get: async (requestId: string): Promise<Request> => {
      validatePathSegment(requestId, "requestId");
      return this.request<Request>("GET", `/requests/${requestId}`);
    },

    waitForAll: async (endpointSlug: string, options: WaitForAllOptions): Promise<Request[]> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      const listLimit = Math.min(1000, Math.max(100, Math.floor(options.count) * 2));
      return collectMatchingRequests(
        (since) =>
          this.requests.list(endpointSlug, {
            since,
            limit: listLimit,
          }),
        options
      );
    },

    search: async (filters: SearchFilters = {}): Promise<SearchResult[]> => {
      return this.request<SearchResult[]>(
        "GET",
        `/search/requests${buildSearchQuery(filters, true)}`
      );
    },

    count: async (filters: SearchFilters = {}): Promise<number> => {
      const response = await this.request<{ count: number }>(
        "GET",
        `/search/requests/count${buildSearchQuery(filters, false)}`
      );
      return response.count;
    },

    clear: async (endpointSlug: string, options: ClearRequestsOptions = {}): Promise<void> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      await this.request<{ deleted: number; complete: boolean }>(
        "DELETE",
        `/endpoints/${endpointSlug}/requests${buildClearQuery(options)}`
      );
    },

    export: async (
      endpointSlug: string,
      options: ExportRequestsOptions
    ): Promise<RequestsExport> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      const endpoint = await this.endpoints.get(endpointSlug);
      const endpointUrl = endpoint.url ?? `${this.webhookUrl}/w/${endpoint.slug}`;
      const requests: Request[] = [];
      const pageSize = normalizeExportPageSize(options.limit);
      let cursor: string | undefined;

      while (true) {
        const remaining =
          options.limit !== undefined ? Math.max(0, options.limit - requests.length) : pageSize;
        if (options.limit !== undefined && remaining === 0) {
          break;
        }

        const page = await this.requests.listPaginated(endpointSlug, {
          limit: options.limit !== undefined ? Math.min(pageSize, remaining) : pageSize,
          cursor,
        });

        for (const request of page.items) {
          if (options.since !== undefined && request.receivedAt <= options.since) {
            continue;
          }
          requests.push(request);
          if (options.limit !== undefined && requests.length >= options.limit) {
            break;
          }
        }

        if (!page.hasMore || !page.cursor) {
          break;
        }
        if (options.limit !== undefined && requests.length >= options.limit) {
          break;
        }
        cursor = page.cursor;
      }

      if (options.format === "curl") {
        return buildCurlExport(endpointUrl, requests);
      }
      return buildHarExport(endpointUrl, requests, SDK_VERSION);
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
      const [request] = await this.requests.waitForAll(endpointSlug, {
        ...options,
        count: 1,
      });
      return request;
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
     * Reconnection is opt-in and resumes from the last yielded request timestamp.
     */
    subscribe: (slug: string, options: SubscribeOptions = {}): AsyncIterable<Request> => {
      validatePathSegment(slug, "slug");
      const { signal, timeout, reconnect = false, onReconnect } = options;
      const baseUrl = this.baseUrl;
      const apiKey = this.apiKey;
      const timeoutMs = timeout !== undefined ? parseDuration(timeout) : undefined;
      const maxReconnectAttempts = Math.max(0, Math.floor(options.maxReconnectAttempts ?? 5));
      const reconnectBackoffMs = normalizeReconnectBackoff(options.reconnectBackoffMs);

      return {
        [Symbol.asyncIterator](): AsyncIterableIterator<Request> {
          const controller = new AbortController();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let iterator: AsyncGenerator<{ event: string; data: string }> | null = null;
          let started = false;
          let reconnectAttempts = 0;
          let lastReceivedAt: number | undefined;
          const seenRequestIds = new Set<string>();

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
            const url = `${baseUrl}${buildStreamPath(
              slug,
              lastReceivedAt !== undefined ? lastReceivedAt - 1 : undefined
            )}`;
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
              const text = await response.text();
              throw mapStatusToError(response.status, text, response);
            }

            if (!response.body) {
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

          const reconnectStream = async (): Promise<boolean> => {
            if (
              !reconnect ||
              reconnectAttempts >= maxReconnectAttempts ||
              controller.signal.aborted
            ) {
              cleanup();
              return false;
            }

            reconnectAttempts++;
            try {
              onReconnect?.(reconnectAttempts);
            } catch {
              // Hooks must not break the subscription flow
            }

            await sleep(reconnectBackoffMs * 2 ** (reconnectAttempts - 1));
            if (controller.signal.aborted) {
              cleanup();
              return false;
            }
            iterator = await start();
            return true;
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
                    iterator = null;
                    if (await reconnectStream()) {
                      continue;
                    }
                    return { done: true, value: undefined };
                  }

                  reconnectAttempts = 0;

                  // Only yield actual request events
                  if (value.event === "request") {
                    const req = parseStreamRequest(value.data);
                    if (!req) {
                      continue;
                    }
                    if (req.id && seenRequestIds.has(req.id)) {
                      continue;
                    }
                    if (req.id) {
                      seenRequestIds.add(req.id);
                    }
                    lastReceivedAt = req.receivedAt;
                    return { done: false, value: req };
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
                // AbortError means the consumer broke out or signal was aborted — that's normal
                if (error instanceof Error && error.name === "AbortError") {
                  cleanup();
                  controller.abort();
                  return { done: true, value: undefined };
                }
                iterator = null;
                if (shouldReconnectStreamError(error) && (await reconnectStream())) {
                  return this.next();
                }
                cleanup();
                controller.abort();
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
