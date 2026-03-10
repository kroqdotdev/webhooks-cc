import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { createServer } from "../index";

const API_KEY = process.env.WHK_API_KEY;
const BASE_URL = process.env.WHK_BASE_URL ?? "https://webhooks.cc";
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "https://go.webhooks.cc";

function parseToolResult(result: {
  [key: string]: unknown;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}) {
  expect(result.isError).not.toBe(true);
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

function parseResourceText(result: {
  [key: string]: unknown;
  contents: Array<{ text?: string; blob?: string }>;
}) {
  expect(result.contents[0]?.text).toBeTruthy();
  return JSON.parse(result.contents[0].text ?? "null");
}

describe.skipIf(!API_KEY)("MCP protocol integration tests", () => {
  const createdSlugs = new Set<string>();
  let rawClient: WebhooksCC;
  let mcpClient: Client;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      webhookUrl: WEBHOOK_URL,
    });

    rawClient = new WebhooksCC({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      webhookUrl: WEBHOOK_URL,
    });

    mcpClient = new Client(
      { name: "webhooks-cc-mcp-test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  });

  afterEach(async () => {
    for (const slug of createdSlugs) {
      try {
        await rawClient.endpoints.delete(slug);
      } catch {
        // ignore cleanup failures
      }
    }
    createdSlugs.clear();
  });

  afterAll(async () => {
    await Promise.all([mcpClient.close(), server.close()]);
  });

  it("exposes prompts and resources through the MCP protocol", async () => {
    const endpoint = parseToolResult(
      await mcpClient.callTool({
        name: "create_endpoint",
        arguments: {
          name: "Protocol Resource Test",
          expiresIn: "1h",
        },
      })
    );
    createdSlugs.add(endpoint.slug);

    parseToolResult(
      await mcpClient.callTool({
        name: "send_webhook",
        arguments: {
          slug: endpoint.slug,
          provider: "github",
          secret: "github_secret",
          body: {
            marker: `protocol-resource-${Date.now()}`,
            data: { object: { id: "req-resource" } },
          },
        },
      })
    );

    const captured = parseToolResult(
      await mcpClient.callTool({
        name: "wait_for_request",
        arguments: {
          endpointSlug: endpoint.slug,
          timeout: "10s",
        },
      })
    );

    const prompts = await mcpClient.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining([
        "debug_webhook_delivery",
        "setup_provider_testing",
        "compare_webhook_attempts",
      ])
    );

    const prompt = await mcpClient.getPrompt({
      name: "setup_provider_testing",
      arguments: { provider: "github" },
    });
    expect(prompt.messages[0].content.type).toBe("text");
    if (prompt.messages[0].content.type !== "text") {
      throw new Error("Expected text prompt content");
    }
    expect(prompt.messages[0].content.text).toContain("list_provider_templates");

    const resources = await mcpClient.listResources();
    expect(resources.resources.some((resource) => resource.uri === "webhooks://endpoints")).toBe(
      true
    );

    const resourceTemplates = await mcpClient.listResourceTemplates();
    expect(resourceTemplates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(
      expect.arrayContaining(["webhooks://endpoint/{slug}/recent", "webhooks://request/{id}"])
    );

    const endpointsOverview = parseResourceText(
      await mcpClient.readResource({ uri: "webhooks://endpoints" })
    );
    expect(Array.isArray(endpointsOverview.endpoints)).toBe(true);
    expect(
      endpointsOverview.endpoints.some((item: { slug: string }) => item.slug === endpoint.slug)
    ).toBe(true);

    const endpointRecent = parseResourceText(
      await mcpClient.readResource({ uri: `webhooks://endpoint/${endpoint.slug}/recent` })
    );
    expect(endpointRecent.endpoint.slug).toBe(endpoint.slug);
    expect(
      endpointRecent.requests.some((request: { id: string }) => request.id === captured.id)
    ).toBe(true);

    const requestDetails = parseResourceText(
      await mcpClient.readResource({ uri: `webhooks://request/${captured.id}` })
    );
    expect(requestDetails.id).toBe(captured.id);
  }, 20_000);

  it("runs bulk and composite tools through the MCP protocol", async () => {
    const created = parseToolResult(
      await mcpClient.callTool({
        name: "create_endpoints",
        arguments: {
          count: 2,
          namePrefix: "protocol-bulk",
          expiresIn: "1h",
        },
      })
    );

    expect(created.endpoints).toHaveLength(2);
    for (const endpoint of created.endpoints as Array<{ slug: string }>) {
      createdSlugs.add(endpoint.slug);
    }

    const deleted = parseToolResult(
      await mcpClient.callTool({
        name: "delete_endpoints",
        arguments: {
          slugs: [created.endpoints[0].slug],
        },
      })
    );
    expect(deleted.deleted).toEqual([created.endpoints[0].slug]);
    createdSlugs.delete(created.endpoints[0].slug);

    const flow = parseToolResult(
      await mcpClient.callTool({
        name: "test_webhook_flow",
        arguments: {
          provider: "github",
          secret: "github_secret",
          verifySignature: true,
          cleanup: true,
        },
      })
    );

    expect(flow.request.id).toBeTruthy();
    expect(flow.verification.valid).toBe(true);
    expect(flow.cleanedUp).toBe(true);
  }, 30_000);
});
