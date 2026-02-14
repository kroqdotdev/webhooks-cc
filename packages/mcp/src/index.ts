import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { registerTools } from "./tools";

declare const PKG_VERSION: string | undefined;

const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";

export interface CreateServerOptions {
  /** API key for webhooks.cc (default: reads WHK_API_KEY env var) */
  apiKey?: string;
  /** Custom webhook receiver URL (default: reads WHK_WEBHOOK_URL or https://go.webhooks.cc) */
  webhookUrl?: string;
  /** Custom API base URL (default: https://webhooks.cc) */
  baseUrl?: string;
}

/**
 * Create an MCP server with all webhooks.cc tools registered.
 *
 * @example
 * ```ts
 * import { createServer } from "@webhooks-cc/mcp";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 * const server = createServer({ apiKey: "whcc_..." });
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const apiKey = options.apiKey ?? process.env.WHK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing API key. Set WHK_API_KEY environment variable or pass apiKey option.");
  }

  const client = new WebhooksCC({
    apiKey,
    webhookUrl: options.webhookUrl ?? process.env.WHK_WEBHOOK_URL,
    baseUrl: options.baseUrl ?? process.env.WHK_BASE_URL,
  });

  const server = new McpServer({
    name: "webhooks-cc",
    version: VERSION,
  });

  registerTools(server, client);

  return server;
}

export { registerTools } from "./tools";
