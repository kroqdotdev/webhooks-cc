/**
 * share(): shares a port on this computer at a public link by running the
 * webhooks.cc CLI (`whk share <port> --json --until-stdin-closes`) and
 * reading the events it prints, one JSON object a line. The tunnel is the
 * CLI's: this only starts it, listens and stops it. Node.js only.
 */
import type { ChildProcess } from "node:child_process";
import type { Interface } from "node:readline";
import { WebhooksCCError } from "./errors";

/** How to install the CLI on macOS and Linux (Homebrew: `brew install kroqdotdev/tap/whk`). */
export const WHK_INSTALL_COMMAND = "curl -fsSL https://webhooks.cc/install.sh | sh";

/** How to get the CLI on Windows, which has no install script: a release download. */
export const WHK_INSTALL_WINDOWS =
  "download whk for Windows from https://github.com/kroqdotdev/webhooks-cc/releases and put it on your PATH";

/** How to install the CLI on this platform (Node's `process.platform`). */
export function whkInstallHint(platform: string | undefined = nodeProcess()?.platform): string {
  return platform === "win32" ? WHK_INSTALL_WINDOWS : WHK_INSTALL_COMMAND;
}

/** How long share() waits for the link before giving up. */
const OPEN_TIMEOUT_MS = 60_000;
/**
 * How long stop() waits after closing the CLI's stdin before it sends a
 * signal, and then again before it kills it.
 */
const STOP_TIMEOUT_MS = 5_000;

/** One visitor request, as the CLI reports it once answered. */
export interface ShareRequestEvent {
  method: string;
  path: string;
  status: number;
  ms: number;
}

/** What `whk share --json` prints. */
export type ShareEvent =
  | {
      event: "live";
      url: string;
      name: string;
      expiresAt: string | null;
      notice: boolean;
      password: boolean;
    }
  | { event: "reconnected" }
  | ({ event: "request" } & ShareRequestEvent)
  | { event: "notice"; text: string }
  | { event: "retrying"; message: string; seconds: number }
  | { event: "stopped"; reason: string }
  | { event: "error"; message: string };

export interface ShareOptions {
  /** The local port to share, 1 to 65535. */
  port: number;
  /** A name you reserved (Pro and Business): `<name>.sharehooks.cc`. Free shares get a random name. */
  name?: string;
  /** What visitors must type to open it (Pro and Business), 8 to 200 characters. Sent through the environment, never the command line. */
  password?: string;
  /** The whk binary to run (default: `whk` on the PATH). */
  whkPath?: string;
  /**
   * The API key whk uses. Without it (and without `auth: "agent"`), whk
   * uses its own login or the shared agent credential file, as it does on
   * its own.
   */
  apiKey?: string;
  /**
   * `"agent"`: whk uses the agent credential file and never this machine's
   * own login, so the share belongs to the account an agent connection
   * names. `client.shares.start()` sets it for a client from
   * `WebhooksCC.connected()`.
   */
  auth?: "agent";
  /** The agent credential file whk reads with `auth: "agent"` (default: its own). */
  agentFile?: string;
  /** The API base URL whk talks to (default: whk's own, https://webhooks.cc). */
  baseUrl?: string;
  /** The tunnel to connect to (default: whk's own, wss://tunnel.webhooks.cc). */
  tunnelUrl?: string;
  /** Each visitor request, as it is answered. */
  onRequest?: (request: ShareRequestEvent) => void;
  /** Something the edge said about the share, such as a response it kept back. */
  onNotice?: (text: string) => void;
  /** Every event the CLI prints, reconnects included. */
  onEvent?: (event: ShareEvent) => void;
  /** How long to wait for the link, in milliseconds (default 60 s). */
  timeout?: number;
}

export interface LiveShare {
  /** The public link. */
  url: string;
  /** Its name: the reserved one, or a random one ending in `-free` on Free. */
  name: string;
  /** When the plan's session time runs out (ISO), or null without a limit. */
  expiresAt: string | null;
  /** Whether visitors see a short notice before the page (Free, and new paid accounts). */
  notice: boolean;
  /** Whether visitors need a password. */
  password: boolean;
  /** The port on this computer it forwards to. */
  port: number;
  /** Stops the share and waits for the CLI to exit. */
  stop(): Promise<void>;
  /** Settles when the share ends, however it ends, with why. */
  closed: Promise<{ reason: string }>;
}

interface NodeProcess {
  env: Record<string, string | undefined>;
  platform?: string;
  getBuiltinModule?: (id: string) => unknown;
  on(event: "exit", listener: () => void): unknown;
}

function nodeProcess(): NodeProcess | null {
  const candidate = (globalThis as { process?: NodeProcess }).process;
  return candidate && typeof candidate.getBuiltinModule === "function" ? candidate : null;
}

/**
 * Node's own modules, loaded when share() runs, so the SDK's main entry stays
 * usable in browsers and edge runtimes that have no child processes.
 */
function nodeModules(): {
  proc: NodeProcess;
  childProcess: typeof import("node:child_process");
  readline: typeof import("node:readline");
} {
  const proc = nodeProcess();
  const childProcess = proc?.getBuiltinModule?.("node:child_process") as
    typeof import("node:child_process") | undefined;
  const readline = proc?.getBuiltinModule?.("node:readline") as
    typeof import("node:readline") | undefined;
  if (!proc || !childProcess || !readline) {
    throw new WebhooksCCError(
      0,
      "share() runs the whk CLI, so it needs Node.js 20.16 or later (not a browser or an edge runtime)."
    );
  }
  return { proc, childProcess, readline };
}

/** CLIs still running, stopped if this process exits first. */
const running = new Set<ChildProcess>();
let exitHook = false;

function watch(proc: NodeProcess, child: ChildProcess): void {
  running.add(child);
  if (!exitHook) {
    exitHook = true;
    proc.on("exit", () => {
      for (const c of running) c.kill("SIGTERM");
    });
  }
}

/** The install instructions for the platform this runs on, as a clause. */
function installHint(proc: NodeProcess): string {
  const hint = whkInstallHint(proc.platform);
  return hint === WHK_INSTALL_COMMAND ? `run: ${hint}` : `${hint}.`;
}

/** The words for a CLI that is missing or too old to share. */
function cliProblem(bin: string, stderr: string, proc: NodeProcess): string | null {
  if (/unrecognized subcommand|unexpected argument/i.test(stderr)) {
    return `Sharing a port needs a newer whk than the one at ${bin}. Update it with \`whk update\`; to install it again, ${installHint(proc)}`;
  }
  return null;
}

/** Validates the options that never reach the CLI as they are. */
function checkOptions(options: ShareOptions): void {
  const { port, password } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WebhooksCCError(0, `${String(port)} is not a port (1 to 65535).`);
  }
  if (options.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.name)) {
    throw new WebhooksCCError(
      0,
      "A share name is lowercase letters, digits and dashes, starting with a letter or digit."
    );
  }
  if (password !== undefined && (password.length < 8 || password.length > 200)) {
    throw new WebhooksCCError(0, "A share password is 8 to 200 characters.");
  }
}

/**
 * Shares a local port at a public link (`whk share`), and resolves once the
 * link works. The share keeps running until `stop()`, the plan's session
 * limit, a stop from the dashboard, or the end of this process: the CLI
 * stops when its stdin closes, so no share outlives the program that
 * started it.
 *
 * @example
 * ```ts
 * import { share } from "@webhooks-cc/sdk";
 * const live = await share({ port: 3000 });
 * console.log(live.url); // https://sample-preview-1234-free.sharehooks.cc
 * await live.stop();
 * ```
 */
export async function share(options: ShareOptions): Promise<LiveShare> {
  checkOptions(options);
  const { proc, childProcess, readline } = nodeModules();
  const bin = options.whkPath ?? "whk";
  const port = options.port;

  const args = ["share", String(port), "--json", "--until-stdin-closes"];
  if (options.name) args.push("--name", options.name);
  const env: Record<string, string | undefined> = { ...proc.env };
  delete env.WHK_SHARE_PASSWORD;
  if (options.password !== undefined) {
    // Through the environment, never the arguments, which others can see.
    args.push("--password");
    env.WHK_SHARE_PASSWORD = options.password;
  }
  // Whose share it is: the key given, else the agent connection when asked,
  // never whatever this machine's environment happened to hold.
  delete env.WHK_API_KEY;
  delete env.WHK_AUTH;
  // whk reads WHK_API_KEY only with WHK_AUTH=key, so a key in someone's
  // shell never changes which account their own whk commands act as.
  if (options.apiKey) {
    env.WHK_API_KEY = options.apiKey;
    env.WHK_AUTH = "key";
  } else if (options.auth === "agent") {
    env.WHK_AUTH = "agent";
    if (options.agentFile) env.WHK_AGENT_FILE = options.agentFile;
  } else if (proc.env.WHK_API_KEY) {
    env.WHK_API_KEY = proc.env.WHK_API_KEY;
    env.WHK_AUTH = "key";
  }
  if (options.baseUrl) env.WHK_API_URL = options.baseUrl;
  if (options.tunnelUrl) env.WHK_TUNNEL_URL = options.tunnelUrl;

  const child = childProcess.spawn(bin, args, {
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  watch(proc, child);
  const timeoutMs = options.timeout ?? OPEN_TIMEOUT_MS;

  return new Promise<LiveShare>((resolve, reject) => {
    let live: LiveShare | undefined;
    let words: string | undefined;
    let lastRetry: string | undefined;
    let stopping = false;
    let stderr = "";
    let settled = false;
    let ended!: (value: { reason: string }) => void;
    const closed = new Promise<{ reason: string }>((r) => (ended = r));

    const fail = (error: WebhooksCCError): void => {
      if (live || settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new WebhooksCCError(
          0,
          `The share did not open within ${Math.round(timeoutMs / 1000)} seconds${lastRetry ? `: ${lastRetry}` : "."}`
        )
      );
      void stop();
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const lines: Interface = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let event: ShareEvent;
      try {
        event = JSON.parse(line) as ShareEvent;
      } catch {
        return;
      }
      if (typeof event?.event !== "string") return;
      try {
        options.onEvent?.(event);
      } catch {
        // A listener must not break the share.
      }
      switch (event.event) {
        case "live":
          if (live) {
            // A reconnect that came back at another address.
            live.url = event.url;
            live.name = event.name;
            break;
          }
          live = {
            url: event.url,
            name: event.name,
            expiresAt: event.expiresAt ?? null,
            notice: event.notice === true,
            password: event.password === true,
            port,
            stop,
            closed,
          };
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(live);
          }
          break;
        case "request":
          try {
            options.onRequest?.({
              method: event.method,
              path: event.path,
              status: event.status,
              ms: event.ms,
            });
          } catch {
            // A listener must not break the share.
          }
          break;
        case "notice":
          try {
            options.onNotice?.(event.text);
          } catch {
            // A listener must not break the share.
          }
          break;
        case "retrying":
          lastRetry = event.message;
          break;
        case "stopped":
          words = event.reason;
          break;
        case "error":
          words = event.message;
          break;
      }
    });

    let exitCode: number | null = null;
    const exited = new Promise<void>((r) =>
      child.on("exit", (code) => {
        exitCode = code;
        r();
      })
    );
    const read = new Promise<void>((r) => lines.on("close", () => r()));
    child.on("error", (err: NodeJS.ErrnoException) => {
      running.delete(child);
      clearTimeout(timer);
      const message =
        err.code === "ENOENT"
          ? bin === "whk"
            ? `Sharing a port needs the webhooks.cc CLI (whk), which is not installed. To install it, ${installHint(proc)}`
            : `Sharing a port needs the webhooks.cc CLI (whk), and there is none at ${bin}. To install it, ${installHint(proc)}`
          : `Could not run ${bin}: ${err.message}`;
      fail(new WebhooksCCError(0, message));
      ended({ reason: message });
    });
    void Promise.all([exited, read]).then(() => {
      running.delete(child);
      clearTimeout(timer);
      const said = words ?? cliProblem(bin, stderr, proc) ?? (stderr.trim() || undefined);
      fail(
        new WebhooksCCError(
          0,
          said ?? `whk share exited (code ${String(exitCode)}) before the link was ready.`
        )
      );
      ended({
        reason: stopping
          ? "you stopped it on this computer"
          : (said ?? `whk share exited with code ${String(exitCode)}`),
      });
    });

    /**
     * Closes the CLI's stdin, which ends it cleanly on every platform
     * (`--until-stdin-closes`); a signal follows only if it has not exited
     * in time, then a kill. Windows has no SIGINT for a child, so the stdin
     * path is the one that matters there.
     */
    async function stop(): Promise<void> {
      if (exitCode === null && child.exitCode === null) {
        stopping = true;
        child.stdin?.end();
        const signal = setTimeout(() => child.kill("SIGTERM"), STOP_TIMEOUT_MS);
        const force = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS * 2);
        await closed;
        clearTimeout(signal);
        clearTimeout(force);
      }
      await closed;
    }
  });
}
