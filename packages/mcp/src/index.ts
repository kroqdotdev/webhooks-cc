import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerSandboxTools } from "./sandbox-tools";
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
 * Create an MCP server with all webhooks.cc tools, prompts, and resources registered.
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

  const webhookUrl = options.webhookUrl ?? process.env.WHK_WEBHOOK_URL;
  const baseUrl = options.baseUrl ?? process.env.WHK_BASE_URL;

  const server = new McpServer(
    { name: "webhooks-cc", version: VERSION },
    // Connecting an account swaps every tool at once: one list_changed, not dozens.
    { debouncedNotificationMethods: ["notifications/tools/list_changed"] }
  );

  // No API key: the agent sandbox (auth.md v0.6). The endpoint and request
  // tools work without an account, and connect_account / wait_for_connection
  // swap in the full tools once a human connects the agent to their account.
  if (!apiKey) {
    registerSandboxTools(server, { baseUrl, webhookUrl });
    registerPrompts(server);
    return server;
  }

  const client = new WebhooksCC({ apiKey, webhookUrl, baseUrl });

  registerTools(server, client);
  registerPrompts(server);
  registerResources(server, client);

  return server;
}

export { registerTools } from "./tools";
export { registerSandboxTools, registerAgentRegistrationTools } from "./sandbox-tools";
export type { SandboxToolOptions } from "./sandbox-tools";
export { registerPrompts } from "./prompts";
export { registerResources } from "./resources";
