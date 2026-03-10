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
  /** Whether the endpoint auto-expires and may be cleaned up automatically */
  isEphemeral?: boolean;
  /** Unix timestamp (ms) when the endpoint expires, if ephemeral */
  expiresAt?: number;
  /** Unix timestamp (ms) when the endpoint was created */
  createdAt: number;
}

/** Mock response returned by the receiver instead of the default 200 OK. */
export interface MockResponse {
  /** HTTP status code (100-599) */
  status: number;
  /** Raw response body */
  body: string;
  /** Response headers */
  headers: Record<string, string>;
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
 * A retained request returned from ClickHouse-backed search.
 * The id is synthetic and is not compatible with requests.get()/replay().
 */
export interface SearchResult {
  /** Synthetic identifier derived from retained request contents */
  id: string;
  /** Endpoint slug that received this request */
  slug: string;
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

/** User-level request usage and quota information. */
export interface UsageInfo {
  /** Requests consumed in the current billing window */
  used: number;
  /** Total request quota for the current billing window */
  limit: number;
  /** Remaining requests before quota is exhausted */
  remaining: number;
  /** Current subscription plan */
  plan: "free" | "pro";
  /** End of the current billing window, if active */
  periodEnd: number | null;
}

/**
 * Options for creating a new endpoint.
 */
export interface CreateEndpointOptions {
  /** Display name for the endpoint */
  name?: string;
  /** Whether the endpoint should auto-expire */
  ephemeral?: boolean;
  /** Relative expiry duration like "12h" or "7d"; implies ephemeral */
  expiresIn?: number | string;
  /** Optional mock response to configure at creation time */
  mockResponse?: MockResponse;
}

/**
 * Options for updating an existing endpoint.
 */
export interface UpdateEndpointOptions {
  /** New display name */
  name?: string;
  /** Mock response config, or null to clear */
  mockResponse?: MockResponse | null;
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

export type TemplateProvider =
  | "stripe"
  | "github"
  | "shopify"
  | "twilio"
  | "slack"
  | "paddle"
  | "linear"
  | "standard-webhooks";

/** Static metadata describing a supported template provider. */
export interface TemplateProviderInfo {
  /** Provider identifier used by sendTemplate()/sendTo() */
  provider: TemplateProvider;
  /** Supported provider-specific template presets */
  templates: readonly string[];
  /** Default template preset used when template is omitted */
  defaultTemplate?: string;
  /** Whether this provider requires a shared secret for signing */
  secretRequired: boolean;
  /** Header that carries the provider signature */
  signatureHeader?: string;
  /** Signature algorithm used for request signing */
  signatureAlgorithm?: string;
}

/**
 * Options for sending a provider template webhook with signed headers.
 */
export interface SendTemplateOptions {
  /** Provider template to use */
  provider: TemplateProvider;
  /** Provider-specific template preset (uses provider default if omitted) */
  template?: string;
  /** Shared secret used for provider signature generation */
  secret: string;
  /** Provider event/topic name (provider default used if omitted) */
  event?: string;
  /** HTTP method override (default: "POST") */
  method?: string;
  /** Additional headers merged after template headers */
  headers?: Record<string, string>;
  /** Body override; if omitted a provider-specific template body is generated */
  body?: unknown;
  /** Unix timestamp (seconds) override for deterministic signatures in tests */
  timestamp?: number;
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

/** Cursor-based paginated result. */
export interface PaginatedResult<T> {
  /** Page items for this fetch */
  items: T[];
  /** Cursor to pass to the next page fetch */
  cursor?: string;
  /** Whether another page is available */
  hasMore: boolean;
}

/** Options for cursor-based request pagination. */
export interface ListPaginatedRequestsOptions {
  /** Maximum number of requests to return */
  limit?: number;
  /** Opaque cursor from a previous page */
  cursor?: string;
}

/**
 * Options for clearing captured requests from an endpoint.
 */
export interface ClearRequestsOptions {
  /** Only delete requests received before this timestamp (ms) or relative duration */
  before?: number | string;
}

/**
 * Filters for retained request search/count.
 * String timestamps may be absolute milliseconds ("1700000000000") or relative durations ("1h", "7d").
 */
export interface SearchFilters {
  /** Restrict results to a single endpoint slug */
  slug?: string;
  /** Restrict results to a specific HTTP method */
  method?: string;
  /** Free-text substring search across path, body, and headers */
  q?: string;
  /** Lower bound for receivedAt (absolute ms or relative duration) */
  from?: number | string;
  /** Upper bound for receivedAt (absolute ms or relative duration) */
  to?: number | string;
  /** Maximum number of results to return */
  limit?: number;
  /** Result offset for pagination */
  offset?: number;
  /** Result ordering by receivedAt */
  order?: "asc" | "desc";
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

/** Options for waitForAll() multi-request collection. */
export interface WaitForAllOptions extends WaitForOptions {
  /** Number of matching requests to collect before returning */
  count: number;
}

/**
 * Options for subscribe() SSE streaming.
 */
export interface SubscribeOptions {
  /** AbortSignal to cancel the subscription */
  signal?: AbortSignal;
  /** Maximum time to stream (ms or duration string like "30m") */
  timeout?: number | string;
  /** Automatically reconnect when the SSE stream ends unexpectedly */
  reconnect?: boolean;
  /** Maximum reconnect attempts before giving up (default: 5) */
  maxReconnectAttempts?: number;
  /** Base backoff delay between reconnects */
  reconnectBackoffMs?: number | string;
  /** Callback invoked before each reconnect attempt */
  onReconnect?: (attempt: number) => void;
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

/** Retry configuration for transient API failures. */
export interface RetryOptions {
  /** Total attempts including the initial request */
  maxAttempts?: number;
  /** Base backoff delay in milliseconds */
  backoffMs?: number;
  /** HTTP status codes that should be retried */
  retryOn?: number[];
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
  /** Retry policy for transient API failures */
  retry?: RetryOptions;
  /** Lifecycle hooks for observability */
  hooks?: ClientHooks;
}

/** Description of a single SDK operation. */
export interface OperationDescription {
  description: string;
  params: Record<string, string>;
}

/**
 * Options for sending a webhook directly to an arbitrary URL.
 * Supports optional provider signing (Standard Webhooks, Stripe, etc.).
 */
export interface SendToOptions {
  /** Provider template for signing (optional). When set, secret is required. */
  provider?: TemplateProvider;
  /** Provider-specific template preset (e.g. "checkout.session.completed" for Stripe) */
  template?: string;
  /** Secret for provider signature generation (required when provider is set) */
  secret?: string;
  /** Event name for provider headers */
  event?: string;
  /** HTTP method (default: "POST") */
  method?: string;
  /** HTTP headers to include */
  headers?: Record<string, string>;
  /** Request body (will be JSON-serialized if not a string) */
  body?: unknown;
  /** Unix timestamp (seconds) override for deterministic signatures in tests */
  timestamp?: number;
}

/** Result returned by verifySignature(). */
export interface SignatureVerificationResult {
  /** Whether the computed signature matched the provided signature header(s) */
  valid: boolean;
}

/** Providers supported by verifySignature(). */
export type VerifyProvider = TemplateProvider | "discord";

/**
 * Options for verifying a captured webhook signature.
 * For Twilio, `url` is required because the signature covers the full webhook URL.
 */
export type VerifySignatureOptions =
  | {
      /** Provider whose signature format should be verified */
      provider: Exclude<VerifyProvider, "discord">;
      /** Shared secret used by the provider when signing the webhook */
      secret: string;
      /** Full signed URL (required for Twilio verification) */
      url?: string;
    }
  | {
      /** Discord interaction verification */
      provider: "discord";
      /** Discord application public key (hex) */
      publicKey: string;
    };

/** Value type returned when parsing form-encoded request bodies. */
export type FormBodyValue = string | string[];

/** Parsed application/x-www-form-urlencoded body. */
export type ParsedFormBody = Record<string, FormBodyValue>;

/** Result from parseBody() based on content-type detection. */
export type ParsedBody = unknown | ParsedFormBody | string | undefined;

/** Options for bulk request export. */
export interface ExportRequestsOptions {
  /** Output format */
  format: "har" | "curl";
  /** Maximum number of requests to export */
  limit?: number;
  /** Only include requests received after this timestamp (ms) */
  since?: number;
}

/** HAR header entry. */
export interface HarHeader {
  name: string;
  value: string;
}

/** HAR query parameter entry. */
export interface HarQueryParam {
  name: string;
  value: string;
}

/** HAR request body metadata. */
export interface HarPostData {
  mimeType: string;
  text: string;
}

/** HAR request object. */
export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarQueryParam[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData;
}

/** HAR response object. */
export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  cookies: [];
  content: {
    size: number;
    mimeType: string;
    text?: string;
  };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

/** HAR entry for a captured request. */
export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
}

/** HAR export archive. */
export interface HarExport {
  log: {
    version: "1.2";
    creator: {
      name: string;
      version: string;
    };
    entries: HarEntry[];
  };
}

/** cURL export output. */
export type CurlExport = string[];

/** Union returned by requests.export(). */
export type RequestsExport = HarExport | CurlExport;

/** Self-describing schema returned by client.describe(). */
export interface SDKDescription {
  version: string;
  endpoints: Record<string, OperationDescription>;
  templates: Record<string, OperationDescription>;
  usage: OperationDescription;
  sendTo: OperationDescription;
  buildRequest: OperationDescription;
  flow: OperationDescription;
  requests: Record<string, OperationDescription>;
}
