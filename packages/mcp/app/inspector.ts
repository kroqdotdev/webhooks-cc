import {
  HostBridge,
  PROTOCOL_VERSION,
  type HostContext,
  type HostInit,
  type ToolResultParams,
} from "./bridge";
import { button, el } from "./dom";
import { recentOf, slugForEndpoint, viewOf, type RecentItem, type View } from "./model";
import { problem, skeleton, strip, viewPanel, type Abilities, type StripState } from "./view";

/**
 * The request inspector: shows the request or email of the get_request or
 * get_email result the host hands it, and the endpoint's recent requests,
 * which it loads through the host (tools/call). It never reaches the
 * network itself and never opens a link on its own.
 */

const RECENT_LIMIT = 10;

const bridge = new HostBridge(window.parent);
const root = document.getElementById("app") as HTMLElement;
const main = el("div", { class: "main" });
const banner = el("div", { class: "banner" });
const recentSlot = el("div", { class: "recent-slot" });
root.replaceChildren(banner, main, recentSlot);
main.appendChild(skeleton());

const abilities: Abilities = {
  copy: false,
  openLink: null,
  locale: undefined,
  timeZone: undefined,
};

let view: View | null = null;
let upgrading = false;
let toolArgs: Record<string, unknown> = {};
let recent: StripState | null = null;
/** Endpoint ids already looked up, with their slugs. */
const slugs = new Map<string, string | null>();
/** Bumped for every request shown, so a late answer for an older one is dropped. */
let generation = 0;

function applyContext(context: HostContext | undefined): void {
  if (!context) return;
  const html = document.documentElement;
  if (context.theme === "light" || context.theme === "dark") html.dataset.theme = context.theme;
  const variables = context.styles?.variables;
  if (variables) {
    for (const [name, value] of Object.entries(variables)) {
      if (name.startsWith("--") && typeof value === "string" && value)
        html.style.setProperty(name, value);
    }
  }
  const fonts = context.styles?.css?.fonts;
  if (typeof fonts === "string" && fonts) {
    let style = document.getElementById("host-fonts");
    if (!style) {
      style = el("style", { attrs: { id: "host-fonts" } });
      document.head.appendChild(style);
    }
    // The host's own @font-face rules, from the host, never from captured data.
    style.textContent = fonts;
  }
  if (context.locale) abilities.locale = context.locale;
  if (context.timeZone) abilities.timeZone = context.timeZone;
}

/** The JSON a tool answered with: its structuredContent, else its text. */
function resultData(result: ToolResultParams): unknown {
  if (result.structuredContent && typeof result.structuredContent === "object")
    return result.structuredContent;
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(result: ToolResultParams): string | null {
  const text = result.content?.find((block) => block.type === "text")?.text;
  return text ? text.slice(0, 2_000) : null;
}

/** Calls one of the server's tools through the host. */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await bridge.request<ToolResultParams>("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(errorText(result) ?? `${name} failed.`);
  return resultData(result);
}

function renderView(): void {
  main.replaceChildren(view ? viewPanel(view, abilities, upgrading) : skeleton());
}

function renderRecent(): void {
  recentSlot.replaceChildren(recent ? strip(recent, pick, () => void loadRecent(true)) : "");
}

function showBanner(title: string | null, detail: string | null = null): void {
  banner.replaceChildren(title ? problem(title, detail) : "");
}

/** Shows a tool result: the request or email it holds, or what went wrong. */
function show(result: ToolResultParams): void {
  generation += 1;
  showBanner(null);
  if (result.isError) {
    view = null;
    main.replaceChildren(problem("The tool could not load this request.", errorText(result)));
    return;
  }
  const next = viewOf(resultData(result));
  if (!next) {
    view = null;
    main.replaceChildren(problem("This result is not a captured request or email.", null));
    return;
  }
  present(next);
}

function present(next: View): void {
  view = next;
  upgrading = next.kind === "email" && !next.full && next.id !== null;
  renderView();
  if (upgrading && next.id) void upgrade(next.id, generation);
  // The endpoint's recent requests cost tool calls (counted against the
  // account's limit on the hosted server): loaded when asked, then kept up
  // as the person clicks through.
  if (recent) void findRecent(next);
  else offerRecent(next);
}

function offerRecent(current: View): void {
  recentSlot.replaceChildren(
    button("Show recent requests at this endpoint", () => void findRecent(current))
  );
}

/**
 * get_request answers an email in its compact form, without codes and
 * links: ask get_email for the same email.
 */
async function upgrade(id: string, asked: number): Promise<void> {
  try {
    const data = await callTool("get_email", { requestId: id });
    if (asked !== generation) return;
    const full = viewOf(data);
    if (full && full.kind === "email") view = full;
  } catch {
    // The compact email stays; nothing is lost.
  }
  if (asked !== generation) return;
  upgrading = false;
  renderView();
}

/** The endpoint the request belongs to, then its recent requests. */
async function findRecent(current: View): Promise<void> {
  let slug: string | null = current.kind === "email" ? current.slug : null;
  if (!slug && typeof toolArgs.endpointSlug === "string") slug = toolArgs.endpointSlug;
  if (!slug && current.kind === "http" && current.endpointId) {
    if (!slugs.has(current.endpointId)) {
      try {
        slugs.set(
          current.endpointId,
          slugForEndpoint(await callTool("list_endpoints", {}), current.endpointId)
        );
      } catch {
        slugs.set(current.endpointId, null);
      }
    }
    slug = slugs.get(current.endpointId) ?? null;
  }
  if (!slug) {
    recent = null;
    renderRecent();
    return;
  }
  if (recent && recent.slug === slug) {
    recent.currentId = current.id;
    recent.loadingId = null;
    renderRecent();
    return;
  }
  recent = {
    slug,
    items: [],
    currentId: current.id,
    loadingId: null,
    refreshing: true,
    failed: null,
  };
  await loadRecent(false);
}

async function loadRecent(again: boolean): Promise<void> {
  if (!recent) return;
  const state = recent;
  state.refreshing = true;
  if (again) renderRecent();
  try {
    state.items = recentOf(
      await callTool("list_requests", { endpointSlug: state.slug, limit: RECENT_LIMIT })
    );
    state.failed = null;
  } catch (error) {
    if (!again && state.items.length === 0) {
      // A host that does not pass tool calls on: no strip at all.
      recent = recent === state ? null : recent;
      renderRecent();
      return;
    }
    state.failed =
      `Could not load recent requests. ${error instanceof Error ? error.message : ""}`.trim();
  }
  state.refreshing = false;
  if (recent === state) renderRecent();
}

async function pick(item: RecentItem): Promise<void> {
  if (!recent || recent.loadingId) return;
  if (item.id === recent.currentId) return;
  recent.loadingId = item.id;
  renderRecent();
  const asked = ++generation;
  try {
    const data = await callTool(item.email ? "get_email" : "get_request", { requestId: item.id });
    if (asked !== generation) return;
    const next = viewOf(data);
    if (!next) throw new Error("The answer was not a request.");
    showBanner(null);
    present(next);
  } catch (error) {
    if (asked !== generation) return;
    showBanner("Could not open that request.", error instanceof Error ? error.message : null);
    if (recent) recent.loadingId = null;
    renderRecent();
  }
}

// The size the host gives the frame follows the page, or it stays 0 high.
let lastHeight = 0;
new ResizeObserver(() => {
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  bridge.notify("ui/notifications/size-changed", { height });
}).observe(root);

// Handlers first: the host may send the tool's input and result right after initialize.
bridge.on("ui/notifications/tool-input", (params) => {
  const args = params.arguments;
  toolArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
});
bridge.on("ui/notifications/tool-result", (params) => show(params as ToolResultParams));
bridge.on("ui/notifications/tool-cancelled", () => {
  if (!view) main.replaceChildren(problem("The tool call was cancelled.", null));
});
bridge.on("ui/notifications/host-context-changed", (params) => applyContext(params as HostContext));

/**
 * Whether the frame was given the clipboard (an allow="clipboard-write"
 * attribute), for hosts that grant it without saying so in their
 * capabilities. Only Chromium can tell; elsewhere the capability decides.
 */
function frameAllowsClipboard(): boolean {
  const policy = (
    document as Document & {
      featurePolicy?: { allowsFeature(feature: string): boolean };
    }
  ).featurePolicy;
  try {
    return (
      policy?.allowsFeature("clipboard-write") === true &&
      typeof navigator.clipboard?.writeText === "function"
    );
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  try {
    const init = await bridge.request<HostInit>("ui/initialize", {
      appInfo: { name: "webhooks-cc-inspector", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    applyContext(init.hostContext);
    abilities.copy =
      Boolean(init.hostCapabilities?.sandbox?.permissions?.clipboardWrite) ||
      frameAllowsClipboard();
    if (init.hostCapabilities?.openLinks) {
      abilities.openLink = async (url) => {
        const answer = await bridge.request<{ isError?: boolean }>("ui/open-link", { url });
        if (answer?.isError) throw new Error("The client did not open the link.");
      };
    }
    bridge.notify("ui/notifications/initialized", {});
    // Abilities can change what the first view shows.
    if (view) renderView();
  } catch {
    main.replaceChildren(problem("This client did not start the inspector.", null));
  }
}

void start();
