/**
 * @fileoverview The agent credential file (conformance/agent-credentials.md):
 * where an agent keeps the identity assertions of its registrations, so a
 * connection a human approved once survives restarts. The MCP server, the
 * TypeScript, Python and Go SDKs and the whk CLI share one file.
 *
 * The rules are pure functions of their inputs (and the source of the
 * conformance vectors); `AgentCredentialStore` does the file I/O. It reaches
 * `node:fs` through `process.getBuiltinModule`, so this module stays safe to
 * bundle for browsers, where there is simply no file.
 */

export type CredentialSlotName = "claimed" | "sandbox";

/** One registration in the file. Keys are snake_case, as every port writes them. */
export interface CredentialSlot {
  registration_id: string;
  identity_assertion: string;
  /** RFC 3339. */
  assertion_expires: string;
  scope?: string;
  email?: string;
  client_name?: string;
  saved_at?: string;
  /** The last access token exchanged from the assertion, and when it expires. */
  access_token?: string;
  access_token_expires?: string;
}

/**
 * A change to one slot. With `ifRegistration`, it applies only while the
 * slot still holds that registration: a token refresh or a clean-up after a
 * refusal must never overwrite or remove a slot another process has since
 * replaced (or removed).
 */
export type CredentialWrite =
  | { set: CredentialSlotName; slot: CredentialSlot; ifRegistration?: string }
  | { remove: CredentialSlotName; ifRegistration?: string };

/** A slot or a cached token closer to expiry than this counts as gone. */
const LIVE_MARGIN_MS = 60_000;
const FORMAT_VERSION = 1;
const SLOT_NAMES: readonly CredentialSlotName[] = ["claimed", "sandbox"];
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const REQUIRED = ["registration_id", "identity_assertion", "assertion_expires"] as const;
const OPTIONAL = [
  "scope",
  "email",
  "client_name",
  "saved_at",
  "access_token",
  "access_token_expires",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Milliseconds since the epoch, or NaN for anything but an RFC 3339
 * timestamp with a real date and time (no February 30, no hour 24, no leap
 * second), as Go, Python and Rust parse it.
 */
export function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const match = RFC3339.exec(value);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return Number.NaN;
  if (hour > 23 || minute > 59 || second > 59) return Number.NaN;
  if (match[9] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) {
    return Number.NaN;
  }
  return Date.parse(value);
}

/**
 * The file's path for a platform (`process.platform` names), home directory
 * and environment; null when there is none. The same directory as the CLI's
 * token.json (Rust's `dirs::config_dir()`), unless WHK_AGENT_FILE names one.
 */
export function resolveCredentialsPath(
  platform: string,
  home: string | null,
  env: Record<string, string | undefined>
): string | null {
  const override = env.WHK_AGENT_FILE;
  if (override) return override;

  if (platform === "win32") {
    const base = env.APPDATA || (home ? joinPath(home, ["AppData", "Roaming"], "\\") : null);
    return base ? joinPath(base, ["whk", "agent.json"], "\\") : null;
  }
  let base: string | null;
  if (platform === "darwin") {
    base = home ? joinPath(home, ["Library", "Application Support"], "/") : null;
  } else {
    const xdg = env.XDG_CONFIG_HOME;
    base = xdg && xdg.startsWith("/") ? xdg : home ? joinPath(home, [".config"], "/") : null;
  }
  return base ? joinPath(base, ["whk", "agent.json"], "/") : null;
}

function joinPath(base: string, parts: string[], separator: string): string {
  let end = base.length;
  while (end > 1 && (base[end - 1] === "/" || base[end - 1] === "\\")) end--;
  return [base.slice(0, end), ...parts].join(separator);
}

/**
 * The key of an app's entry: trailing slashes removed, scheme and host
 * lowercased (the path, if any, keeps its case).
 */
export function normalizeIssuer(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") end--;
  const url = baseUrl.slice(0, end);
  const scheme = url.indexOf("://");
  if (scheme < 0) return url;
  const pathStart = url.indexOf("/", scheme + 3);
  return pathStart < 0
    ? url.toLowerCase()
    : url.slice(0, pathStart).toLowerCase() + url.slice(pathStart);
}

/** The slot when it is well formed, else null. Says nothing about expiry. */
function parseSlot(value: unknown): CredentialSlot | null {
  if (!isObject(value)) return null;
  for (const key of REQUIRED) {
    if (typeof value[key] !== "string" || value[key] === "") return null;
  }
  if (Number.isNaN(parseTimestamp(value.assertion_expires))) return null;
  const slot: Record<string, string> = {};
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    if (typeof value[key] === "string") slot[key] = value[key] as string;
  }
  return slot as unknown as CredentialSlot;
}

/** True when the slot's assertion has more than a minute left. */
export function isSlotLive(slot: CredentialSlot, now: number): boolean {
  return parseTimestamp(slot.assertion_expires) - now > LIVE_MARGIN_MS;
}

/** The slot's cached access token, when it has more than a minute left. */
export function usableToken(slot: CredentialSlot, now: number): string | null {
  const token = slot.access_token;
  if (!token || !token.startsWith("whcc_")) return null;
  return parseTimestamp(slot.access_token_expires) - now > LIVE_MARGIN_MS ? token : null;
}

export interface CredentialSlots {
  claimed: CredentialSlot | null;
  sandbox: CredentialSlot | null;
}

/** The live slots for an issuer in a parsed file (null when there is no file). */
export function readSlots(file: unknown, issuer: string, now: number): CredentialSlots {
  const none: CredentialSlots = { claimed: null, sandbox: null };
  if (!isObject(file) || file.version !== FORMAT_VERSION || !isObject(file.issuers)) return none;
  const entry = file.issuers[normalizeIssuer(issuer)];
  if (!isObject(entry)) return none;
  const live = (value: unknown) => {
    const slot = parseSlot(value);
    return slot && isSlotLive(slot, now) ? slot : null;
  };
  return { claimed: live(entry.claimed), sandbox: live(entry.sandbox) };
}

/**
 * The file after a write: the new JSON value, null when the file should be
 * deleted, or "unchanged" when nothing may be written (a newer format owns
 * the file, or the slot no longer holds `ifRegistration`).
 * `before` is the parsed file (null when missing; anything unparseable reads
 * as missing).
 */
export function applyWrite(
  before: unknown,
  issuer: string,
  write: CredentialWrite,
  now: number
): Record<string, unknown> | null | "unchanged" {
  if (isObject(before) && "version" in before && before.version !== FORMAT_VERSION) {
    return "unchanged";
  }
  const root: Record<string, unknown> =
    isObject(before) && before.version === FORMAT_VERSION
      ? structuredClone(before)
      : { version: FORMAT_VERSION };
  const issuers: Record<string, unknown> = isObject(root.issuers) ? root.issuers : {};
  const key = normalizeIssuer(issuer);
  const entry: Record<string, unknown> = isObject(issuers[key]) ? issuers[key] : {};
  if (write.ifRegistration !== undefined) {
    const current = parseSlot(entry["set" in write ? write.set : write.remove]);
    if (current?.registration_id !== write.ifRegistration) return "unchanged";
  }
  if ("set" in write) {
    entry[write.set] = write.slot;
  } else {
    delete entry[write.remove];
  }
  issuers[key] = entry;

  for (const [name, value] of Object.entries(issuers)) {
    if (!isObject(value)) {
      delete issuers[name];
      continue;
    }
    for (const slotName of SLOT_NAMES) {
      if (!(slotName in value)) continue;
      const slot = parseSlot(value[slotName]);
      if (!slot || !isSlotLive(slot, now)) delete value[slotName];
    }
    if (Object.keys(value).length === 0) delete issuers[name];
  }
  if (Object.keys(issuers).length === 0) return null;
  root.issuers = issuers;
  return root;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

type NodeFs = typeof import("node:fs");
type NodeOs = typeof import("node:os");

interface NodeProcess {
  platform: string;
  env: Record<string, string | undefined>;
  pid: number;
  getBuiltinModule?: (id: string) => unknown;
}

function nodeProcess(): NodeProcess | null {
  const candidate = (globalThis as { process?: NodeProcess }).process;
  return candidate && typeof candidate.getBuiltinModule === "function" ? candidate : null;
}

function builtin<T>(id: string): T | null {
  try {
    return (nodeProcess()?.getBuiltinModule?.(id) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The file's path in this process, or null where there is no file system. */
export function agentCredentialsPath(): string | null {
  const proc = nodeProcess();
  const os = builtin<NodeOs>("node:os");
  if (!proc || !os) return null;
  let home: string | null = null;
  try {
    home = os.homedir() || null;
  } catch {
    home = null;
  }
  return resolveCredentialsPath(proc.platform, home, proc.env);
}

let warned = false;
const UNREADABLE = Symbol("unreadable");

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`webhooks.cc: ${message}`);
}

/**
 * Reads and writes the credential file. Every method is best effort and
 * synchronous (the file is tiny): a broken file reads as empty, and a write
 * that fails is reported once, without contents, while the caller carries on
 * with what it holds in memory.
 */
export class AgentCredentialStore {
  constructor(readonly path: string | null) {}

  /** The store for WHK_AGENT_FILE or the default path, a given path, or none. */
  static resolve(file?: string | false): AgentCredentialStore | null {
    if (file === false) return null;
    const path = file ?? agentCredentialsPath();
    return path ? new AgentCredentialStore(path) : null;
  }

  /**
   * The parsed file: null when it does not exist or is not JSON, UNREADABLE
   * when it exists but cannot be read now (permissions, a Windows sharing
   * violation mid-rename), which must never be written over.
   */
  private readRaw(fs: NodeFs): unknown {
    if (!this.path) return null;
    let text: string;
    try {
      text = fs.readFileSync(this.path, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === "ENOENT" || code === "ENOTDIR" ? null : UNREADABLE;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /** The live slots for an issuer. */
  load(issuer: string): CredentialSlots {
    const fs = builtin<NodeFs>("node:fs");
    if (!fs) return { claimed: null, sandbox: null };
    const raw = this.readRaw(fs);
    return readSlots(raw === UNREADABLE ? null : raw, issuer, Date.now());
  }

  /** Sets a slot; with `ifRegistration`, only while the slot still holds it. */
  save(
    issuer: string,
    name: CredentialSlotName,
    slot: CredentialSlot,
    options: { ifRegistration?: string } = {}
  ): void {
    this.write(issuer, { set: name, slot, ifRegistration: options.ifRegistration });
  }

  /** Removes a slot; with `ifRegistration`, only while the slot still holds it. */
  remove(
    issuer: string,
    name: CredentialSlotName,
    options: { ifRegistration?: string } = {}
  ): void {
    this.write(issuer, { remove: name, ifRegistration: options.ifRegistration });
  }

  private write(issuer: string, write: CredentialWrite): void {
    const fs = builtin<NodeFs>("node:fs");
    const path = builtin<typeof import("node:path")>("node:path");
    const crypto = builtin<typeof import("node:crypto")>("node:crypto");
    if (!fs || !path || !crypto || !this.path) return;

    const before = this.readRaw(fs);
    if (before === UNREADABLE) {
      warnOnce(`could not read the agent credential file at ${this.path}; left it as it is`);
      return;
    }
    const next = applyWrite(before, issuer, write, Date.now());
    if (next === "unchanged") return;
    if (next === null) {
      try {
        fs.rmSync(this.path, { force: true });
      } catch {
        warnOnce(`could not remove the agent credential file at ${this.path}`);
      }
      return;
    }

    const dir = path.dirname(this.path);
    const temp = path.join(
      dir,
      `${path.basename(this.path)}.${crypto.randomBytes(6).toString("hex")}.tmp`
    );
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.path);
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing more to do; the warning below covers it.
      }
      warnOnce(`could not write the agent credential file at ${this.path}`);
    }
  }
}
