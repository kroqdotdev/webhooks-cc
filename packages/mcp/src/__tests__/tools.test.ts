import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NotFoundError,
  RateLimitError,
  WebhooksCC,
  WebhooksCCError,
  buildEmailJson,
  type EmailCapture,
  type EmailRequest,
  type Request,
} from "@webhooks-cc/sdk";
import { registerTools, registerAgentRegistrationTools } from "../tools";

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
  "list_teams",
  "list_team_members",
  "share_endpoint",
  "unshare_endpoint",
  "list_emails",
  "get_email",
  "wait_for_email",
  "send_test_email",
  "configure_forwarding",
  "get_forwarding_secret",
  "test_forwarding",
  "list_deliveries",
  "redeliver_email",
  "how_to_register",
  "register_agent",
  "check_claim",
  "register_agent_with_email",
  "verify_agent_otp",
  "register_agent_with_idjag",
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
          "docusign",
          "adyen",
          "paypal",
          "plaid",
          "resend",
          "workos",
        ]),
      get: vi.fn((provider: string) => ({ provider, templates: [], secretRequired: true })),
      ...(overrides.templates ?? {}),
    },
    usage: vi.fn(),
    teams: {
      list: vi.fn(async () => []),
      members: vi.fn(),
      share: vi.fn(),
      unshare: vi.fn(),
      invite: vi.fn(),
      invites: { list: vi.fn(), accept: vi.fn(), decline: vi.fn() },
      ...(overrides.teams ?? {}),
    },
    emails: {
      address: vi.fn((slug: string, tag?: string) =>
        tag ? `${slug}+${tag}@mailhooks.cc` : `${slug}@mailhooks.cc`
      ),
      list: vi.fn(),
      get: vi.fn(),
      latest: vi.fn(),
      waitFor: vi.fn(),
      waitForAll: vi.fn(),
      sendTest: vi.fn(),
      toJson: vi.fn(),
      ...(overrides.emails ?? {}),
    },
    forwarding: {
      configure: vi.fn(),
      secret: vi.fn(),
      rotateSecret: vi.fn(),
      test: vi.fn(),
      deliveries: vi.fn(),
      emailDeliveries: vi.fn(),
      redeliver: vi.fn(),
      ...(overrides.forwarding ?? {}),
    },
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

    expect(Object.keys(tools)).toHaveLength(44);
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

  it("exposes all tier-2 and tier-3 providers in provider template listings", async () => {
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
        "docusign",
        "adyen",
        "paypal",
        "plaid",
        "resend",
        "workos",
      ])
    );
    // 21 tier-1 + 7 tier-2 + 4 tier-3 + Resend and WorkOS = 34 named providers.
    expect(providers).toHaveLength(34);
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

  describe("verify_signature for Resend and WorkOS", () => {
    async function verifyThroughTool(
      provider: string,
      body: string,
      headers: Record<string, string>,
      secret: string
    ) {
      const request = makeRequest({ body, headers });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );
      return parseJsonResult(
        await tools.verify_signature.handler({ requestId: request.id, provider, secret })
      );
    }

    it("verifies a Resend (Svix) signature from the published test vector", async () => {
      const body = '{"email":"test@example.com","username":"test_user"}';
      const headers = {
        "svix-id": "msg_27UH4WbU6Z5A5EzD8u03UvzRbpk",
        "svix-timestamp": "1649367553",
        "svix-signature": "v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw=",
      };
      const secret = "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD";
      expect((await verifyThroughTool("resend", body, headers, secret)).valid).toBe(true);
      expect(
        (await verifyThroughTool("resend", body, headers, "whsec_plJ3nmyCDGBKInavdOK15jsl")).valid
      ).toBe(false);
    });

    it("verifies a WorkOS t=<ms>, v1=<hex> signature", async () => {
      const body = '{"event":"user.created","id":"event_01","data":{}}';
      const secret = "whsec_0FWAiVGkEfGBqqsJH4aNAGBJ4";
      const signature = createHmac("sha256", secret).update(`1700000000000.${body}`).digest("hex");
      const headers = { "workos-signature": `t=1700000000000, v1=${signature}` };
      expect((await verifyThroughTool("workos", body, headers, secret)).valid).toBe(true);
      expect((await verifyThroughTool("workos", body, headers, "wrong_secret")).valid).toBe(false);
    });
  });

  describe("verify_signature for tier-3 providers", () => {
    it("verifies a DocuSign HMAC signature", async () => {
      const body = '{"event":"envelope-completed"}';
      const secret = "docusign_hmac_secret";
      const signature = createHmac("sha256", secret).update(body).digest("base64");
      const request = makeRequest({
        body,
        headers: { "x-docusign-signature-1": signature },
      });
      const tools = getRegisteredTools(
        createMockClient({
          requests: { get: vi.fn(async () => request) } as unknown as WebhooksCC["requests"],
        })
      );

      const ok = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "docusign",
          secret,
        })
      );
      expect(ok.valid).toBe(true);

      const bad = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "docusign",
          secret: "wrong_secret",
        })
      );
      expect(bad.valid).toBe(false);
    });

    it("verifies an Adyen body-embedded HMAC signature", async () => {
      const hmacKey = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
      const body = JSON.stringify({
        notificationItems: [
          {
            NotificationRequestItem: {
              additionalData: {
                hmacSignature: "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=",
              },
              amount: { value: 1130, currency: "EUR" },
              pspReference: "7914073381342284",
              eventCode: "AUTHORISATION",
              merchantAccountCode: "TestMerchant",
              merchantReference: "TestPayment-1407325143704",
              success: "true",
            },
          },
        ],
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
          provider: "adyen",
          secret: hmacKey,
        })
      );
      expect(ok.valid).toBe(true);

      const bad = parseJsonResult(
        await tools.verify_signature.handler({
          requestId: request.id,
          provider: "adyen",
          secret: hmacKey.replace(/.$/, "0"),
        })
      );
      expect(bad.valid).toBe(false);
    });
  });

  it("send_webhook allows secretless provider templates (plaid) without a secret", async () => {
    const sendTemplate = vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }));
    const tools = getRegisteredTools(
      createMockClient({
        endpoints: { sendTemplate } as unknown as WebhooksCC["endpoints"],
      })
    );

    const result = parseJsonResult(
      await tools.send_webhook.handler({ slug: "abc123", provider: "plaid" })
    );

    expect(sendTemplate).toHaveBeenCalledWith(
      "abc123",
      expect.objectContaining({ provider: "plaid" })
    );
    expect(result.status).toBe(200);
  });

  it("send_webhook still rejects signed provider templates without a secret", async () => {
    const tools = getRegisteredTools(createMockClient({}));
    const result = await tools.send_webhook.handler({ slug: "abc123", provider: "stripe" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/secret/i);
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
    expect(usage.teams).toEqual([]);
  });

  it("adds the pooled quota of subscribed teams to get_usage", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        usage: vi.fn(async () => ({
          used: 10,
          limit: 100,
          remaining: 90,
          plan: "free" as const,
          periodEnd: null,
        })),
        teams: {
          list: vi.fn(async () => [
            {
              id: "t1",
              name: "Team A",
              role: "member",
              suspended: false,
              seats: 2,
              requestsUsed: 150000,
              requestLimit: 200000,
              periodEnd: 1700000000000,
            },
            {
              id: "t2",
              name: "Lapsed",
              role: "owner",
              suspended: true,
              seats: 0,
              requestsUsed: 0,
              requestLimit: 0,
              periodEnd: null,
            },
          ]),
        } as unknown as WebhooksCC["teams"],
      })
    );

    const usage = parseJsonResult(await tools.get_usage.handler({}));
    expect(usage.teams).toEqual([
      {
        id: "t1",
        name: "Team A",
        role: "member",
        seats: 2,
        used: 150000,
        limit: 200000,
        remaining: 50000,
        periodEnd: "2023-11-14T22:13:20.000Z",
      },
    ]);
  });

  it("keeps personal usage and reports teamsError when the team list fails", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        usage: vi.fn(async () => ({
          used: 1,
          limit: 50,
          remaining: 49,
          plan: "free" as const,
          periodEnd: null,
        })),
        teams: {
          list: vi.fn(async () => {
            throw new WebhooksCCError(500, "teams unavailable");
          }),
        } as unknown as WebhooksCC["teams"],
      })
    );

    const result = await tools.get_usage.handler({});
    expect(result.isError).toBeUndefined();
    const usage = parseJsonResult(result);
    expect(usage.used).toBe(1);
    expect(usage.teams).toEqual([]);
    expect(usage.teamsError).toBe("teams unavailable");
  });

  it("passes the team filter through list_endpoints", async () => {
    const list = vi.fn(async () => []);
    const tools = getRegisteredTools(
      createMockClient({ endpoints: { list } as unknown as WebhooksCC["endpoints"] })
    );

    await tools.list_endpoints.handler({});
    await tools.list_endpoints.handler({ team: "Team A" });

    expect(list.mock.calls).toEqual([[{}], [{ team: "Team A" }]]);
  });

  it("lists teams with ISO period ends", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        teams: {
          list: vi.fn(async () => [
            { id: "t1", name: "Team A", role: "owner", periodEnd: 1700000000000 },
            { id: "t2", name: "Lapsed", role: "member", periodEnd: null },
          ]),
        } as unknown as WebhooksCC["teams"],
      })
    );

    const teams = parseJsonResult(await tools.list_teams.handler({}));
    expect(teams.map((t: { periodEnd: string | null }) => t.periodEnd)).toEqual([
      "2023-11-14T22:13:20.000Z",
      null,
    ]);
  });

  it("lists team members and shares or unshares by slug", async () => {
    const members = vi.fn(async () => ({
      members: [{ userId: "u1", role: "owner" }],
      pendingInvites: [],
    }));
    const share = vi.fn(async () => undefined);
    const unshare = vi.fn(async () => undefined);
    const tools = getRegisteredTools(
      createMockClient({
        teams: { members, share, unshare } as unknown as WebhooksCC["teams"],
      })
    );

    const listed = parseJsonResult(await tools.list_team_members.handler({ teamId: "t1" }));
    expect(listed.members).toHaveLength(1);
    expect(members).toHaveBeenCalledWith("t1");

    const shared = parseJsonResult(
      await tools.share_endpoint.handler({ slug: "abc", teamId: "t1" })
    );
    expect(shared).toEqual({ shared: true, slug: "abc", teamId: "t1" });
    expect(share).toHaveBeenCalledWith("t1", "abc");

    const unshared = parseJsonResult(
      await tools.unshare_endpoint.handler({ slug: "abc", teamId: "t1" })
    );
    expect(unshared).toEqual({ shared: false, slug: "abc", teamId: "t1" });
    expect(unshare).toHaveBeenCalledWith("t1", "abc");
  });

  it("surfaces the API error when sharing with a suspended team", async () => {
    const tools = getRegisteredTools(
      createMockClient({
        teams: {
          share: vi.fn(async () => {
            throw new WebhooksCCError(400, "This team needs an active Teams subscription");
          }),
        } as unknown as WebhooksCC["teams"],
      })
    );

    const result = await tools.share_endpoint.handler({ slug: "abc", teamId: "t1" });
    expect(result.isError).toBe(true);
    expect(parseJsonResult(result).message).toContain("active Teams subscription");
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

  it("test_webhook_flow allows secretless provider templates (plaid) without a secret", async () => {
    const sendTemplate = vi.fn();
    const builder = {
      createEndpoint: vi.fn().mockReturnThis(),
      waitForCapture: vi.fn().mockReturnThis(),
      setMock: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      sendTemplate: sendTemplate.mockReturnThis(),
      verifySignature: vi.fn().mockReturnThis(),
      replayTo: vi.fn().mockReturnThis(),
      cleanup: vi.fn().mockReturnThis(),
      run: vi.fn(async () => ({
        endpoint: { slug: "flow-ep", url: "https://go.webhooks.cc/w/flow-ep" },
        request: { id: "req_flow" },
        cleanedUp: true,
      })),
    };
    const tools = getRegisteredTools(
      createMockClient({
        flow: vi.fn(() => builder) as unknown as WebhooksCC["flow"],
      })
    );

    const result = parseJsonResult(
      await tools.test_webhook_flow.handler({ provider: "plaid", cleanup: true })
    );

    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ provider: "plaid" }));
    expect(result.cleanedUp).toBe(true);
  });
});

function getRegistrationTools(): Record<string, RegisteredTool> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const toolSpy = vi.spyOn(server, "tool");
  registerAgentRegistrationTools(server);
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

function makeEmail(id: string, overrides: Partial<EmailCapture> = {}): EmailRequest {
  const email: EmailCapture = {
    subject: "Confirm your email",
    from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
    to: [{ name: null, address: "acme+run-1@mailhooks.cc" }],
    cc: [],
    replyTo: [],
    sender: [],
    date: null,
    messageId: null,
    inReplyTo: [],
    tag: "run-1",
    text: "Your code is 482913. Confirm: https://app.tidewater.app/confirm?t=1",
    html: "<p>Your code is 482913</p>",
    textFromHtml: false,
    attachments: [],
    auth: null,
    smtp: null,
    parseError: false,
    truncated: {
      raw: false,
      text: false,
      html: false,
      headers: false,
      addresses: false,
      attachments: false,
    },
    ...overrides,
  };
  return {
    ...makeRequest({ id, method: "EMAIL", path: "acme+run-1@mailhooks.cc", body: "raw mime" }),
    kind: "email",
    email,
  };
}

function emailClient(overrides: Partial<WebhooksCC> = {}, showEmailExtracts = true) {
  return createMockClient({
    endpoints: {
      get: vi.fn(async () => ({ id: "ep_1", slug: "acme", createdAt: 1, showEmailExtracts })),
    } as unknown as WebhooksCC["endpoints"],
    emails: {
      address: vi.fn((slug: string, tag?: string) =>
        tag ? `${slug}+${tag}@mailhooks.cc` : `${slug}@mailhooks.cc`
      ),
      toJson: vi.fn((email: EmailRequest, options: { includeExtracts?: boolean } = {}) =>
        buildEmailJson({ ...email, email: email.email }, { slug: "acme" }, options)
      ),
      ...(overrides.emails ?? {}),
    } as unknown as WebhooksCC["emails"],
    ...(overrides.forwarding ? { forwarding: overrides.forwarding } : {}),
    ...(overrides.requests ? { requests: overrides.requests } : {}),
  });
}

describe("email and forwarding tools", () => {
  it("lists emails with their code and link", async () => {
    const list = vi.fn(async () => [makeEmail("e1")]);
    const tools = getRegisteredTools(emailClient({ emails: { list } as never }));
    const result = parseJsonResult(
      await tools.list_emails.handler({ endpointSlug: "acme", limit: 25, tag: "run-1" })
    );
    expect(list).toHaveBeenCalledWith("acme", expect.objectContaining({ limit: 25, tag: "run-1" }));
    expect(result).toEqual([
      expect.objectContaining({
        id: "e1",
        address: "acme+run-1@mailhooks.cc",
        tag: "run-1",
        subject: "Confirm your email",
        from: "Tidewater <no-reply@tidewater.app>",
        code: "482913",
        link: "https://app.tidewater.app/confirm?t=1",
        attachments: 0,
      }),
    ]);
  });

  it("leaves codes and links out when the endpoint turned them off", async () => {
    const list = vi.fn(async () => [makeEmail("e1")]);
    const tools = getRegisteredTools(emailClient({ emails: { list } as never }, false));
    const [summary] = parseJsonResult(
      await tools.list_emails.handler({ endpointSlug: "acme", limit: 25 })
    );
    expect(summary).not.toHaveProperty("code");
    expect(summary).not.toHaveProperty("link");
  });

  it("gets one email, trims long text and leaves out the HTML unless asked", async () => {
    const get = vi.fn(async () => makeEmail("e1", { text: "x".repeat(9000) + " code 482913" }));
    const tools = getRegisteredTools(emailClient({ emails: { get } as never }));
    const detail = parseJsonResult(
      await tools.get_email.handler({ requestId: "e1", includeHtml: false })
    );
    expect(detail.text).toHaveLength(8000);
    expect(detail.textTruncated).toBe(true);
    expect(detail).not.toHaveProperty("html");
    expect(detail.htmlSize).toBe("<p>Your code is 482913</p>".length);
    expect(detail.id).toBe("e1");
    expect(detail.code).toBe("482913");
  });

  it("needs exactly one of requestId and endpointSlug, and reports a missing email", async () => {
    const latest = vi.fn(async () => null);
    const tools = getRegisteredTools(emailClient({ emails: { latest } as never }));
    const both = await tools.get_email.handler({
      requestId: "e1",
      endpointSlug: "acme",
      includeHtml: false,
    });
    expect(both.isError).toBe(true);
    const none = await tools.get_email.handler({ endpointSlug: "acme", includeHtml: false });
    expect(none.isError).toBe(true);
    expect(JSON.parse(none.content[0].text).code).toBe("not_found");
  });

  it("waits for an email with the given criteria", async () => {
    const waitFor = vi.fn(async () => makeEmail("e2"));
    const tools = getRegisteredTools(emailClient({ emails: { waitFor } as never }));
    const detail = parseJsonResult(
      await tools.wait_for_email.handler({
        endpointSlug: "acme",
        tag: "run-1",
        subject: "Confirm",
        timeout: "60s",
        includeHtml: true,
      })
    );
    expect(waitFor).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ tag: "run-1", subject: "Confirm", timeout: "60s" })
    );
    expect(detail.html).toBe("<p>Your code is 482913</p>");
  });

  it("sends a test email and reports its address", async () => {
    const sendTest = vi.fn(async () => ({ status: "captured", requestId: "e3" }));
    const tools = getRegisteredTools(emailClient({ emails: { sendTest } as never }));
    expect(
      parseJsonResult(await tools.send_test_email.handler({ slug: "acme", tag: "t1" }))
    ).toEqual({ status: "captured", requestId: "e3", address: "acme+t1@mailhooks.cc" });
  });

  it("configures forwarding and reads or rotates the secret", async () => {
    const forwarding = {
      configure: vi.fn(async () => ({
        id: "ep_1",
        slug: "acme",
        createdAt: 1,
        forwardEnabled: true,
        forwardUrl: "https://example.com/in",
        hasForwardSecret: true,
      })),
      secret: vi.fn(async () => "whsec_a"),
      rotateSecret: vi.fn(async () => "whsec_b"),
      test: vi.fn(async () => ({ status: 204, delivered: true })),
      deliveries: vi.fn(async () => []),
      emailDeliveries: vi.fn(async () => [{ id: "d1" }]),
      redeliver: vi.fn(async () => ({ id: "d2" })),
    };
    const tools = getRegisteredTools(emailClient({ forwarding } as never));
    expect(
      parseJsonResult(
        await tools.configure_forwarding.handler({
          slug: "acme",
          url: "https://example.com/in",
          enabled: true,
        })
      )
    ).toEqual({
      slug: "acme",
      forwardEnabled: true,
      forwardUrl: "https://example.com/in",
      hasForwardSecret: true,
    });
    expect(
      parseJsonResult(await tools.get_forwarding_secret.handler({ slug: "acme", rotate: false }))
    ).toEqual({ secret: "whsec_a", rotated: false });
    expect(
      parseJsonResult(await tools.get_forwarding_secret.handler({ slug: "acme", rotate: true }))
    ).toEqual({ secret: "whsec_b", rotated: true });
    expect(parseJsonResult(await tools.test_forwarding.handler({ slug: "acme" }))).toEqual({
      status: 204,
      delivered: true,
    });
    expect(
      parseJsonResult(await tools.list_deliveries.handler({ requestId: "e1", limit: 5 }))
    ).toEqual([{ id: "d1" }]);
    await tools.list_deliveries.handler({ endpointSlug: "acme", limit: 10 });
    expect(forwarding.deliveries).toHaveBeenCalledWith("acme", { limit: 10 });
    expect((await tools.list_deliveries.handler({ limit: 5 })).isError).toBe(true);
    expect(parseJsonResult(await tools.redeliver_email.handler({ requestId: "e1" }))).toEqual({
      id: "d2",
    });
  });

  it("replaces an email's raw message with its size in request tools", async () => {
    const list = vi.fn(async () => [makeEmail("e1"), makeRequest({ id: "h1", kind: "http" })]);
    const tools = getRegisteredTools(
      emailClient({ requests: { list } as unknown as WebhooksCC["requests"] })
    );
    const [email, http] = parseJsonResult(
      await tools.list_requests.handler({ endpointSlug: "acme", limit: 25, kind: undefined })
    );
    expect(email).not.toHaveProperty("body");
    expect(email.rawMessageSize).toBe("raw mime".length);
    expect(email.email.subject).toBe("Confirm your email");
    expect(http.body).toBeDefined();

    await tools.list_requests.handler({ endpointSlug: "acme", limit: 25, kind: "email" });
    expect(list).toHaveBeenLastCalledWith("acme", expect.objectContaining({ kind: "email" }));
  });
});

describe("agent registration tools", () => {
  it("registers the unauthenticated on-ramp tools", () => {
    const tools = getRegistrationTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        "check_claim",
        "how_to_register",
        "register_agent",
        "register_agent_with_email",
        "verify_agent_otp",
        "register_agent_with_idjag",
      ].sort()
    );
  });

  it("register_agent_with_email begins the verified_email flow via the static SDK helper", async () => {
    const spy = vi.spyOn(WebhooksCC.register, "withEmail").mockResolvedValue({
      registrationId: "reg-email",
      claimToken: "clm_email",
      claimUrl: "https://webhooks.cc/agent/claim",
      claimTokenExpires: "2026-01-01T00:00:00Z",
      postClaimScopes: ["webhooks:read"],
    });
    try {
      const tools = getRegistrationTools();
      const result = await tools.register_agent_with_email.handler({
        email: "dev@example.com",
        clientName: "agent",
      });
      const body = parseJsonResult(result as { content: Array<{ text: string }> });
      expect(body.claimToken).toBe("clm_email");
      expect(spy).toHaveBeenCalledWith(
        "dev@example.com",
        expect.objectContaining({ clientName: "agent" })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("verify_agent_otp completes the verified_email flow via the static SDK helper", async () => {
    const spy = vi.spyOn(WebhooksCC.register, "confirmEmailOtp").mockResolvedValue({
      credential: "whcc_email",
      credentialType: "api_key",
      scopes: ["webhooks:read"],
    });
    try {
      const tools = getRegistrationTools();
      const result = await tools.verify_agent_otp.handler({
        claimToken: "clm_email",
        otp: "123456",
      });
      const body = parseJsonResult(result as { content: Array<{ text: string }> });
      expect(body.credential).toBe("whcc_email");
      expect(spy).toHaveBeenCalledWith(
        { claimToken: "clm_email", otp: "123456" },
        expect.anything()
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("register_agent_with_idjag drives the identity_assertion flow via the static SDK helper", async () => {
    const spy = vi.spyOn(WebhooksCC.register, "withIdJag").mockResolvedValue({
      credential: "whcc_idjag",
      credentialType: "api_key",
      scopes: ["webhooks:read"],
    });
    try {
      const tools = getRegistrationTools();
      const result = await tools.register_agent_with_idjag.handler({ assertion: "ey.jwt.sig" });
      const body = parseJsonResult(result as { content: Array<{ text: string }> });
      expect(body.credential).toBe("whcc_idjag");
      expect(spy).toHaveBeenCalledWith("ey.jwt.sig", expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it("how_to_register returns the auth.md discovery without a network call", async () => {
    const tools = getRegistrationTools();
    const result = await tools.how_to_register.handler({});
    const body = parseJsonResult(result as { content: Array<{ text: string }> });
    expect(body.protocol).toBe("auth.md");
    expect(Object.keys(body.flows)).toEqual(
      expect.arrayContaining(["anonymous", "verified_email", "identity_assertion"])
    );
    expect(Array.isArray(body.next_steps)).toBe(true);
  });

  it("register_agent drives the anonymous flow via the static SDK helper", async () => {
    const spy = vi.spyOn(WebhooksCC.register, "anonymous").mockResolvedValue({
      registrationId: "reg-1",
      credential: "whcc_anon",
      scopes: ["webhooks:read"],
      claimUrl: "https://webhooks.cc/agent/claim",
      claimToken: "clm_abc",
      userCode: "ABCD-EFGH",
      claimTokenExpires: "2026-01-01T00:00:00Z",
      postClaimScopes: ["webhooks:read"],
    });
    try {
      const tools = getRegistrationTools();
      const result = await tools.register_agent.handler({ clientName: "agent" });
      const body = parseJsonResult(result as { content: Array<{ text: string }> });
      expect(body.credential).toBe("whcc_anon");
      expect(body.claim.userCode).toBe("ABCD-EFGH");
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ clientName: "agent" }));
    } finally {
      spy.mockRestore();
    }
  });

  it("check_claim polls via the static SDK helper", async () => {
    const spy = vi.spyOn(WebhooksCC.register, "pollClaim").mockResolvedValue({ status: "claimed" });
    try {
      const tools = getRegistrationTools();
      const result = await tools.check_claim.handler({ claimToken: "clm_abc" });
      const body = parseJsonResult(result as { content: Array<{ text: string }> });
      expect(body.status).toBe("claimed");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createServer", () => {
  it("boots a keyless on-ramp server without an API key (registration tools only)", async () => {
    const { createServer } = await import("../index");
    const saved = process.env.WHK_API_KEY;
    delete process.env.WHK_API_KEY;
    try {
      // Previously this threw; now it boots a minimal server exposing the
      // unauthenticated auth.md registration on-ramp so an agent can obtain a key.
      const server = createServer();
      expect(server).toBeDefined();
      expect(server.server).toBeDefined();
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
