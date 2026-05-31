import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NotFoundError, RateLimitError, type Request, type WebhooksCC } from "@webhooks-cc/sdk";
import { registerTools } from "../tools";

const EXPECTED_TOOLS = [
  "create_endpoint",
  "list_endpoints",
  "get_endpoint",
  "update_endpoint",
  "delete_endpoint",
  "create_endpoints",
  "delete_endpoints",
  "send_webhook",
  "list_requests",
  "search_requests",
  "count_requests",
  "get_request",
  "wait_for_request",
  "wait_for_requests",
  "replay_request",
  "compare_requests",
  "extract_from_request",
  "verify_signature",
  "clear_requests",
  "send_to",
  "preview_webhook",
  "list_provider_templates",
  "get_usage",
  "test_webhook_flow",
  "describe",
];

type RegisteredTool = {
  description: string;
  schema: unknown;
  handler: (
    args: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "req_123",
    endpointId: "ep_123",
    method: "POST",
    path: "/webhooks/github",
    headers: { "content-type": "application/json" },
    body: '{"marker":"left","data":{"object":{"id":"a"}}}',
    queryParams: {},
    contentType: "application/json",
    ip: "127.0.0.1",
    size: 42,
    receivedAt: 1700000000000,
    ...overrides,
  };
}

function createMockClient(overrides: Partial<WebhooksCC> = {}): WebhooksCC {
  return {
    endpoints: {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      send: vi.fn(),
      sendTemplate: vi.fn(),
      ...(overrides.endpoints ?? {}),
    },
    requests: {
      list: vi.fn(),
      listPaginated: vi.fn(),
      get: vi.fn(),
      waitFor: vi.fn(),
      waitForAll: vi.fn(),
      subscribe: vi.fn(),
      replay: vi.fn(),
      search: vi.fn(),
      count: vi.fn(),
      clear: vi.fn(),
      export: vi.fn(),
      ...(overrides.requests ?? {}),
    },
    templates: {
      listProviders: vi
        .fn()
        .mockReturnValue([
          "stripe",
          "github",
          "shopify",
          "twilio",
          "slack",
          "paddle",
          "linear",
          "sendgrid",
          "clerk",
          "discord",
          "vercel",
          "gitlab",
          "typeform",
          "standard-webhooks",
          "meta",
          "lemonsqueezy",
          "coinbase-commerce",
          "razorpay",
          "cal",
          "intercom",
          "telegram",
          "square",
          "hubspot",
          "mailgun",
          "calendly",
          "mux",
          "sentry",
          "bitbucket",
        ]),
      get: vi.fn((provider: string) => ({ provider, templates: [], secretRequired: true })),
      ...(overrides.templates ?? {}),
    },
    usage: vi.fn(),
    flow: vi.fn(),
    sendTo: vi.fn(),
    buildRequest: vi.fn(),
    describe: vi.fn(),
    ...(overrides as object),
  } as unknown as WebhooksCC;
}

function getRegisteredTools(client: WebhooksCC): Record<string, RegisteredTool> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const toolSpy = vi.spyOn(server, "tool");

  registerTools(server, client);

  return Object.fromEntries(
    toolSpy.mock.calls.map((call) => [
      call[0] as string,
      {
        description: call[1] as string,
        schema: call[2],
        handler: call[3] as RegisteredTool["handler"],
      },
    ])
  );
}

function parseJsonResult(result: { content: Array<{ text: string }> }) {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

describe("registerTools", () => {
  it("registers all wrapper and legacy tools", () => {
    const tools = getRegisteredTools(createMockClient());

    expect(Object.keys(tools)).toHaveLength(25);
    for (const name of EXPECTED_TOOLS) {
      expect(tools).toHaveProperty(name);
    }
  });

  it("registers descriptions and schemas for every tool", () => {
    const tools = getRegisteredTools(createMockClient());

    for (const tool of Object.values(tools)) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.schema).toBe("object");
      expect(tool.schema).not.toBeNull();
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("returns structured not_found MCP errors", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        endpoints: {
          get: vi.fn(async () => {
            throw new NotFoundError(
              "Endpoint 'missing' not found — Use list_endpoints to see available endpoints"
            );
          }),
        } as unknown as WebhooksCC["endpoints"],
      })
    );

    const result = await tools.get_endpoint.handler({ slug: "missing" });
    expect(result.isError).toBe(true);

    const error = parseJsonResult(result);
    expect(error).toEqual({
      error: true,
      code: "not_found",
      message: "Endpoint 'missing' not found",
      hint: "Use list_endpoints to see available endpoints",
      retryAfter: null,
    });
  });

  it("returns structured rate limit errors with retryAfter", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        usage: vi.fn(async () => {
          throw new RateLimitError(12);
        }),
      })
    );

    const result = await tools.get_usage.handler({});
    expect(result.isError).toBe(true);

    const error = parseJsonResult(result);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfter).toBe(12);
  });

  it("returns provider metadata from list_provider_templates", async () => {
    const tools = getRegisteredTools(createMockClient());
    const result = await tools.list_provider_templates.handler({ provider: "stripe" });

    expect(parseJsonResult(result)).toEqual([
      { provider: "stripe", templates: [], secretRequired: true },
    ]);
  });

  it("exposes Typeform in provider template listings", async () => {
    const tools = getRegisteredTools(createMockClient());
    const result = await tools.list_provider_templates.handler({});

    expect(
      parseJsonResult(result).map((provider: { provider: string }) => provider.provider)
    ).toEqual(expect.arrayContaining(["typeform"]));
  });

  it("exposes tier-1 providers in provider template listings", async () => {
    const tools = getRegisteredTools(createMockClient());
    const result = await tools.list_provider_templates.handler({});

    expect(
      parseJsonResult(result).map((provider: { provider: string }) => provider.provider)
    ).toEqual(
      expect.arrayContaining([
        "meta",
        "lemonsqueezy",
        "coinbase-commerce",
        "razorpay",
        "cal",
        "intercom",
        "telegram",
      ])
    );
  });

  it("exposes all 7 tier-2 providers in provider template listings", async () => {
    const tools = getRegisteredTools(createMockClient());
    const result = await tools.list_provider_templates.handler({});

    const providers = parseJsonResult(result).map(
      (provider: { provider: string }) => provider.provider
    );
    expect(providers).toEqual(
      expect.arrayContaining([
        "square",
        "hubspot",
        "mailgun",
        "calendly",
        "mux",
        "sentry",
        "bitbucket",
      ])
    );
    // 21 tier-1 + 7 tier-2 = 28 named providers in the catalog.
    expect(providers).toHaveLength(28);
  });

  // verify_signature exercises the real SDK verification path through the MCP
  // tool — one case per tier-1 signature scheme family.
  describe("verify_signature for tier-1 providers", () => {
    const hmacCases = [
      {
        provider: "meta",
        header: "x-hub-signature-256",
        sign: (body: string, secret: string) =>
          `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      {
        provider: "coinbase-commerce",
        header: "x-cc-webhook-signature",
        sign: (body: string, secret: string) =>
          createHmac("sha256", secret).update(body).digest("hex"),
      },
      {
        provider: "intercom",
        header: "x-hub-signature",
        sign: (body: string, secret: string) =>
          `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`,
      },
    ] as const;

    for (const { provider, header, sign } of hmacCases) {
      it(`verifies a valid ${provider} signature and rejects a wrong secret`, async () => {
        const body = '{"hello":"world"}';
        const secret = "tier1_secret";
        const request = makeRequest({ body, headers: { [header]: sign(body, secret) } });
        const tools = getRegisteredTools(
          createMockClient({
            requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
          })
        );

        const ok = parseJsonResult(
          await tools.verify_signature.handler({ requestId: request.id, provider, secret })
        );
        expect(ok.valid).toBe(true);

        const bad = parseJsonResult(
          await tools.verify_signature.handler({
            requestId: request.id,
            provider,
            secret: "wrong_secret",
          })
        );
        expect(bad.valid).toBe(false);
      });
    }

    it("verifies a Telegram secret token (token-compare scheme)", async () => {
      const secret = "tg_token";
      const request = makeRequest({
        body: "{}",
        headers: { "x-telegram-bot-api-secret-token": secret },
      });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );

      const ok = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "telegram",
          secret,
        })
      );
      expect(ok.valid).toBe(true);

      const bad = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "telegram",
          secret: "nope",
        })
      );
      expect(bad.valid).toBe(false);
    });
  });

  // verify_signature for tier-2 — one provider per new scheme family, exercising
  // the real SDK verification path through the MCP tool (including url/method
  // plumbing for the request-context providers).
  describe("verify_signature for tier-2 providers", () => {
    // URL + body scheme (Square): base64(HMAC-SHA256(secret, url + body)).
    it("verifies a Square signature using the url option (URL+body scheme)", async () => {
      const url = "https://go.webhooks.cc/w/demo";
      const body = '{"type":"payment.created"}';
      const secret = "sq_signature_key";
      const sig = createHmac("sha256", secret).update(`${url}${body}`).digest("base64");
      const request = makeRequest({
        body,
        headers: { "x-square-hmacsha256-signature": sig },
      });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );

      const ok = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "square",
          secret,
          url,
        })
      );
      expect(ok.valid).toBe(true);

      // Wrong url → false (Square binds the signature to the notification URL).
      const wrongUrl = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "square",
          secret,
          url: "https://go.webhooks.cc/w/other",
        })
      );
      expect(wrongUrl.valid).toBe(false);
    });

    // method + uri + body + timestamp scheme (HubSpot v3): base64 HMAC-SHA256.
    it("verifies a HubSpot v3 signature using url+method options", async () => {
      const url = "https://go.webhooks.cc/w/demo";
      const method = "POST";
      const body = '[{"subscriptionType":"contact.creation"}]';
      const secret = "hs_app_client_secret";
      // HubSpot timestamps are milliseconds; keep it fresh so the 5-min window passes.
      const timestamp = String(Date.now());
      const sig = createHmac("sha256", secret)
        .update(`${method}${url}${body}${timestamp}`)
        .digest("base64");
      const request = makeRequest({
        body,
        headers: {
          "x-hubspot-signature-v3": sig,
          "x-hubspot-request-timestamp": timestamp,
        },
      });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );

      const ok = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "hubspot",
          secret,
          url,
          method,
        })
      );
      expect(ok.valid).toBe(true);

      // Wrong method → false (HubSpot binds the signature to the HTTP method).
      const wrongMethod = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "hubspot",
          secret,
          url,
          method: "GET",
        })
      );
      expect(wrongMethod.valid).toBe(false);
    });

    // Stripe-style t=,v1= scheme (Calendly): hex HMAC-SHA256 over "<t>.<body>".
    it("verifies a Calendly signature (Stripe-style t=,v1= scheme)", async () => {
      const body = '{"event":"invitee.created"}';
      const secret = "cal_signing_key";
      const t = Math.floor(Date.now() / 1000);
      const hex = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      const request = makeRequest({
        body,
        headers: { "calendly-webhook-signature": `t=${t},v1=${hex}` },
      });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );

      const ok = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "calendly",
          secret,
        })
      );
      expect(ok.valid).toBe(true);

      const bad = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "calendly",
          secret: "wrong_secret",
        })
      );
      expect(bad.valid).toBe(false);
    });

    // Body-embedded signature scheme (Mailgun): hex HMAC-SHA256 over timestamp+token,
    // with the signature carried in the body (no signature header, no url).
    it("verifies a Mailgun signature from the body fields (no header)", async () => {
      const secret = "mg_signing_key";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const token = "abc123token";
      const signature = createHmac("sha256", secret).update(`${timestamp}${token}`).digest("hex");
      const body = JSON.stringify({
        signature: { timestamp, token, signature },
        "event-data": { event: "delivered" },
      });
      const request = makeRequest({ body, headers: { "content-type": "application/json" } });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );

      const ok = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "mailgun",
          secret,
        })
      );
      expect(ok.valid).toBe(true);

      const bad = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "mailgun",
          secret: "wrong_secret",
        })
      );
      expect(bad.valid).toBe(false);
    });
  });

  it("returns preview_webhook output from buildRequest", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        buildRequest: vi.fn(async () => ({
          url: "http://localhost:3001/webhooks",
          method: "POST",
          headers: { "x-hub-signature-256": "sha256=abc" },
          body: '{"ok":true}',
        })),
      })
    );

    const preview = parseJsonResult(
      await tools.preview_webhook.handler({
        url: "http://localhost:3001/webhooks",
        provider: "github",
        secret: "github_secret",
      })
    );

    expect(preview.headers["x-hub-signature-256"]).toBe("sha256=abc");
    expect(preview.body).toBe('{"ok":true}');
  });

  it("creates multiple endpoints in one call", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ slug: "alpha-1", url: "https://go.webhooks.cc/w/alpha-1" })
      .mockResolvedValueOnce({ slug: "alpha-2", url: "https://go.webhooks.cc/w/alpha-2" });
    const tools = getRegisteredTools(
      createMockClient({
        endpoints: {
          create,
        } as unknown as WebhooksCC["endpoints"],
      })
    );

    const result = parseJsonResult(
      await tools.create_endpoints.handler({
        count: 2,
        namePrefix: "alpha",
      })
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.endpoints).toHaveLength(2);
  });

  it("deletes multiple endpoints and reports partial failures", async () => {
    const deleteEndpoint = vi.fn(async (slug: string) => {
      if (slug === "bad") {
        throw new Error("Endpoint not found");
      }
    });
    const tools = getRegisteredTools(
      createMockClient({
        endpoints: {
          delete: deleteEndpoint,
        } as unknown as WebhooksCC["endpoints"],
      })
    );

    const result = parseJsonResult(
      await tools.delete_endpoints.handler({
        slugs: ["good", "bad"],
      })
    );

    expect(result.deleted).toEqual(["good"]);
    expect(result.failed).toEqual([{ slug: "bad", message: "Endpoint not found" }]);
  });

  it("compares two requests with diffRequests", async () => {
    const left = makeRequest();
    const right = makeRequest({
      id: "req_456",
      body: '{"marker":"right","data":{"object":{"id":"b"}}}',
      receivedAt: 1700000001000,
    });

    const tools = getRegisteredTools(
      createMockClient({
        requests: {
          get: vi.fn(async (requestId: string) => (requestId === "left" ? left : right)),
        } as unknown as WebhooksCC["requests"],
      })
    );

    const diff = parseJsonResult(
      await tools.compare_requests.handler({
        leftRequestId: "left",
        rightRequestId: "right",
      })
    );

    expect(diff.matches).toBe(false);
    expect(diff.differences.body.type).toBe("json");
  });

  it("formats usage periodEnd as ISO", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        usage: vi.fn(async () => ({
          used: 10,
          limit: 100,
          remaining: 90,
          plan: "pro" as const,
          periodEnd: 1700000000000,
        })),
      })
    );

    const usage = parseJsonResult(await tools.get_usage.handler({}));
    expect(usage.periodEnd).toBe("2023-11-14T22:13:20.000Z");
  });

  it("runs the composite flow tool and summarizes replay output", async () => {
    const sendTemplate = vi.fn();
    const verify = vi.fn();
    const replayTo = vi.fn();
    const cleanup = vi.fn();
    const run = vi.fn(async () => ({
      endpoint: { slug: "flow-ep", url: "https://go.webhooks.cc/w/flow-ep" },
      request: { id: "req_flow" },
      verification: { valid: true },
      replayResponse: new Response("ok", { status: 200, statusText: "OK" }),
      cleanedUp: true,
    }));

    const builder = {
      createEndpoint: vi.fn().mockReturnThis(),
      waitForCapture: vi.fn().mockReturnThis(),
      setMock: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      sendTemplate: sendTemplate.mockReturnThis(),
      verifySignature: verify.mockReturnThis(),
      replayTo: replayTo.mockReturnThis(),
      cleanup: cleanup.mockReturnThis(),
      run,
    };

    const tools = getRegisteredTools(
      createMockClient({
        flow: vi.fn(() => builder) as unknown as WebhooksCC["flow"],
      })
    );

    const result = parseJsonResult(
      await tools.test_webhook_flow.handler({
        provider: "github",
        secret: "github_secret",
        verifySignature: true,
        targetUrl: "http://localhost:3001/webhooks",
        cleanup: true,
      })
    );

    expect(sendTemplate).toHaveBeenCalled();
    expect(verify).toHaveBeenCalled();
    expect(replayTo).toHaveBeenCalledWith("http://localhost:3001/webhooks");
    expect(cleanup).toHaveBeenCalled();
    expect(result.replayResponse.status).toBe(200);
    expect(result.cleanedUp).toBe(true);
  });
});

describe("createServer", () => {
  it("throws without API key", async () => {
    const { createServer } = await import("../index");
    const saved = process.env.WHK_API_KEY;
    delete process.env.WHK_API_KEY;
    try {
      expect(() => createServer()).toThrow("Missing API key");
    } finally {
      if (saved) process.env.WHK_API_KEY = saved;
    }
  });

  it("creates server with explicit API key", async () => {
    const { createServer } = await import("../index");
    const server = createServer({ apiKey: "whcc_test123" });
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  it("creates server from WHK_API_KEY env var", async () => {
    const { createServer } = await import("../index");
    const saved = process.env.WHK_API_KEY;
    process.env.WHK_API_KEY = "whcc_envtest";
    try {
      const server = createServer();
      expect(server).toBeDefined();
    } finally {
      if (saved) {
        process.env.WHK_API_KEY = saved;
      } else {
        delete process.env.WHK_API_KEY;
      }
    }
  });
});
