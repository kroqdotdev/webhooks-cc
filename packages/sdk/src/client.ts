import type {
  ClientOptions,
  Endpoint,
  Request,
  CreateEndpointOptions,
  ListRequestsOptions,
  WaitForOptions,
} from "./types";

const DEFAULT_BASE_URL = "https://webhooks.cc";

export class WebhooksCC {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  endpoints = {
    create: async (options: CreateEndpointOptions = {}): Promise<Endpoint> => {
      return this.request<Endpoint>("POST", "/endpoints", options);
    },

    list: async (): Promise<Endpoint[]> => {
      return this.request<Endpoint[]>("GET", "/endpoints");
    },

    get: async (slug: string): Promise<Endpoint> => {
      return this.request<Endpoint>("GET", `/endpoints/${slug}`);
    },

    delete: async (slug: string): Promise<void> => {
      await this.request("DELETE", `/endpoints/${slug}`);
    },
  };

  requests = {
    list: async (
      endpointSlug: string,
      options: ListRequestsOptions = {}
    ): Promise<Request[]> => {
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
      return this.request<Request>("GET", `/requests/${requestId}`);
    },

    waitFor: async (
      endpointSlug: string,
      options: WaitForOptions = {}
    ): Promise<Request> => {
      const { timeout = 30000, pollInterval = 500, match } = options;
      const start = Date.now();
      let lastChecked = 0;

      while (Date.now() - start < timeout) {
        const requests = await this.requests.list(endpointSlug, {
          since: lastChecked,
          limit: 100,
        });

        lastChecked = Date.now();

        const matched = match ? requests.find(match) : requests[0];
        if (matched) {
          return matched;
        }

        await sleep(pollInterval);
      }

      throw new Error(`Timeout waiting for request after ${timeout}ms`);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
