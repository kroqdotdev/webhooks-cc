import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { registerTools } from "../tools";

const EXPECTED_TOOLS = [
  "create_endpoint",
  "list_endpoints",
  "get_endpoint",
  "update_endpoint",
  "delete_endpoint",
  "send_webhook",
  "list_requests",
  "get_request",
  "wait_for_request",
  "replay_request",
  "describe",
];

describe("registerTools", () => {
  it("registers all 11 tools", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const toolSpy = vi.spyOn(server, "tool");

    const client = new WebhooksCC({ apiKey: "whcc_test" });
    registerTools(server, client);

    expect(toolSpy).toHaveBeenCalledTimes(11);

    const registeredNames = toolSpy.mock.calls.map((call) => call[0]);
    for (const name of EXPECTED_TOOLS) {
      expect(registeredNames).toContain(name);
    }
  });

  it("all tools have descriptions", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const toolSpy = vi.spyOn(server, "tool");

    const client = new WebhooksCC({ apiKey: "whcc_test" });
    registerTools(server, client);

    for (const call of toolSpy.mock.calls) {
      // 4-arg form: (name, description, schema, handler)
      const description = call[1];
      expect(typeof description).toBe("string");
      expect((description as string).length).toBeGreaterThan(10);
    }
  });

  it("all tools have handler functions", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const toolSpy = vi.spyOn(server, "tool");

    const client = new WebhooksCC({ apiKey: "whcc_test" });
    registerTools(server, client);

    for (const call of toolSpy.mock.calls) {
      // 4-arg form: last arg is the handler
      const handler = call[call.length - 1];
      expect(typeof handler).toBe("function");
    }
  });

  it("all tools have Zod schemas", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const toolSpy = vi.spyOn(server, "tool");

    const client = new WebhooksCC({ apiKey: "whcc_test" });
    registerTools(server, client);

    for (const call of toolSpy.mock.calls) {
      // 4-arg form: (name, description, schema, handler)
      const schema = call[2];
      expect(typeof schema).toBe("object");
      expect(schema).not.toBeNull();
    }
  });
});

describe("createServer", () => {
  it("throws without API key", async () => {
    const { createServer } = await import("../index");
    // Ensure env var is not set
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
