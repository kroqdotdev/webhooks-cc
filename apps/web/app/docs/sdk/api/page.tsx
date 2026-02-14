import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "SDK API Reference Docs",
  description: "Complete API reference for the webhooks.cc TypeScript SDK.",
  path: "/docs/sdk/api",
});

interface MethodDef {
  name: string;
  description: string;
  signature: string;
  params?: { name: string; type: string; description: string }[];
  returns: string;
}

const METHODS: { section: string; methods: MethodDef[] }[] = [
  {
    section: "Endpoints",
    methods: [
      {
        name: "client.endpoints.create",
        description: "Create a new webhook endpoint. The slug is auto-generated.",
        signature: "create(options?: CreateEndpointOptions): Promise<Endpoint>",
        params: [{ name: "name", type: "string?", description: "Display name" }],
        returns: "Endpoint object with id, url, slug, and name",
      },
      {
        name: "client.endpoints.list",
        description: "List all endpoints for your account.",
        signature: "list(): Promise<Endpoint[]>",
        returns: "Array of Endpoint objects",
      },
      {
        name: "client.endpoints.get",
        description: "Get a single endpoint by slug.",
        signature: "get(slug: string): Promise<Endpoint>",
        returns: "Endpoint object",
      },
      {
        name: "client.endpoints.update",
        description: "Update an endpoint's name or mock response configuration.",
        signature: "update(slug: string, options: UpdateEndpointOptions): Promise<Endpoint>",
        params: [
          { name: "slug", type: "string", description: "Endpoint slug" },
          { name: "name", type: "string?", description: "New display name" },
          {
            name: "mockResponse",
            type: "object | null?",
            description: "Mock response config { status, body, headers }, or null to clear",
          },
        ],
        returns: "Updated Endpoint object",
      },
      {
        name: "client.endpoints.delete",
        description: "Delete an endpoint and all its captured requests.",
        signature: "delete(slug: string): Promise<void>",
        returns: "void",
      },
      {
        name: "client.endpoints.send",
        description:
          "Send a test webhook to an endpoint. Sends directly to the receiver, does not go through the API.",
        signature: "send(slug: string, options?: SendOptions): Promise<Response>",
        params: [
          { name: "slug", type: "string", description: "Endpoint slug" },
          { name: "method", type: "string?", description: 'HTTP method (default: "POST")' },
          { name: "headers", type: "Record?", description: "HTTP headers to include" },
          { name: "body", type: "unknown?", description: "Request body (JSON-serialized)" },
        ],
        returns: "Raw fetch Response from the receiver",
      },
    ],
  },
  {
    section: "Requests",
    methods: [
      {
        name: "client.requests.list",
        description: "List captured requests for an endpoint.",
        signature: "list(endpointSlug: string, options?: ListRequestsOptions): Promise<Request[]>",
        params: [
          { name: "endpointSlug", type: "string", description: "Endpoint slug" },
          { name: "limit", type: "number?", description: "Max results (default: 50)" },
          {
            name: "since",
            type: "number?",
            description: "Only return requests after this timestamp (ms)",
          },
        ],
        returns: "Array of Request objects",
      },
      {
        name: "client.requests.get",
        description: "Get a single captured request by ID.",
        signature: "get(requestId: string): Promise<Request>",
        returns: "Request object with method, headers, body, queryParams, etc.",
      },
      {
        name: "client.requests.waitFor",
        description:
          "Poll for incoming requests until one matches or timeout expires. Accepts human-readable duration strings.",
        signature: "waitFor(endpointSlug: string, options?: WaitForOptions): Promise<Request>",
        params: [
          { name: "endpointSlug", type: "string", description: "Endpoint slug to monitor" },
          {
            name: "timeout",
            type: "number | string?",
            description: 'Max wait time — ms or "30s", "5m", "1h" (default: 30000)',
          },
          {
            name: "pollInterval",
            type: "number | string?",
            description: "Interval between polls (default: 500)",
          },
          {
            name: "match",
            type: "function?",
            description: "Filter function: (request) => boolean",
          },
        ],
        returns: "First matching Request, or first request if no match filter",
      },
      {
        name: "client.requests.subscribe",
        description:
          "Stream incoming requests via SSE as an async iterator. No automatic reconnection.",
        signature: "subscribe(slug: string, options?: SubscribeOptions): AsyncIterable<Request>",
        params: [
          { name: "slug", type: "string", description: "Endpoint slug" },
          {
            name: "signal",
            type: "AbortSignal?",
            description: "Signal to cancel the subscription",
          },
          {
            name: "timeout",
            type: "number | string?",
            description: "Max stream duration",
          },
        ],
        returns: "AsyncIterable of Request objects",
      },
      {
        name: "client.requests.replay",
        description:
          "Replay a captured request to a target URL. Sends the original method, headers, and body. Hop-by-hop headers are stripped.",
        signature: "replay(requestId: string, targetUrl: string): Promise<Response>",
        params: [
          { name: "requestId", type: "string", description: "ID of the captured request" },
          {
            name: "targetUrl",
            type: "string",
            description: "URL to send the replayed request to",
          },
        ],
        returns: "Raw fetch Response from the target",
      },
    ],
  },
  {
    section: "Introspection",
    methods: [
      {
        name: "client.describe",
        description:
          "Returns a static description of all SDK operations and their parameters. No API call is made. Useful for AI agents and tool discovery.",
        signature: "describe(): SDKDescription",
        returns: "Object with version, endpoints (6 operations), and requests (5 operations)",
      },
    ],
  },
];

export default function ApiReferencePage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">API Reference</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Complete method reference for the webhooks.cc TypeScript SDK.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Constructor</h2>
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({
  apiKey: string,        // Required. Your API key.
  baseUrl?: string,      // Optional. Override API base URL.
  webhookUrl?: string,   // Optional. Override webhook receiver URL.
  timeout?: number,      // Optional. Request timeout in ms (default: 30000).
  hooks?: ClientHooks,   // Optional. Lifecycle hooks for observability.
});`}</pre>
      </section>

      {METHODS.map((group) => (
        <section key={group.section} className="mb-10">
          <h2 className="text-xl font-bold mb-6">{group.section}</h2>
          <div className="space-y-8">
            {group.methods.map((method) => (
              <div key={method.name}>
                <h3 className="text-lg font-bold mb-2">
                  <code className="font-mono">{method.name}</code>
                </h3>
                <p className="text-muted-foreground mb-3">{method.description}</p>
                <pre className="neo-code text-sm mb-3">{method.signature}</pre>
                {method.params && (
                  <div className="neo-code text-sm overflow-x-auto mb-3">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-foreground/20">
                          <th className="text-left py-1.5 pr-3 font-bold">Param</th>
                          <th className="text-left py-1.5 pr-3 font-bold">Type</th>
                          <th className="text-left py-1.5 font-bold">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {method.params.map((p) => (
                          <tr key={p.name} className="border-b border-foreground/20 last:border-0">
                            <td className="py-1.5 pr-3">
                              <code>{p.name}</code>
                            </td>
                            <td className="py-1.5 pr-3 text-muted-foreground">
                              <code>{p.type}</code>
                            </td>
                            <td className="py-1.5 text-muted-foreground">{p.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-sm text-muted-foreground">
                  <strong className="text-foreground">Returns:</strong> {method.returns}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Matchers</h2>
        <p className="text-muted-foreground mb-4">
          Composable functions that return{" "}
          <code className="font-mono font-bold">(request) =&gt; boolean</code>. Use with{" "}
          <code className="font-mono font-bold">waitFor</code> or filter logic.
        </p>
        <pre className="neo-code text-sm">{`import {
  matchMethod,
  matchHeader,
  matchBodyPath,
  matchJsonField,
  matchAll,
  matchAny,
} from "@webhooks-cc/sdk";

matchMethod("POST")                         // match by HTTP method
matchHeader("x-github-event")               // match header presence
matchHeader("x-github-event", "push")       // match header value
matchBodyPath("data.object.id", "obj_123")  // match nested JSON path
matchJsonField("type", "checkout")           // match top-level JSON field
matchAll(matchMethod("POST"), matchHeader("stripe-signature"))
matchAny(matchMethod("GET"), matchMethod("POST"))`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Provider Detection</h2>
        <p className="text-muted-foreground mb-4">
          Each helper checks for a provider-specific header (case-insensitive).
        </p>
        <pre className="neo-code text-sm">{`import {
  isStripeWebhook,    // stripe-signature
  isGitHubWebhook,    // x-github-event
  isShopifyWebhook,   // x-shopify-hmac-sha256
  isSlackWebhook,     // x-slack-signature
  isTwilioWebhook,    // x-twilio-signature
  isPaddleWebhook,    // paddle-signature
  isLinearWebhook,    // linear-signature
} from "@webhooks-cc/sdk";`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Duration Strings</h2>
        <p className="text-muted-foreground mb-4">
          <code className="font-mono font-bold">timeout</code> and{" "}
          <code className="font-mono font-bold">pollInterval</code> accept human-readable strings
          alongside milliseconds.
        </p>
        <pre className="neo-code text-sm">{`"500ms"  →    500
"30s"    →  30000
"5m"     → 300000
"1h"     → 3600000
500      →    500    // numbers passed through`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Types</h2>
        <pre className="neo-code text-sm">{`interface Endpoint {
  id: string;
  slug: string;
  name?: string;
  url?: string;
  createdAt: number;
}

interface Request {
  id: string;
  endpointId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  queryParams: Record<string, string>;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
}

interface UpdateEndpointOptions {
  name?: string;
  mockResponse?: {
    status: number;
    body: string;
    headers: Record<string, string>;
  } | null;
}

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface WaitForOptions {
  timeout?: number | string;
  pollInterval?: number | string;
  match?: (request: Request) => boolean;
}

interface CreateEndpointOptions {
  name?: string;
}

interface ListRequestsOptions {
  limit?: number;
  since?: number;
}

interface SubscribeOptions {
  signal?: AbortSignal;
  timeout?: number | string;
}`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Error Classes</h2>
        <p className="text-muted-foreground mb-4">
          Errors include actionable recovery hints when the server message is generic.
        </p>
        <pre className="neo-code text-sm">{`import {
  WebhooksCCError,   // Base error (has statusCode)
  UnauthorizedError, // 401 — includes link to get API key
  NotFoundError,     // 404 — suggests using endpoints.list()
  RateLimitError,    // 429 — includes retryAfter seconds
  TimeoutError,      // Request timeout
} from "@webhooks-cc/sdk";`}</pre>
      </section>
    </article>
  );
}
