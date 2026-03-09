import { describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { WebhookFlowBuilder } from "../flow";
import type { Endpoint, Request } from "../types";

const sdkClient = new WebhooksCC({
  apiKey: "whcc_testkey123",
  baseUrl: "https://test.webhooks.cc",
  webhookUrl: "https://go.test.webhooks.cc",
});

function makeEndpoint(): Endpoint {
  return {
    id: "ep1",
    slug: "flow-endpoint",
    url: "https://go.test.webhooks.cc/w/flow-endpoint",
    createdAt: Date.now(),
  };
}

function makeRequestFromBuilt(
  built: { body?: string; headers: Record<string, string> },
  overrides: Partial<Request> = {}
): Request {
  return {
    id: "req1",
    endpointId: "ep1",
    method: "POST",
    path: "/",
    headers: built.headers,
    body: built.body,
    queryParams: {},
    contentType: built.headers["content-type"],
    ip: "127.0.0.1",
    size: built.body ? new TextEncoder().encode(built.body).length : 0,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("WebhookFlowBuilder", () => {
  it("runs create -> mock -> sendTemplate -> wait -> verify -> replay -> cleanup", async () => {
    const endpoint = makeEndpoint();
    const built = await sdkClient.buildRequest(endpoint.url!, {
      provider: "stripe",
      secret: "whsec_test_123",
      body: { type: "payment_intent.succeeded" },
      timestamp: 1700000000,
    });
    const captured = makeRequestFromBuilt(built);

    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        update: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
        sendTemplate: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
      requests: {
        waitFor: vi.fn().mockResolvedValue(captured),
        replay: vi.fn().mockResolvedValue(new Response(null, { status: 202 })),
      },
    };

    const result = await new WebhookFlowBuilder(client)
      .createEndpoint({ name: "Flow Test", ephemeral: true })
      .setMock({ status: 200, body: "ok", headers: {} })
      .sendTemplate({
        provider: "stripe",
        secret: "whsec_test_123",
        timestamp: 1700000000,
      })
      .waitForCapture({ timeout: "10s" })
      .verifySignature({ provider: "stripe", secret: "whsec_test_123" })
      .replayTo("https://example.com/target")
      .cleanup()
      .run();

    expect(client.endpoints.create).toHaveBeenCalledWith({ name: "Flow Test", ephemeral: true });
    expect(client.endpoints.update).toHaveBeenCalledWith("flow-endpoint", {
      mockResponse: { status: 200, body: "ok", headers: {} },
    });
    expect(client.endpoints.sendTemplate).toHaveBeenCalled();
    expect(client.requests.waitFor).toHaveBeenCalledWith("flow-endpoint", { timeout: "10s" });
    expect(client.requests.replay).toHaveBeenCalledWith("req1", "https://example.com/target");
    expect(client.endpoints.delete).toHaveBeenCalledWith("flow-endpoint");
    expect(result.verification).toEqual({ valid: true });
    expect(result.replayResponse?.status).toBe(202);
    expect(result.cleanedUp).toBe(true);
  });

  it("uses endpoint.url automatically for Twilio verification", async () => {
    const endpoint = makeEndpoint();
    const built = await sdkClient.buildRequest(endpoint.url!, {
      provider: "twilio",
      secret: "twilio_auth_token",
      body: "MessageStatus=delivered&To=%2B14155559876&From=%2B14155550123&MessageSid=SM123",
    });
    const captured = makeRequestFromBuilt(built, {
      contentType: "application/x-www-form-urlencoded",
    });

    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        update: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
        sendTemplate: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
      requests: {
        waitFor: vi.fn().mockResolvedValue(captured),
        replay: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
    };

    const result = await new WebhookFlowBuilder(client)
      .createEndpoint()
      .waitForCapture({ timeout: "5s" })
      .verifySignature({ provider: "twilio", secret: "twilio_auth_token" })
      .run();

    expect(result.verification).toEqual({ valid: true });
  });

  it("fails verification steps when no capture step is configured", async () => {
    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(makeEndpoint()),
        update: vi.fn().mockResolvedValue(makeEndpoint()),
        delete: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
        sendTemplate: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
      requests: {
        waitFor: vi.fn(),
        replay: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
    };

    await expect(
      new WebhookFlowBuilder(client)
        .createEndpoint()
        .verifySignature({ provider: "stripe", secret: "whsec_test_123" })
        .run()
    ).rejects.toThrow("waitForCapture");
  });
});
