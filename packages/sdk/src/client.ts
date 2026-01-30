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

// Poll interval bounds to prevent DoS via busy loops or excessive delays
const MIN_POLL_INTERVAL = 10; // ms - prevent busy loops
const MAX_POLL_INTERVAL = 60000; // ms - 1 minute max

// Validates that a slug/ID contains only safe characters to prevent path traversal
const SAFE_PATH_SEGMENT_REGEX = /^[a-zA-Z0-9_-]+$/;

function validatePathSegment(segment: string, name: string): void {
  if (!SAFE_PATH_SEGMENT_REGEX.test(segment)) {
    throw new Error(
      `Invalid ${name}: must contain only alphanumeric characters, hyphens, and underscores`
    );
  }
}

export class WebhooksCC {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

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
        throw new Error(`API error (${response.status}): ${error}`);
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
      if (options.limit) params.set("limit", String(options.limit));
      if (options.since) params.set("since", String(options.since));

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

    waitFor: async (endpointSlug: string, options: WaitForOptions = {}): Promise<Request> => {
      validatePathSegment(endpointSlug, "endpointSlug");
      const { timeout = 30000, pollInterval = 500, match } = options;
      // Clamp pollInterval to safe bounds to prevent DoS via busy loops (0/negative) or excessive delays
      const safePollInterval = Math.max(
        MIN_POLL_INTERVAL,
        Math.min(MAX_POLL_INTERVAL, pollInterval)
      );
      const start = Date.now();
      let lastChecked = 0;
      // Maximum iterations to prevent unbounded resource consumption
      const MAX_ITERATIONS = 10000;
      let iterations = 0;

      while (Date.now() - start < timeout && iterations < MAX_ITERATIONS) {
        iterations++;
        const checkTime = Date.now(); // Capture before the request

        try {
          const requests = await this.requests.list(endpointSlug, {
            since: lastChecked,
            limit: 100,
          });

          lastChecked = checkTime; // Only update on success

          const matched = match ? requests.find(match) : requests[0];
          if (matched) {
            return matched;
          }
        } catch {
          // Don't update lastChecked on failure, but continue polling
          // This ensures we don't miss requests if the API call fails temporarily
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
