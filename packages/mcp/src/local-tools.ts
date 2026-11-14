import {
  CLIENT_INFO_META_KEY,
  type McpServer,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server";
import { sdkToolResult, toolCallFrom } from "./sdk-call";
import type { WebhooksCC } from "@webhooks-cc/sdk";
import { z } from "zod";
import {
  clientLoadsEverything,
  ENABLE_TOOLS,
  parseToolGroups,
  TOOL_CATALOG,
  TOOL_GROUP_NAMES,
  TOOL_GROUPS,
  toolTitle,
  type ToolGroup,
} from "./catalog";
import {
  jsonContent,
  registerTools,
  withErrorHandling,
  type RegisteredToolHandle,
  type ToolAnnotationsHint,
  type ToolServer,
} from "./tools";

/**
 * The local (stdio) server's view of its tools: which groups it loads, and
 * the enable_tools tool that loads more. The hosted server chooses its own
 * groups per request and has no enable_tools.
 */

/** registerTools' view of a v2 McpServer: each tool with its title and annotations. */
export function asToolServer(server: McpServer): ToolServer {
  return {
    tool(name, description, shape, handler, annotations) {
      const registered = server.registerTool(
        name,
        {
          title: annotations?.title,
          description,
          inputSchema: z.object(shape),
          annotations,
        },
        async (args: unknown, ctx: ServerContext) =>
          sdkToolResult(
            await handler(args as Parameters<typeof handler>[0], toolCallFrom(server, ctx))
          )
      );
      return { remove: () => registered.remove() };
    },
  };
}

/** Which tools a local server lists. */
export interface ToolSelection {
  /** The groups named by WHK_MCP_TOOLS (or the tools option); null to choose by client. */
  groups: ReadonlySet<ToolGroup> | null;
  /** Only the tools that change nothing (WHK_MCP_READ_ONLY). */
  readOnly: boolean;
}

export interface ToolSelectionOptions {
  /** Tool groups, such as "all" or "core,teams" (default: WHK_MCP_TOOLS, else by client). */
  tools?: string;
  /** Only the tools that change nothing (default: WHK_MCP_READ_ONLY). */
  readOnly?: boolean;
}

/** Settings already warned about: serving stdio can make more than one server. */
const warned = new Set<string>();

/** The selection from the options, else the environment. Unknown group names go to stderr. */
export function toolSelection(options: ToolSelectionOptions = {}): ToolSelection {
  const fromOption = options.tools !== undefined;
  const parsed = parseToolGroups(fromOption ? options.tools : process.env.WHK_MCP_TOOLS);
  const setting = fromOption ? options.tools : process.env.WHK_MCP_TOOLS;
  if (parsed && parsed.unknown.length > 0 && !warned.has(setting ?? "")) {
    warned.add(setting ?? "");
    // Never stdout: on stdio that is the protocol.
    console.error(
      `webhooks-cc-mcp: unknown tool groups in ${fromOption ? "tools" : "WHK_MCP_TOOLS"}: ${parsed.unknown.join(", ")} (known: all, ${TOOL_GROUP_NAMES.join(", ")})`
    );
  }
  const readOnly =
    options.readOnly ?? /^(1|true|yes|on)$/i.test((process.env.WHK_MCP_READ_ONLY ?? "").trim());
  return { groups: parsed?.groups ?? null, readOnly };
}

/** The groups past core, which enable_tools takes. */
const EXTRA_GROUPS = TOOL_GROUP_NAMES.filter((group) => group !== "core") as [
  Exclude<ToolGroup, "core">,
  ...Exclude<ToolGroup, "core">[],
];

const ENABLE_TOOLS_ANNOTATIONS: ToolAnnotationsHint = {
  title: toolTitle(ENABLE_TOOLS),
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * An account's tools on a local server, by group. show() registers the
 * groups the server starts with (and enable_tools while any group is left),
 * load() adds groups, and the client's name (clientIdentified) loads every
 * group for clients that take long tool lists, unless WHK_MCP_TOOLS chose.
 * Everything registered in one tick reaches the client as one list_changed,
 * since the server debounces it.
 */
export class LocalToolGroups {
  private client: WebhooksCC | null = null;
  private loaded = new Set<ToolGroup>();
  private handles: RegisteredToolHandle[] = [];
  private enableTools: RegisteredToolHandle | null = null;
  private clientKnown = false;
  private clientName: string | undefined;

  constructor(
    private readonly server: ToolServer,
    readonly selection: ToolSelection
  ) {}

  /** The groups an account's tools start with. */
  private startingGroups(): ToolGroup[] {
    if (this.selection.groups) return [...this.selection.groups];
    return this.clientKnown && clientLoadsEverything(this.clientName)
      ? [...TOOL_GROUP_NAMES]
      : ["core"];
  }

  /** Registers the tools for an account; the handle removes them all again. */
  show(client: WebhooksCC): RegisteredToolHandle {
    this.hide();
    this.client = client;
    this.load(this.startingGroups());
    return { remove: () => this.hide() };
  }

  /** Removes every account tool, enable_tools included. */
  hide(): void {
    for (const handle of this.handles) handle.remove();
    this.enableTools?.remove();
    this.handles = [];
    this.enableTools = null;
    this.loaded.clear();
    this.client = null;
  }

  /** The groups loaded now. */
  loadedGroups(): ToolGroup[] {
    return TOOL_GROUP_NAMES.filter((group) => this.loaded.has(group));
  }

  /**
   * The client named itself (initialize, or a 2026-07-28 request's _meta).
   * Without a WHK_MCP_TOOLS setting, a client that takes long tool lists
   * gets every group. Only the first name counts.
   */
  clientIdentified(name: string | undefined): void {
    if (this.clientKnown) return;
    this.clientKnown = true;
    this.clientName = name;
    if (this.selection.groups || !clientLoadsEverything(name)) return;
    if (this.client) this.load(TOOL_GROUP_NAMES);
  }

  /** Registers the groups not loaded yet; returns the tools each one added. */
  load(groups: readonly ToolGroup[]): Partial<Record<ToolGroup, string[]>> {
    const client = this.client;
    const fresh = groups.filter((group) => !this.loaded.has(group));
    if (!client || fresh.length === 0) return {};
    const added: Partial<Record<ToolGroup, string[]>> = {};
    for (const group of fresh) added[group] = [];
    const server = this.server;
    const recorder: ToolServer = {
      tool(name, description, shape, handler, annotations) {
        added[TOOL_CATALOG[name].group]?.push(name);
        return server.tool(name, description, shape, handler, annotations);
      },
    };
    this.handles.push(
      ...registerTools(recorder, client, {
        groups: new Set(fresh),
        readOnly: this.selection.readOnly,
      })
    );
    for (const group of fresh) this.loaded.add(group);
    this.showEnableTools();
    return added;
  }

  /** (Re)registers enable_tools with the current groups, or drops it once all are loaded. */
  private showEnableTools(): void {
    this.enableTools?.remove();
    this.enableTools = null;
    const left = EXTRA_GROUPS.filter((group) => !this.loaded.has(group));
    if (!this.client || left.length === 0) return;
    const lines = EXTRA_GROUPS.map(
      (group) => `- ${group}${this.loaded.has(group) ? " (loaded)" : ""}: ${TOOL_GROUPS[group]}`
    );
    const description = [
      "Load more webhooks.cc tools into this session. This server lists its core tools by default; the rest come in groups. If a tool you need is missing, load its group, then look at the tool list again.",
      "Groups:",
      ...lines,
      this.selection.readOnly
        ? "This server is read-only (WHK_MCP_READ_ONLY): a group brings only its tools that change nothing."
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    this.enableTools = this.server.tool(
      ENABLE_TOOLS,
      description,
      {
        groups: z
          .array(z.enum([...EXTRA_GROUPS, "all"]))
          .min(1)
          .describe('Groups to load, or ["all"]'),
      },
      withErrorHandling(async ({ groups }) => {
        const wanted: ToolGroup[] = groups.includes("all")
          ? [...TOOL_GROUP_NAMES]
          : (groups as ToolGroup[]);
        const already = wanted.filter((group) => group !== "core" && this.loaded.has(group));
        const added = this.load(wanted);
        const loadedNow = Object.keys(added).length > 0;
        return jsonContent({
          added,
          ...(already.length > 0 ? { alreadyLoaded: [...new Set(already)] } : {}),
          loaded: this.loadedGroups(),
          ...(this.selection.readOnly ? { readOnly: true } : {}),
          note: loadedNow
            ? "The tool list changed. If your client does not show the new tools, ask the user to set WHK_MCP_TOOLS (for example all) and restart the server."
            : "Nothing new to load.",
        });
      }),
      ENABLE_TOOLS_ANNOTATIONS
    );
  }
}

/** The client's name on a 2026-07-28 request, which carries it in _meta. */
function modernClientName(message: unknown): string | undefined | null {
  if (typeof message !== "object" || message === null) return null;
  const params = (message as { params?: { _meta?: Record<string, unknown> } }).params;
  const info = params?._meta?.[CLIENT_INFO_META_KEY];
  if (typeof info !== "object" || info === null) return null;
  const name = (info as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Tells groups which client connected: after a 2025-era initialize (the
 * initialized notification), or from the first 2026-07-28 request, whose
 * _meta names the client and which is seen before the server handles it,
 * so the tools are in place for that request.
 */
export function watchClient(server: McpServer, groups: LocalToolGroups): void {
  const low = server.server;
  const initialized = low.oninitialized;
  low.oninitialized = () => {
    initialized?.();
    // Deprecated for 2026-07-28 requests, but where a 2025-era client's
    // initialize lands; modern clients are read from _meta below.
    groups.clientIdentified(low.getClientVersion()?.name);
  };
  const connect = server.connect.bind(server);
  server.connect = async (transport: Transport) => {
    // The protocol layer calls a handler already on the transport first.
    const previous = transport.onmessage;
    transport.onmessage = (message, extra) => {
      const name = modernClientName(message);
      if (name !== null) groups.clientIdentified(name);
      previous?.call(transport, message, extra);
    };
    return connect(transport);
  };
}

/** Groups for a server, watching for the client that connects. */
export function localToolGroups(server: McpServer, selection: ToolSelection): LocalToolGroups {
  const groups = new LocalToolGroups(asToolServer(server), selection);
  watchClient(server, groups);
  return groups;
}
