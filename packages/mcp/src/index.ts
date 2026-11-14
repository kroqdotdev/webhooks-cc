import { McpServer } from "@modelcontextprotocol/server";
import { WebhooksCC } from "@webhooks-cc/sdk";
import { localToolGroups, toolSelection, type ToolSelectionOptions } from "./local-tools";
import { registerPrompts } from "./prompts";
import { attachSkill } from "./skills";
import { attachInspector, localDashboardOrigins } from "./app";
import { registerResources } from "./resources";
import { registerSandboxTools } from "./sandbox-tools";
import { MCP_USER_AGENT, VERSION } from "./version";

export interface CreateServerOptions extends ToolSelectionOptions {
  /** API key for webhooks.cc (default: reads WHK_API_KEY env var) */
  apiKey?: string;
  /** Custom webhook receiver URL (default: reads WHK_WEBHOOK_URL or https://go.webhooks.cc) */
  webhookUrl?: string;
  /** Custom API base URL (default: https://webhooks.cc) */
  baseUrl?: string;
  /**
   * Without an API key: the agent credential file that keeps the sandbox and
   * a human's connection across restarts (default: WHK_AGENT_FILE, else
   * ~/.config/whk/agent.json or the platform's equivalent); false for none.
   */
  credentialsFile?: string | false;
}

const INSTRUCTIONS =
  "webhooks.cc captures webhooks and inbound email for testing. Start with create_endpoint, send to its URL (or point a provider at it), then wait_for_request and get_request to inspect what arrived. send_webhook sends a signed test webhook to an endpoint; verify_signature checks a captured request. With an account the tools come in groups: when a tool you need is missing, enable_tools loads its group (teams, domains, Google Sheets, billing and keys, and more).";

/**
 * Create an MCP server with the webhooks.cc tools, prompts, and resources registered.
 *
 * Which tools it lists: the groups in `tools` (default WHK_MCP_TOOLS, such
 * as "all" or "core,teams"); without a setting, the core tools, and every
 * group for clients that take long tool lists (Claude Code, Codex, ChatGPT)
 * once they connect. enable_tools loads more groups during a session.
 * `readOnly` (default WHK_MCP_READ_ONLY) lists only the tools that change
 * nothing.
 *
 * @example
 * ```ts
 * import { createServer } from "@webhooks-cc/mcp";
 * import { serveStdio } from "@modelcontextprotocol/server/stdio";
 *
 * serveStdio(() => createServer({ apiKey: "whcc_..." }));
 * ```
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const apiKey = options.apiKey ?? process.env.WHK_API_KEY;

  const webhookUrl = options.webhookUrl ?? process.env.WHK_WEBHOOK_URL;
  const baseUrl = options.baseUrl ?? process.env.WHK_BASE_URL;

  const server = new McpServer(
    { name: "webhooks-cc", title: "webhooks.cc", version: VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: INSTRUCTIONS,
      // Connecting an account or loading groups changes many tools at once:
      // one list_changed, not dozens.
      debouncedNotificationMethods: ["notifications/tools/list_changed"],
    }
  );
  // The agent skill, served to clients that read skills from their servers.
  attachSkill(server);
  // The request inspector, which get_request and get_email name for clients with MCP Apps.
  attachInspector(server);
  const groups = localToolGroups(server, toolSelection(options), localDashboardOrigins(baseUrl));

  // No API key: the account a human connected this agent to before (saved in
  // the agent credential file), else the agent sandbox (auth.md v0.6). The
  // endpoint and request tools work without an account, and connect_account /
  // wait_for_connection swap in the account's tools once a human connects it.
  if (!apiKey) {
    registerSandboxTools(server, {
      baseUrl,
      webhookUrl,
      credentialsFile: options.credentialsFile,
      toolGroups: groups,
    });
    registerPrompts(server);
    return server;
  }

  const client = new WebhooksCC({ apiKey, webhookUrl, baseUrl, userAgent: MCP_USER_AGENT });

  groups.show(client);
  registerPrompts(server);
  registerResources(server, client);

  return server;
}

export { registerTools, REMOTE_MAX_WAIT_MS } from "./tools";
export type {
  RegisterToolsOptions,
  RegisteredToolHandle,
  ToolAnnotationsHint,
  ToolServer,
} from "./tools";
export { registerSandboxTools, registerAgentRegistrationTools } from "./sandbox-tools";
export type { SandboxToolOptions } from "./sandbox-tools";
export { registerPrompts } from "./prompts";
export { attachInspector, INSPECTOR_URI, INSPECTOR_URI_TEMPLATE, APP_MIME_TYPE } from "./app";
export { registerResources } from "./resources";
export { asToolServer, LocalToolGroups, localToolGroups, toolSelection } from "./local-tools";
export type { ToolSelection, ToolSelectionOptions } from "./local-tools";
export {
  clientLoadsEverything,
  defaultToolGroups,
  ENABLE_TOOLS,
  parseToolGroups,
  TOOL_CATALOG,
  TOOL_GROUP_NAMES,
  TOOL_GROUPS,
  toolAnnotations,
  type ToolGroup,
} from "./catalog";
