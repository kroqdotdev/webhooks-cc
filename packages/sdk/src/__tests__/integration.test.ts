import { describe, it, expect, beforeAll } from "vitest";
import { WebhooksCC, ApiError } from "../client";

const API_KEY = process.env.WHK_API_KEY;
const BASE_URL = process.env.WHK_BASE_URL ?? "https://webhooks.cc";
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "https://r.webhooks.cc";

describe.skipIf(!API_KEY)("SDK integration tests", () => {
  let client: WebhooksCC;

  beforeAll(() => {
    client = new WebhooksCC({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
    });
  });

  it("full round-trip: create, send webhook, waitFor, delete", async () => {
    // Create endpoint
    const endpoint = await client.endpoints.create({ name: "Integration Test" });
    expect(endpoint.slug).toBeTruthy();
    expect(endpoint.url).toBeDefined();
    expect(endpoint.url).toContain(endpoint.slug);

    try {
      // Send a webhook to the endpoint
      const webhookUrl = `${WEBHOOK_URL}/w/${endpoint.slug}`;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, timestamp: Date.now() }),
      });

      // Wait for the request to arrive
      const request = await client.requests.waitFor(endpoint.slug, {
        timeout: 10000,
        pollInterval: 200,
        match: (r) => r.method === "POST",
      });

      expect(request.method).toBe("POST");
      expect(request.body).toBeTruthy();
      const body = JSON.parse(request.body!);
      expect(body.test).toBe(true);

      // Verify list works
      const requests = await client.requests.list(endpoint.slug);
      expect(requests.length).toBeGreaterThanOrEqual(1);

      // Verify get by slug works
      const fetched = await client.endpoints.get(endpoint.slug);
      expect(fetched.slug).toBe(endpoint.slug);

      // Verify list endpoints works
      const endpoints = await client.endpoints.list();
      expect(endpoints.some((e) => e.slug === endpoint.slug)).toBe(true);
    } finally {
      // Cleanup
      await client.endpoints.delete(endpoint.slug);
    }

    // Verify deletion
    try {
      await client.endpoints.get(endpoint.slug);
      expect.fail("Should have thrown 404");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(404);
    }
  }, 30000);

  it("returns 404 for non-existent slug", async () => {
    try {
      await client.endpoints.get("nonexistent-slug-xyz");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(404);
    }
  });

  it("returns 401 for invalid API key", async () => {
    const badClient = new WebhooksCC({
      apiKey: "whcc_invalid_key",
      baseUrl: BASE_URL,
    });

    try {
      await badClient.endpoints.list();
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(401);
    }
  });
});
