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
 * get_email result the host hands it and, when the person asks and the host
 * passes tool calls on, the whole email and the endpoint's recent requests,
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
/** The host passes tool calls on (hostCapabilities.serverTools): only then is anything offered that calls one. */
let serverTools = false;
let loadingFull = false;
let fullFailed: string | null = null;
let toolArgs: Record<string, unknown> = {};
let recent: StripState | null = null;
/** Looking for the request's endpoint, after the person asked for recent requests. */
let finding = false;
/** Why the last ask for recent requests found no endpoint, shown beside the button. */
let recentMissing: string | null = null;
/** Endpoint ids looked up in list_endpoints, with their slugs (null: not listed). Failed or cut lookups are not kept. */
const slugs = new Map<string, string | null>();
/** Bumped for every request shown, so a late answer for an older one is dropped. */
let generation = 0;
/** Bumped for every ask for recent requests, so only the newest one changes the strip. */
let findToken = 0;

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

/** Calls one of the server's tools through the host: its JSON. */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return resultData(await callToolResult(name, args));
}

/** Calls one of the server's tools through the host: the whole result, _meta included. */
async function callToolResult(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResultParams> {
  const result = await bridge.request<ToolResultParams>("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(errorText(result) ?? `${name} failed.`);
  return result;
}

function renderView(): void {
  if (!view) {
    main.replaceChildren(skeleton());
    return;
  }
  const id = view.kind === "email" && !view.full ? view.id : null;
  main.replaceChildren(
    viewPanel(view, abilities, {
      load: serverTools && id ? () => void loadFull(id) : null,
      loading: loadingFull,
      failed: fullFailed,
    })
  );
}

function renderRecent(): void {
  if (recent) {
    recentSlot.replaceChildren(strip(recent, pick, () => void loadRecent()));
  } else if (!view || !serverTools) {
    recentSlot.replaceChildren("");
  } else {
    const ask = button(
      finding ? "Looking for the endpoint" : "Show recent requests at this endpoint",
      // The request shown at the click: a whole email may have replaced the compact one.
      () => {
        if (view) void findRecent(view, null);
      }
    );
    ask.disabled = finding;
    recentSlot.replaceChildren(
      el(
        "div",
        { class: "ask" },
        ask,
        recentMissing ? el("span", { class: "note" }, recentMissing) : null
      )
    );
  }
}

function showBanner(title: string | null, detail: string | null = null): void {
  banner.replaceChildren(title ? problem(title, detail) : "");
}

/** Shows a tool result: the request or email it holds, or what went wrong. */
function show(result: ToolResultParams): void {
  generation += 1;
  // A request picked from the strip and still loading is replaced by this one.
  if (recent) recent.loadingId = null;
  showBanner(null);
  if (result.isError) {
    view = null;
    main.replaceChildren(problem("The tool could not load this request.", errorText(result)));
    renderRecent();
    return;
  }
  const next = viewOf(resultData(result), result._meta);
  if (!next) {
    view = null;
    main.replaceChildren(problem("This result is not a captured request or email.", null));
    renderRecent();
    return;
  }
  present(next, null);
}

/**
 * Shows a request or email. Nothing here calls a tool on its own: the
 * whole email and the endpoint's recent requests cost tool calls (counted
 * against the account's limits on the hosted server), and hosts mount the
 * view again whenever a conversation is reopened. They load when asked,
 * and the strip is then kept up as the person clicks through.
 */
function present(next: View, slug: string | null): void {
  view = next;
  loadingFull = false;
  fullFailed = null;
  renderView();
  if (recent) void findRecent(next, slug);
  else renderRecent();
}

/**
 * get_request answers an email in its compact form, without codes and
 * links: get_email returns the whole email, when the person asks.
 */
async function loadFull(id: string): Promise<void> {
  if (loadingFull) return;
  // Kept to the email on show: once another is shown (present() resets the
  // state), the answer is dropped; a pick that failed leaves this one shown.
  const shown = view;
  loadingFull = true;
  fullFailed = null;
  renderView();
  try {
    const result = await callToolResult("get_email", { requestId: id });
    if (view !== shown) return;
    const full = viewOf(resultData(result), result._meta);
    if (full && full.kind === "email") view = full;
    else fullFailed = "The answer was not an email.";
  } catch (error) {
    if (view !== shown) return;
    fullFailed =
      `Could not load the whole email. ${error instanceof Error ? error.message : ""}`.trim();
  }
  loadingFull = false;
  renderView();
}

/**
 * The endpoint the request is at, then its recent requests: the slug the
 * caller already knows (a pick from the strip), else the one the tool was
 * called with, else the one the request names (a request read by id names
 * it; an email's capture address does too), else its endpoint id looked up
 * in list_endpoints, for a server too old to name it. An email's address
 * names the endpoint only at the capture domain; at a custom domain it is
 * the recipient's own.
 */
async function findRecent(current: View, known: string | null): Promise<void> {
  const token = ++findToken;
  finding = false;
  let slug = known;
  let missing = "Could not tell which endpoint this request is at.";
  if (!slug && typeof toolArgs.endpointSlug === "string" && toolArgs.endpointSlug)
    slug = toolArgs.endpointSlug;
  if (!slug) slug = current.slug;
  if (!slug && current.endpointId) {
    const endpointId = current.endpointId;
    if (!slugs.has(endpointId)) {
      if (!recent) {
        finding = true;
        renderRecent();
      }
      try {
        const found = slugForEndpoint(await callTool("list_endpoints", {}), endpointId);
        // A list cut to fit the output may have left the endpoint out: not
        // kept, so the next ask tries again.
        if (found.listed) slugs.set(endpointId, found.slug);
        else missing = "The endpoint was not among those listed.";
      } catch (error) {
        // Not kept: the next ask tries again.
        missing =
          `Could not look up the endpoint. ${error instanceof Error ? error.message : ""}`.trim();
      }
      if (token === findToken) finding = false;
    }
    slug = slugs.get(endpointId) ?? null;
  }
  // A newer ask, or another request shown meanwhile, decides the strip.
  if (token !== findToken) return;
  if (!view || view.id !== current.id) {
    renderRecent();
    return;
  }
  if (!slug) {
    recent = null;
    recentMissing = missing;
    renderRecent();
    return;
  }
  recentMissing = null;
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
  await loadRecent();
}

async function loadRecent(): Promise<void> {
  if (!recent) return;
  const state = recent;
  state.refreshing = true;
  renderRecent();
  try {
    state.items = recentOf(
      await callTool("list_requests", { endpointSlug: state.slug, limit: RECENT_LIMIT })
    );
    state.failed = null;
  } catch (error) {
    state.failed =
      `Could not load recent requests. ${error instanceof Error ? error.message : ""}`.trim();
  }
  state.refreshing = false;
  if (recent === state) renderRecent();
}

async function pick(item: RecentItem): Promise<void> {
  if (!recent || recent.loadingId) return;
  if (item.id === recent.currentId) return;
  const slug = recent.slug;
  recent.loadingId = item.id;
  renderRecent();
  const asked = ++generation;
  try {
    const result = await callToolResult(item.email ? "get_email" : "get_request", {
      requestId: item.id,
    });
    if (asked !== generation) return;
    const next = viewOf(resultData(result), result._meta);
    if (!next) throw new Error("The answer was not a request.");
    showBanner(null);
    present(next, slug);
  } catch (error) {
    if (asked !== generation) return;
    showBanner("Could not open that request.", error instanceof Error ? error.message : null);
    if (recent) recent.loadingId = null;
    renderRecent();
  }
}

/**
 * The size the host gives the frame follows the page, or it stays 0 high.
 * Reported only once the host knows the view is ready (after
 * ui/notifications/initialized); the first report comes at once.
 */
function startSizing(): void {
  let lastHeight = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    bridge.notify("ui/notifications/size-changed", { height });
  }).observe(root);
}

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
    serverTools = Boolean(init.hostCapabilities?.serverTools);
    bridge.notify("ui/notifications/initialized", {});
    startSizing();
    // Abilities can change what the first view shows.
    if (view) renderView();
    renderRecent();
  } catch {
    main.replaceChildren(problem("This client did not start the inspector.", null));
  }
}

void start();
