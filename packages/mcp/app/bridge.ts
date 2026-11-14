/**
 * The app's side of the MCP Apps protocol (io.modelcontextprotocol/ui,
 * 2026-01-26): JSON-RPC 2.0 over postMessage with the host, which is this
 * frame's parent. Only what the inspector uses: initialize, the host's
 * notifications, ping and teardown, and requests to the host (tools/call,
 * ui/open-link). Written by hand to keep the page small.
 */

export const PROTOCOL_VERSION = "2026-01-26";

type Params = Record<string, unknown>;

interface RpcError {
  code: number;
  message: string;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
}

/** A host's answer to ui/initialize, as far as the inspector reads it. */
export interface HostInit {
  hostCapabilities?: {
    openLinks?: object;
    serverTools?: object;
    sandbox?: { permissions?: { clipboardWrite?: object } };
  };
  hostContext?: HostContext;
}

export interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  locale?: string;
  timeZone?: string;
}

/** A tool result as the host relays it. */
export interface ToolResultParams {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** The host notifications the inspector handles (MCP Apps 2026-01-26). */
const HOST_NOTIFICATIONS = [
  "ui/notifications/tool-input",
  "ui/notifications/tool-result",
  "ui/notifications/tool-cancelled",
  "ui/notifications/host-context-changed",
  "ui/resource-teardown",
] as const;
type HostNotification = (typeof HOST_NOTIFICATIONS)[number];

export class HostBridge {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, (params: Params) => void>();

  constructor(private readonly host: Window) {
    window.addEventListener("message", (event) => this.receive(event));
  }

  /** Handles a notification from the host. Set handlers before initialize. */
  on(method: HostNotification, handler: (params: Params) => void): void {
    this.handlers.set(method, handler);
  }

  /** Sends a request to the host and waits for its answer. */
  request<T>(method: string, params: Params, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The client did not answer in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.post({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Params = {}): void {
    this.post({ jsonrpc: "2.0", method, params });
  }

  private post(message: object): void {
    // The host frame's origin is the client's own and not known here; the
    // messages carry nothing the host did not hand the page.
    this.host.postMessage(message, "*");
  }

  private receive(event: MessageEvent): void {
    if (event.source !== this.host) return;
    const message = event.data as {
      jsonrpc?: string;
      id?: number | string;
      method?: string;
      params?: Params;
      result?: unknown;
      error?: RpcError;
    };
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;

    if (message.method === undefined) {
      // An answer to one of our requests.
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "The request failed."));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined) {
      // A request from the host: ping and teardown are all it sends here.
      const known = message.method === "ping" || message.method === "ui/resource-teardown";
      this.post(
        known
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `${message.method} is not supported` },
            }
      );
      if (message.method === "ui/resource-teardown")
        this.handlers.get("ui/resource-teardown")?.({});
      return;
    }

    // Only the notifications the inspector listens for: a host's method name
    // never picks what runs beyond that list.
    const method = HOST_NOTIFICATIONS.find((name) => name === message.method);
    if (method) this.handlers.get(method)?.(message.params ?? {});
  }
}
