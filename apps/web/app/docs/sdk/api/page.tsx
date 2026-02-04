import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Reference - webhooks.cc Docs",
  description: "Complete API reference for the webhooks.cc TypeScript SDK.",
};

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
        params: [
          { name: "name", type: "string?", description: "Display name" },
          {
            name: "mockResponse",
            type: "MockResponse?",
            description: "Custom response configuration",
          },
        ],
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
        name: "client.endpoints.delete",
        description: "Delete an endpoint and all its captured requests.",
        signature: "delete(slug: string): Promise<void>",
        returns: "void",
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
        description: "Poll for incoming requests until one matches or timeout expires.",
        signature: "waitFor(endpointSlug: string, options?: WaitForOptions): Promise<Request>",
        params: [
          { name: "endpointSlug", type: "string", description: "Endpoint slug to monitor" },
          { name: "timeout", type: "number?", description: "Max wait time in ms (default: 30000)" },
          {
            name: "pollInterval",
            type: "number?",
            description: "Interval between polls in ms (default: 500)",
          },
          {
            name: "match",
            type: "function?",
            description: "Filter function: (request) => boolean",
          },
        ],
        returns: "First matching Request, or first request if no match filter",
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
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhookscc/sdk";

const client = new WebhooksCC({
  apiKey: string,     // Required. Your API key.
  baseUrl?: string,   // Optional. Override API base URL.
  timeout?: number,   // Optional. Request timeout in ms (default: 30000).
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
        <h2 className="text-xl font-bold mb-3">Types</h2>
        <pre className="neo-code text-sm">{`interface Endpoint {
  id: string;
  slug: string;
  name?: string;
  url: string;
  createdAt: number;
}

interface CreateEndpointOptions {
  name?: string;
  mockResponse?: MockResponse;
}

interface MockResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
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

interface WaitForOptions {
  timeout?: number;      // default: 30000
  pollInterval?: number; // default: 500
  match?: (request: Request) => boolean;
}`}</pre>
      </section>
    </article>
  );
}
