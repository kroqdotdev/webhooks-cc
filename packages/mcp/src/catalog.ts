/**
 * Every tool's group and behaviour hints, in one place. registerTools()
 * reads it for each tool it registers: the group decides whether a server
 * loads the tool (see TOOL_GROUPS), and the hints become the tool's MCP
 * annotations, so a client can tell reads from changes and changes from
 * deletions without guessing from the name. A test fails when a registered
 * tool has no entry here, or an entry names no tool.
 */

/**
 * The groups past the core. "core" is what every server loads unless told
 * otherwise; the rest load on request (WHK_MCP_TOOLS, ?tools= on the hosted
 * server, or enable_tools on a local one) or for clients that load tools on
 * demand themselves.
 */
export const TOOL_GROUPS = {
  core: "Endpoints, captured requests and emails, sending test webhooks, signatures, forwarding destinations, deliveries, previews of your local app and their logs, usage and approvals",
  forwarding:
    "The rest of forwarding: preview what a destination would send, the endpoint's forwarding settings and signing secret, test deliveries",
  layouts:
    "Email layouts and named fields: try layouts and fields on a captured email, add ready-made layouts, and AI setup",
  extras: "Bulk endpoint changes, favourites, request counts and payload schemas",
  teams: "Teams: members, invites, sharing endpoints with a team, and pricing team changes",
  account:
    "The account: billing and checkout links for the person to pay, API keys, connected agents, public share links to requests, and the display name",
  domains: "Custom inbound email domains: add, verify, route and remove them",
  sheets: "Google Sheets destinations: Google accounts, spreadsheets and their tabs",
  names: "Preview names: reserve, release and password-protect them",
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;
export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** What a tool does, as MCP's tool annotations describe it. */
interface Behaviour {
  /** Changes nothing anywhere. */
  readOnly?: true;
  /** Removes or gives up something that is not simply put back. */
  destructive?: true;
  /** Calling it again with the same arguments changes nothing more. */
  idempotent?: true;
  /** Reaches past webhooks.cc: a URL you name, an email inbox, Google, Anthropic. */
  openWorld?: true;
  /**
   * Shows its answer in the request inspector, an MCP App (app.ts) that
   * clients with MCP Apps render beside the result.
   */
  ui?: true;
}

interface CatalogEntry extends Behaviour {
  group: ToolGroup;
}

const read: Behaviour = { readOnly: true };
const write: Behaviour = {};
const update: Behaviour = { idempotent: true };
const remove: Behaviour = { destructive: true, idempotent: true };
/** Overwrites settings: the same call twice does nothing more, but the old values are gone. */
const replace: Behaviour = { destructive: true, idempotent: true };
const outward: Behaviour = { openWorld: true };

function group(name: ToolGroup, tools: Record<string, Behaviour>): Record<string, CatalogEntry> {
  return Object.fromEntries(
    Object.entries(tools).map(([tool, behaviour]) => [tool, { group: name, ...behaviour }])
  );
}

export const TOOL_CATALOG: Record<string, CatalogEntry> = {
  ...group("core", {
    create_endpoint: write,
    list_endpoints: read,
    get_endpoint: read,
    // Replaces what it is given (a mock response, the signing secret).
    update_endpoint: replace,
    delete_endpoint: remove,
    list_requests: read,
    search_requests: read,
    get_request: { ...read, ui: true },
    wait_for_request: { ...read, ui: true },
    wait_for_requests: read,
    replay_request: outward,
    compare_requests: read,
    extract_from_request: read,
    clear_requests: remove,
    send_webhook: write,
    send_to: outward,
    test_webhook_flow: outward,
    preview_webhook: read,
    preview_response: read,
    list_provider_templates: read,
    verify_signature: read,
    list_emails: read,
    get_email: { ...read, ui: true },
    wait_for_email: { ...read, ui: true },
    send_test_email: write,
    render_email: outward,
    list_destinations: read,
    add_destination: write,
    update_destination: replace,
    remove_destination: remove,
    list_deliveries: read,
    redeliver: outward,
    share_port: outward,
    list_shares: read,
    share_requests: read,
    stop_share: remove,
    get_usage: read,
    // Collecting an approved key hands it over once: not a pure read.
    wait_for_approval: write,
    describe: read,
  }),
  ...group("forwarding", {
    preview_destination: read,
    configure_forwarding: replace,
    // rotate: true replaces the secret, and receivers holding the old one fail.
    get_forwarding_secret: { destructive: true },
    test_forwarding: outward,
  }),
  ...group("layouts", {
    preview_layouts: read,
    list_layout_templates: read,
    add_layout_template: write,
    preview_email_fields: read,
    ai_setup_status: read,
    // Sends the chosen emails to Anthropic once the owner approves.
    ai_setup: outward,
  }),
  ...group("extras", {
    create_endpoints: write,
    delete_endpoints: remove,
    favorite_endpoint: update,
    count_requests: read,
    generate_payload_schema: read,
  }),
  ...group("teams", {
    list_teams: read,
    list_team_members: read,
    share_endpoint: update,
    unshare_endpoint: remove,
    create_team: write,
    rename_team: update,
    delete_team: remove,
    remove_team_member: remove,
    leave_team: remove,
    invite_to_team: outward,
    list_invites: read,
    answer_invite: write,
    withdraw_invite: remove,
    quote_team_change: read,
  }),
  ...group("account", {
    get_billing: read,
    list_api_keys: read,
    create_api_key: write,
    revoke_api_key: remove,
    rename_account: update,
    list_connected_agents: read,
    disconnect_agent: remove,
    list_share_links: read,
    create_share_link: write,
    revoke_share_link: remove,
    // Opens a checkout on Polar; nothing is charged until the person pays there.
    create_checkout: outward,
    wait_for_checkout: read,
  }),
  ...group("domains", {
    list_domains: read,
    add_domain: write,
    // A failed check counts toward lapsing a verified domain: not safe to repeat.
    verify_domain: { destructive: true },
    // Replaces the routing; a missing catch-all refuses mail.
    route_domain: replace,
    remove_domain: remove,
  }),
  ...group("sheets", {
    list_google_connections: read,
    connect_google: outward,
    pick_spreadsheet: outward,
    create_spreadsheet: outward,
    list_sheet_tabs: { readOnly: true, openWorld: true },
    disconnect_google: remove,
  }),
  ...group("names", {
    // The log of what visitors asked a running preview for.
    list_names: read,
    reserve_name: write,
    release_name: remove,
    set_name_password: update,
    // Opens the name to anyone again.
    clear_name_password: { destructive: true, idempotent: true },
  }),
};

/** The tool that loads more groups on a local server; always loaded there. */
export const ENABLE_TOOLS = "enable_tools";

/** MCP tool annotations for a catalogued tool. */
export function toolAnnotations(name: string): {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const entry = TOOL_CATALOG[name];
  const readOnly = entry?.readOnly === true;
  return {
    title: toolTitle(name),
    readOnlyHint: readOnly,
    // MCP reads a missing destructiveHint as true on any tool that writes.
    destructiveHint: !readOnly && entry?.destructive === true,
    idempotentHint: readOnly || entry?.idempotent === true,
    openWorldHint: entry?.openWorld === true,
  };
}

/** "create_api_key" -> "Create API key". */
export function toolTitle(name: string): string {
  const words = name.split("_").map((word) => TITLE_WORDS[word] ?? word);
  const first = words[0] ?? "";
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

const TITLE_WORDS: Record<string, string> = {
  api: "API",
  ai: "AI",
  mcp: "MCP",
};

/**
 * Which groups a server loads, from a setting such as "all", "core,teams" or
 * "core+teams". Unknown names are reported so the caller can say so; an
 * empty setting is the default. "core" is always loaded.
 */
export function parseToolGroups(
  setting: string | null | undefined
): { groups: Set<ToolGroup>; unknown: string[] } | null {
  if (setting === null || setting === undefined || setting.trim() === "") return null;
  const groups = new Set<ToolGroup>(["core"]);
  const unknown: string[] = [];
  for (const raw of setting.split(/[\s,+]+/)) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name === "all") {
      for (const g of TOOL_GROUP_NAMES) groups.add(g);
    } else if ((TOOL_GROUP_NAMES as string[]).includes(name)) {
      groups.add(name as ToolGroup);
    } else {
      unknown.push(raw.trim());
    }
  }
  return { groups, unknown };
}

/**
 * Clients that load a server's tools only when the model looks for them
 * (tool search) or set no limit on how many they take: they get every tool
 * by default, since a long list costs them nothing up front. Matched against
 * the client's own name from the MCP handshake. Every other client, Cursor
 * (about 40 tools across all servers), Windsurf (100) and VS Code (128 with
 * its own tools) among them, gets the core.
 */
const LOADS_EVERYTHING = [
  /^claude-code$/i,
  /^claude-ai$/i,
  /^claude$/i,
  /codex/i,
  /^openai-mcp$/i,
  /chatgpt/i,
];

export function clientLoadsEverything(clientName: string | undefined): boolean {
  if (!clientName) return false;
  // "Claude Code" (an OAuth app's name) and "claude-code" (the handshake's).
  const name = clientName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return LOADS_EVERYTHING.some((pattern) => pattern.test(name));
}

/** The groups for a server: the setting when there is one, else by client. */
export function defaultToolGroups(clientName: string | undefined): Set<ToolGroup> {
  return clientLoadsEverything(clientName) ? new Set(TOOL_GROUP_NAMES) : new Set(["core"]);
}
