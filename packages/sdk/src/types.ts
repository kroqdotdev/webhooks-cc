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
 * Options for updating an existing endpoint.
 */
export interface UpdateEndpointOptions {
  /** New display name */
  name?: string;
  /** Mock response config, or null to clear */
  mockResponse?: { status: number; body: string; headers: Record<string, string> } | null;
}

/**
 * Options for sending a test webhook to an endpoint.
 */
export interface SendOptions {
  /** HTTP method (default: "POST") */
  method?: string;
  /** HTTP headers to include */
  headers?: Record<string, string>;
  /** Request body (will be JSON-serialized if not a string) */
  body?: unknown;
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
  /** Maximum time to wait (ms or duration string like "30s", "5m") (default: 30000) */
  timeout?: number | string;
  /** Interval between polls (ms or duration string) (default: 500, min: 10, max: 60000) */
  pollInterval?: number | string;
  /** Filter function to match specific requests */
  match?: (request: Request) => boolean;
}

/**
 * Options for subscribe() SSE streaming.
 */
export interface SubscribeOptions {
  /** AbortSignal to cancel the subscription */
  signal?: AbortSignal;
  /** Maximum time to stream (ms or duration string like "30m") */
  timeout?: number | string;
}

/** Info passed to the onRequest hook before a request is sent. */
export interface RequestHookInfo {
  method: string;
  url: string;
}

/** Info passed to the onResponse hook after a successful response. */
export interface ResponseHookInfo {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

/** Info passed to the onError hook when a request fails. */
export interface ErrorHookInfo {
  method: string;
  url: string;
  error: Error;
  durationMs: number;
}

/**
 * Lifecycle hooks for observability and telemetry integration.
 * All hooks are optional and are called synchronously (fire-and-forget).
 */
export interface ClientHooks {
  onRequest?: (info: RequestHookInfo) => void;
  onResponse?: (info: ResponseHookInfo) => void;
  onError?: (info: ErrorHookInfo) => void;
}

/**
 * Configuration options for the WebhooksCC client.
 */
export interface ClientOptions {
  /** API key for authentication (format: whcc_...) */
  apiKey: string;
  /** Base URL for the API (default: https://webhooks.cc) */
  baseUrl?: string;
  /** Base URL for sending webhooks (default: https://go.webhooks.cc) */
  webhookUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Lifecycle hooks for observability */
  hooks?: ClientHooks;
}

/** Description of a single SDK operation. */
export interface OperationDescription {
  description: string;
  params: Record<string, string>;
}

/** Self-describing schema returned by client.describe(). */
export interface SDKDescription {
  version: string;
  endpoints: Record<string, OperationDescription>;
  requests: Record<string, OperationDescription>;
}
