/**
 * @fileoverview webhooks.cc SDK client for programmatic webhook management.
 *
 * @example
 * ```typescript
 * const client = new WebhooksCC({ apiKey: 'whcc_...' });
 * const endpoint = await client.endpoints.create({ name: 'My Webhook' });
 * const request = await client.requests.waitFor(endpoint.slug, {
 *   timeout: 10000,
 *   match: (r) => r.method === 'POST'
 * });
 * ```
 */
import type {
  ClientOptions,
  Endpoint,
  Request,
  CreateEndpointOptions,
  ListRequestsOptions,
  WaitForOptions,
} from "./types";

const DEFAULT_BASE_URL = "https://webhooks.cc";
const DEFAULT_TIMEOUT = 30000;

// Poll interval bounds: 10ms minimum prevents busy loops, 60s maximum prevents stale connections
const MIN_POLL_INTERVAL = 10;
const MAX_POLL_INTERVAL = 60000;

/**
 * Error thrown when an API request fails with a specific HTTP status code.
 * Allows callers to distinguish between different error types.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(`API error (${statusCode}): ${message}`);
    this.name = "ApiError";
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
  private readonly timeout: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        // Truncate error to prevent potential sensitive data leakage in logs
        const sanitizedError = error.length > 200 ? error.slice(0, 200) + "..." : error;
        throw new ApiError(response.status, sanitizedError);
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
        throw new Error(`Request timed out after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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

    delete: async (slug: string): Promise<void> => {
      validatePathSegment(slug, "slug");
      await this.request("DELETE", `/endpoints/${slug}`);
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
      const { timeout = 30000, pollInterval = 500, match } = options;
      // Clamp pollInterval to safe bounds
      const safePollInterval = Math.max(
        MIN_POLL_INTERVAL,
        Math.min(MAX_POLL_INTERVAL, pollInterval)
      );
      const start = Date.now();
      let lastChecked = 0;
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
          if (error instanceof ApiError) {
            if (error.statusCode === 401) {
              throw new Error("Authentication failed: invalid or expired API key");
            }
            if (error.statusCode === 403) {
              throw new Error("Access denied: insufficient permissions for this endpoint");
            }
            if (error.statusCode === 404) {
              throw new Error(`Endpoint "${endpointSlug}" not found`);
            }
            // Continue polling only for transient errors (5xx)
            if (error.statusCode < 500) {
              throw error;
            }
          }
          // Continue polling for transient errors (network issues, 5xx) without updating lastChecked
          // to avoid missing requests during temporary issues
        }

        await sleep(safePollInterval);
      }

      if (iterations >= MAX_ITERATIONS) {
        throw new Error(`Max iterations (${MAX_ITERATIONS}) reached while waiting for request`);
      }
      throw new Error(`Timeout waiting for request after ${timeout}ms`);
    },
  };
}

/** Returns a promise that resolves after the specified milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
