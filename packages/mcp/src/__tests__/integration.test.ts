import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { registerTools } from "../tools";

const API_KEY = process.env.WHK_API_KEY;
const BASE_URL = process.env.WHK_BASE_URL ?? "https://webhooks.cc";
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "https://go.webhooks.cc";

type ToolHandler = (args: unknown) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function parseJsonResult(result: { content: Array<{ text: string }>; isError?: boolean }) {
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

function getRegisteredHandlers(client: WebhooksCC): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const toolSpy = vi.spyOn(server, "tool");

  registerTools(server, client);

  return Object.fromEntries(
    toolSpy.mock.calls.map((call) => [call[0] as string, call[3] as ToolHandler])
  );
}

async function waitForRetainedSearch(fn: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out waiting for retained search results");
}

describe.skipIf(!API_KEY)("MCP integration tests", () => {
  let client: WebhooksCC;
  let handlers: Record<string, ToolHandler>;
  const createdSlugs = new Set<string>();

  beforeAll(() => {
    client = new WebhooksCC({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      webhookUrl: WEBHOOK_URL,
    });
    handlers = getRegisteredHandlers(client);
  });

  afterEach(async () => {
    for (const slug of createdSlugs) {
      try {
        await client.endpoints.delete(slug);
      } catch {
        // ignore cleanup failures
      }
    }
    createdSlugs.clear();
  });

  it("lists providers, previews signed webhooks, and returns usage", async () => {
    const providers = parseJsonResult(await handlers.list_provider_templates({}));
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.some((provider: { provider: string }) => provider.provider === "slack")).toBe(
      true
    );

    const preview = parseJsonResult(
      await handlers.preview_webhook({
        url: "http://localhost:3001/webhooks",
        provider: "github",
        template: "push",
        secret: "github_secret",
        body: {
          marker: "mcp-preview",
          repository: { full_name: "webhooks-cc/demo" },
        },
      })
    );
    expect(preview.url).toBe("http://localhost:3001/webhooks");
    expect(preview.headers["x-hub-signature-256"]).toBeTruthy();
    expect(preview.body).toContain("mcp-preview");

    const usage = parseJsonResult(await handlers.get_usage({}));
    expect(usage.limit).toBeGreaterThan(0);
    expect(usage.used).toBeGreaterThanOrEqual(0);
    expect(typeof usage.periodEnd === "string" || usage.periodEnd === null).toBe(true);
  });

  it("wraps endpoint and request analysis tools against the local stack", async () => {
    const endpoint = parseJsonResult(
      await handlers.create_endpoint({
        name: "MCP Wrapper Test",
        expiresIn: "1h",
      })
    );
    createdSlugs.add(endpoint.slug);

    expect(endpoint.isEphemeral).toBe(true);

    const markerBase = `mcp-tool-${Date.now()}`;
    const firstBody = {
      marker: `${markerBase}-1`,
      repository: { full_name: "webhooks-cc/demo" },
      data: { object: { id: "req-1" } },
    };
    const secondBody = {
      marker: `${markerBase}-2`,
      repository: { full_name: "webhooks-cc/demo" },
      data: { object: { id: "req-2" } },
    };

    const waiting = handlers.wait_for_requests({
      endpointSlug: endpoint.slug,
      count: 2,
      timeout: "10s",
      pollInterval: "200ms",
      method: "POST",
    });

    parseJsonResult(
      await handlers.send_webhook({
        slug: endpoint.slug,
        provider: "github",
        template: "push",
        secret: "github_secret",
        body: firstBody,
      })
    );
    parseJsonResult(
      await handlers.send_webhook({
        slug: endpoint.slug,
        provider: "github",
        template: "push",
        secret: "github_secret",
        body: secondBody,
      })
    );

    const collected = parseJsonResult(await waiting);
    expect(collected.complete).toBe(true);
    expect(collected.timedOut).toBe(false);
    expect(collected.requests).toHaveLength(2);

    const firstRequestId = collected.requests[0].id;
    const secondRequestId = collected.requests[1].id;

    const verified = parseJsonResult(
      await handlers.verify_signature({
        requestId: firstRequestId,
        provider: "github",
        secret: "github_secret",
      })
    );
    expect(verified.valid).toBe(true);

    const extracted = parseJsonResult(
      await handlers.extract_from_request({
        requestId: firstRequestId,
        jsonPaths: ["marker", "repository.full_name", "data.object.id"],
      })
    );
    expect(extracted.marker).toBe(firstBody.marker);
    expect(extracted["repository.full_name"]).toBe("webhooks-cc/demo");
    expect(extracted["data.object.id"]).toBe("req-1");

    const compared = parseJsonResult(
      await handlers.compare_requests({
        leftRequestId: firstRequestId,
        rightRequestId: secondRequestId,
      })
    );
    expect(compared.matches).toBe(false);
    expect(compared.differences.body.type).toBe("json");

    let searchResults = parseJsonResult(
      await handlers.search_requests({
        slug: endpoint.slug,
        q: firstBody.marker,
        from: "10m",
        limit: 10,
      })
    );
    let countResult = parseJsonResult(
      await handlers.count_requests({
        slug: endpoint.slug,
        q: firstBody.marker,
        from: "10m",
      })
    );

    if (searchResults.length === 0 || countResult.count === 0) {
      await waitForRetainedSearch(async () => {
        searchResults = parseJsonResult(
          await handlers.search_requests({
            slug: endpoint.slug,
            q: firstBody.marker,
            from: "10m",
            limit: 10,
          })
        );
        countResult = parseJsonResult(
          await handlers.count_requests({
            slug: endpoint.slug,
            q: firstBody.marker,
            from: "10m",
          })
        );
        return searchResults.length > 0 && countResult.count > 0;
      });
    }

    expect(
      searchResults.some((result: { body?: string }) => result.body?.includes(firstBody.marker))
    ).toBe(true);
    expect(countResult.count).toBeGreaterThanOrEqual(1);

    const cleared = parseJsonResult(await handlers.clear_requests({ slug: endpoint.slug }));
    expect(cleared.cleared).toBe(true);

    let requestsAfterClear = parseJsonResult(
      await handlers.list_requests({ endpointSlug: endpoint.slug, limit: 10 })
    );

    if (requestsAfterClear.length > 0) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5_000 && requestsAfterClear.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        requestsAfterClear = parseJsonResult(
          await handlers.list_requests({ endpointSlug: endpoint.slug, limit: 10 })
        );
      }
    }

    expect(requestsAfterClear).toHaveLength(0);
  }, 30_000);
});
