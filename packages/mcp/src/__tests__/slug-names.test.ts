import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index";

// An endpoint's slug is `slug` on some tools and `endpointSlug` on others.
// Each tool keeps listing its own name and takes the other too.

let api: Server;
let baseUrl: string;
const paths: string[] = [];

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

async function connect() {
  const server = createServer({ apiKey: "whcc_test", baseUrl, tools: "all" });
  const client = new Client({ name: "slug-names-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Listed = { properties?: Record<string, { description?: string }>; required?: string[] };

describe("an endpoint's slug under either name", () => {
  it("keeps each tool's listed name, and names an endpoint with it", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema as Listed]));
      expect(byName.get("send_webhook")?.required).toContain("slug");
      expect(byName.get("send_webhook")?.properties).not.toHaveProperty("endpointSlug");
      expect(byName.get("list_requests")?.required).toContain("endpointSlug");
      expect(byName.get("list_requests")?.properties).not.toHaveProperty("slug");
      for (const tool of tools) {
        const properties = (tool.inputSchema as Listed).properties ?? {};
        const names = ["slug", "endpointSlug"].filter((name) => name in properties);
        // Never both: the other name is the alias.
        expect(names.length, tool.name).toBeLessThan(2);
        for (const name of names) {
          // Only an endpoint's slug is aliased.
          expect(properties[name].description ?? "", `${tool.name}.${name}`).toMatch(/endpoint/i);
        }
      }
    } finally {
      await client.close();
    }
  });

  it("takes endpointSlug where slug is listed, and slug where endpointSlug is", async () => {
    const client = await connect();
    try {
      paths.length = 0;
      const sent = await client.callTool({
        name: "get_endpoint",
        arguments: { endpointSlug: "acme-one" },
      });
      // Reached the API with the slug, rather than refused as a missing argument.
      expect(
        paths.some((path) => path.includes("acme-one")),
        JSON.stringify(sent)
      ).toBe(true);

      paths.length = 0;
      const listed = await client.callTool({
        name: "list_requests",
        arguments: { slug: "acme-two" },
      });
      expect(
        paths.some((path) => path.includes("acme-two")),
        JSON.stringify(listed)
      ).toBe(true);

      paths.length = 0;
      await client.callTool({ name: "get_endpoint", arguments: { slug: "acme-three" } });
      expect(paths.some((path) => path.includes("acme-three"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("refuses two different endpoints under the two names", async () => {
    const client = await connect();
    try {
      paths.length = 0;
      const result = (await client.callTool({
        name: "get_endpoint",
        arguments: { slug: "acme-one", endpointSlug: "acme-two" },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("name different endpoints");
      expect(paths).toEqual([]);
      // The same slug under both names is fine.
      await client.callTool({
        name: "get_endpoint",
        arguments: { slug: "acme-one", endpointSlug: "acme-one" },
      });
      expect(paths.some((path) => path.includes("acme-one"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("ignores null or an empty string under the other name", async () => {
    const client = await connect();
    try {
      for (const other of [null, ""]) {
        paths.length = 0;
        const result = (await client.callTool({
          name: "get_endpoint",
          arguments: { slug: "acme-four", endpointSlug: other },
        })) as { content: Array<{ text?: string }> };
        expect(result.content[0].text).not.toContain("name different endpoints");
        expect(paths.some((path) => path.includes("acme-four"))).toBe(true);
      }
    } finally {
      await client.close();
    }
  });
});
