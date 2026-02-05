/**
 * A webhook endpoint that captures incoming HTTP requests.
 * Create endpoints via the dashboard or SDK to receive webhooks.
 */
export interface Endpoint {
  /** Unique identifier for this endpoint */
  id: string;
  /** URL-safe identifier used in webhook URLs (/w/{slug}) */
  slug: string;
  /** Display name for the endpoint */
  name?: string;
  /** Full URL where webhooks should be sent (undefined if server is misconfigured) */
  url?: string;
  /** Unix timestamp (ms) when the endpoint was created */
  createdAt: number;
}

/**
 * A captured webhook request with full HTTP details.
 * Stored when a webhook arrives at an endpoint.
 */
export interface Request {
  /** Unique identifier for this request */
  id: string;
  /** Endpoint that received this request */
  endpointId: string;
  /** HTTP method (GET, POST, PUT, etc.) */
  method: string;
  /** Request path after the endpoint slug */
  path: string;
  /** HTTP headers from the original request */
  headers: Record<string, string>;
  /** Request body, if present */
  body?: string;
  /** URL query parameters */
  queryParams: Record<string, string>;
  /** Content-Type header value, if present */
  contentType?: string;
  /** Client IP address */
  ip: string;
  /** Request body size in bytes */
  size: number;
  /** Unix timestamp (ms) when the request arrived */
  receivedAt: number;
}

/**
 * Options for creating a new endpoint.
 */
export interface CreateEndpointOptions {
  /** Display name for the endpoint */
  name?: string;
}

/**
 * Options for listing captured requests.
 */
export interface ListRequestsOptions {
  /** Maximum number of requests to return */
  limit?: number;
  /** Only return requests received after this timestamp (ms) */
  since?: number;
}

/**
 * Options for waitFor() polling behavior.
 */
export interface WaitForOptions {
  /** Maximum time to wait in milliseconds (default: 30000) */
  timeout?: number;
  /** Interval between polls in milliseconds (default: 500, min: 10, max: 60000) */
  pollInterval?: number;
  /** Filter function to match specific requests */
  match?: (request: Request) => boolean;
}

/**
 * Configuration options for the WebhooksCC client.
 */
export interface ClientOptions {
  /** API key for authentication (format: whcc_...) */
  apiKey: string;
  /** Base URL for the API (default: https://webhooks.cc) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}
