import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AgentAuthError,
  AgentCredentialStore,
  SandboxClient,
  WebhooksCC,
  type PendingConnection,
  type Request,
  type SandboxClaimAttempt,
} from "@webhooks-cc/sdk";
import { compactRequest } from "./compact";
import {
  createEndpointShape,
  deleteEndpointShape,
  getEndpointShape,
  getRequestShape,
  jsonContent,
  listEndpointsShape,
  listRequestsShape,
  payloadSchemaResult,
  payloadSchemaShape,
  registerTools,
  waitForRequestShape,
  withErrorHandling,
  type RegisteredToolHandle,
  type ToolServer,
} from "./tools";

/**
 * The tools of a server started without an API key (auth.md v0.6).
 *
 * When the agent credential file (~/.config/whk/agent.json, shared with the
 * CLI and the SDKs) holds a live connection to a human's account, the server
 * starts with the full tools for that account. Otherwise the endpoint and
 * request tools keep the names and arguments of the full tools but run in
 * the agent sandbox, which the first create_endpoint registers (a few
 * seconds of proof of work) and the file keeps for later sessions.
 * connect_account and wait_for_connection connect the agent to a human's
 * account; once the human enters the code, these tools are replaced by the
 * full set (notifications/tools/list_changed) and the connection is saved.
 * If the human later disconnects the agent, the sandbox tools come back.
 */

/** The sandbox limits webhooks.cc enforces (lib/agent/constants.ts on the server). */
const SANDBOX = {
  maxEndpoints: 3,
  requestsPerEndpoint: 25,
  requests: 100,
  lifetimeHours: 24,
};
/** MCP clients often give up on a tool call after 60 seconds. */
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 600;
const DOCS_URL = "https://webhooks.cc/docs/agents";

/** create_endpoint options the sandbox does not have. */
const ACCOUNT_ONLY_OPTIONS = [
  "mockResponse",
  "responseRules",
  "notificationUrl",
  "signingProvider",
  "signingSecret",
  "signingHeader",
] as const;

export interface SandboxToolOptions {
  /** API base URL (default: WHK_BASE_URL or https://webhooks.cc). */
  baseUrl?: string;
  /** Webhook receiver URL (default: WHK_WEBHOOK_URL or https://go.webhooks.cc). */
  webhookUrl?: string;
  /** The agent's name, shown to the human as self-reported. */
  clientName?: string;
  /**
   * The agent credential file (default: WHK_AGENT_FILE, else
   * ~/.config/whk/agent.json or the platform's equivalent); false keeps the
   * sandbox and the connection in memory, for this process only.
   */
  credentialsFile?: string | false;
  /** Called whenever the tools switch to a human's account, with a client for it. */
  onConnected?: (client: WebhooksCC) => void;
}

type PendingConnect =
  | { via: "sandbox"; sandbox: SandboxClient; email: string; attempt: SandboxClaimAttempt }
  | { via: "connect"; pending: PendingConnection; email: string };

class AgentSession {
  private sandbox: Promise<SandboxClient> | null = null;
  connect: PendingConnect | null = null;

  constructor(
    readonly baseUrl: string,
    readonly webhookUrl: string | undefined,
    readonly clientName: string,
    readonly credentialsFile: string | false | undefined
  ) {}

  private sandboxOptions() {
    return {
      baseUrl: this.baseUrl,
      webhookUrl: this.webhookUrl,
      clientName: this.clientName,
      credentialsFile: this.credentialsFile,
    };
  }

  /**
   * The sandbox: the one saved by an earlier session when it is still live,
   * else a new registration (and again after it expired). Tool calls can run
   * in parallel: this.sandbox is read again after every await, and a new
   * sandbox is assigned with no await in between, so parallel calls share
   * one registration. Calls waiting on a registration that fails get its
   * error (a 429 asks them to wait); the next call starts again.
   */
  async sandboxClient(): Promise<SandboxClient> {
    while (this.sandbox) {
      const pending = this.sandbox;
      const sandbox = await pending;
      if (!this.expired(pending, sandbox)) return sandbox;
      // Another call may have started the next one meanwhile; the loop then
      // waits for it.
    }
    const created = WebhooksCC.sandbox(this.sandboxOptions());
    this.sandbox = created;
    created.catch(() => {
      if (this.sandbox === created) this.sandbox = null;
    });
    return created;
  }

  /** The live sandbox, from this session or the credential file; never registers one. */
  async existingSandbox(): Promise<SandboxClient | null> {
    const pending = this.sandbox;
    if (pending) {
      let sandbox: SandboxClient;
      try {
        sandbox = await pending;
      } catch {
        return null;
      }
      return this.expired(pending, sandbox) ? null : sandbox;
    }
    const resumed = await SandboxClient.resume(this.sandboxOptions()).catch(() => null);
    if (!resumed) return null;
    // A parallel call may have registered meanwhile; keep the first.
    if (!this.sandbox) this.sandbox = Promise.resolve(resumed);
    return this.sandbox;
  }

  /** True when the sandbox is past its 24 hours; then it is dropped. */
  private expired(pending: Promise<SandboxClient>, sandbox: SandboxClient): boolean {
    if (sandbox.expiresAt.getTime() > Date.now()) return false;
    if (this.sandbox === pending) this.sandbox = null;
    if (this.connect?.via === "sandbox" && this.connect.sandbox === sandbox) {
      this.connect = null;
    }
    return true;
  }

  async requireSandbox(): Promise<SandboxClient> {
    const sandbox = await this.existingSandbox();
    if (!sandbox) {
      throw new Error("No sandbox yet: create_endpoint starts one.");
    }
    return sandbox;
  }

  reset(): void {
    this.sandbox = null;
    this.connect = null;
  }
}

function minutesLeft(until: Date): number {
  return Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
}

function onlyKind(requests: Request[], kind: "http" | "email" | undefined): Request[] {
  if (!kind) return requests;
  return requests.filter((request) => (request.kind ?? "http") === kind);
}

/** Where the connection is saved, for the messages; null when nothing is saved. */
function savedTo(credentialsFile: string | false | undefined): string | null {
  return AgentCredentialStore.resolve(credentialsFile)?.path ?? null;
}

/**
 * Registers the agent tools: the full tools when the credential file holds a
 * live connection to a human's account, else the sandbox tools
 * (create_endpoint, list_endpoints, get_endpoint, delete_endpoint,
 * list_requests, get_request, wait_for_request, generate_payload_schema) with
 * connect_account, wait_for_connection and about_sandbox.
 */
export function registerSandboxTools(server: McpServer, options: SandboxToolOptions = {}): void {
  const baseUrl = options.baseUrl ?? process.env.WHK_BASE_URL ?? "https://webhooks.cc";
  const webhookUrl = options.webhookUrl ?? process.env.WHK_WEBHOOK_URL;
  const session = new AgentSession(
    baseUrl,
    webhookUrl,
    options.clientName ?? "webhooks-cc-mcp",
    options.credentialsFile
  );
  let handles: RegisteredToolHandle[] = [];
  // Which tool set is on display; a revocation only counts for its own.
  let shown = 0;
  const swap = (register: (id: number) => RegisteredToolHandle[]) => {
    const id = ++shown;
    // Removing and adding tools sends notifications/tools/list_changed.
    for (const handle of handles) handle.remove();
    handles = register(id);
  };
  const showSandbox = () => swap(() => sandboxToolSet(server, session, showAccount));
  const savedAccount = (id: number) =>
    options.credentialsFile === false
      ? null
      : WebhooksCC.fromSavedConnection({
          baseUrl,
          webhookUrl,
          credentialsFile: options.credentialsFile,
          // The human disconnected the agent: back to the sandbox, unless a
          // newer connection is already on display.
          onRevoked: () =>
            queueMicrotask(() => {
              if (shown === id) showSandbox();
            }),
        });
  function showAccount(client: WebhooksCC): void {
    swap((id) => registerTools(server, savedAccount(id) ?? client));
    options.onConnected?.(client);
  }

  const saved = savedAccount(1);
  if (saved) {
    swap(() => registerTools(server, saved));
    options.onConnected?.(saved);
  } else {
    showSandbox();
  }
}

function sandboxToolSet(
  server: ToolServer,
  session: AgentSession,
  showAccount: (client: WebhooksCC) => void
): RegisteredToolHandle[] {
  const tools: RegisteredToolHandle[] = [];
  const limits = `up to ${SANDBOX.maxEndpoints} endpoints at a time, ${SANDBOX.requestsPerEndpoint} captured requests each and ${SANDBOX.requests} in all, deleted ${SANDBOX.lifetimeHours} hours after the sandbox was created`;
  const file = savedTo(session.credentialsFile);

  tools.push(
    server.tool(
      "create_endpoint",
      `Create a temporary webhook capture endpoint in the agent sandbox (no account needed): ${limits}. The first call registers the sandbox, which takes a few seconds of proof of work. Mock responses, notifications and signature verification need an account: see connect_account.`,
      createEndpointShape,
      withErrorHandling(async (args) => {
        const accountOnly = ACCOUNT_ONLY_OPTIONS.filter((key) => args[key] !== undefined);
        if (accountOnly.length > 0) {
          throw new Error(
            `${accountOnly.join(", ")} need an account; sandbox endpoints only capture and answer 200. Call connect_account to connect one.`
          );
        }
        const sandbox = await session.sandboxClient();
        const endpoint = await sandbox.endpoints.create();
        const ignored = args.name !== undefined || args.expiresIn !== undefined;
        return jsonContent(
          ignored
            ? {
                ...endpoint,
                note: "Sandbox endpoints have no name and expire with the sandbox.",
              }
            : endpoint
        );
      })
    )
  );

  tools.push(
    server.tool(
      "list_endpoints",
      "List this agent's sandbox endpoints. Empty until create_endpoint starts the sandbox.",
      listEndpointsShape,
      withErrorHandling(async ({ team }) => {
        if (team !== undefined) {
          throw new Error("Teams need an account. Call connect_account to connect one.");
        }
        const sandbox = await session.existingSandbox();
        return jsonContent(sandbox ? await sandbox.endpoints.list() : []);
      })
    )
  );

  tools.push(
    server.tool(
      "get_endpoint",
      "Get one of this agent's sandbox endpoints by slug, with its sandbox limits and usage.",
      getEndpointShape,
      withErrorHandling(async ({ slug }) => {
        return jsonContent(await (await session.requireSandbox()).endpoints.get(slug));
      })
    )
  );

  tools.push(
    server.tool(
      "delete_endpoint",
      "Delete one of this agent's sandbox endpoints and its captured requests. Frees a slot; the sandbox's request budget is not refunded.",
      deleteEndpointShape,
      withErrorHandling(async ({ slug }) => {
        await (await session.requireSandbox()).endpoints.delete(slug);
        return jsonContent({ deleted: slug });
      })
    )
  );

  tools.push(
    server.tool(
      "list_requests",
      "List recent requests captured by a sandbox endpoint, newest first.",
      listRequestsShape,
      withErrorHandling(async ({ endpointSlug, limit, since, kind }) => {
        const sandbox = await session.requireSandbox();
        const requests = await sandbox.requests.list(endpointSlug, { limit, since });
        return jsonContent(onlyKind(requests, kind).map(compactRequest));
      })
    )
  );

  tools.push(
    server.tool(
      "get_request",
      "Get full details for a request captured by a sandbox endpoint.",
      getRequestShape,
      withErrorHandling(async ({ requestId }) => {
        const sandbox = await session.requireSandbox();
        return jsonContent(compactRequest(await sandbox.requests.get(requestId)));
      })
    )
  );

  tools.push(
    server.tool(
      "wait_for_request",
      "Wait for a request to arrive at a sandbox endpoint.",
      waitForRequestShape,
      withErrorHandling(async ({ endpointSlug, timeout, pollInterval }) => {
        const sandbox = await session.requireSandbox();
        const request = await sandbox.requests.waitFor(endpointSlug, { timeout, pollInterval });
        return jsonContent(compactRequest(request));
      })
    )
  );

  tools.push(
    server.tool(
      "generate_payload_schema",
      "Generate TypeScript interfaces, Zod schemas, Pydantic models, or JSON Schema from the bodies of requests captured by a sandbox endpoint. Several requests of one event teach which fields are optional or nullable.",
      payloadSchemaShape,
      withErrorHandling(async ({ endpointSlug, requestIds, limit, ...args }) => {
        const sandbox = await session.requireSandbox();
        const requests = requestIds
          ? await Promise.all(requestIds.map((id) => sandbox.requests.get(id)))
          : await sandbox.requests.list(endpointSlug, { limit });
        return payloadSchemaResult(requests, args);
      })
    )
  );

  tools.push(
    server.tool(
      "connect_account",
      "Connect this agent to a human's webhooks.cc account, for the full tool set (mock responses, signatures, email, teams) and to keep the sandbox endpoints. Returns a link and a 6-digit code: show both to the human, who signs in or signs up with that email and enters the code. Then call wait_for_connection. Calling again gives a new code.",
      {
        email: z
          .string()
          .email({ message: "Invalid email address" })
          .describe(
            "The email the human signs in to webhooks.cc with (their GitHub or Google primary email if they sign in that way); only someone signed in as it can connect"
          ),
      },
      withErrorHandling(async ({ email }) => {
        const normalized = email.trim().toLowerCase();
        const previous = session.connect;
        const sandbox = await session.existingSandbox();
        let attempt: { verificationUri: string; userCode: string; expiresAt: Date };
        let movesEndpoints = false;
        if (sandbox) {
          const claim = await sandbox.claim({ email: normalized });
          session.connect = { via: "sandbox", sandbox, email: normalized, attempt: claim };
          attempt = claim;
          movesEndpoints = claim.movesEndpoints;
        } else {
          let pending: PendingConnection | null = null;
          if (previous?.via === "connect" && previous.email === normalized) {
            // The same human again: a new code for the same registration.
            pending = await previous.pending.restart().catch((error: unknown) => {
              if (error instanceof AgentAuthError) return null;
              throw error;
            });
          }
          pending ??= await WebhooksCC.connect({
            baseUrl: session.baseUrl,
            webhookUrl: session.webhookUrl,
            email: normalized,
            clientName: session.clientName,
            credentialsFile: session.credentialsFile,
          });
          session.connect = { via: "connect", pending, email: normalized };
          attempt = pending;
        }

        const { verificationUri, userCode, expiresAt } = attempt;
        return jsonContent({
          verificationUri,
          userCode,
          expiresAt: expiresAt.toISOString(),
          tellTheHuman: `Open ${verificationUri}, sign in or sign up as ${normalized}, and enter the code ${userCode}.`,
          next: `Show the human that line, then call wait_for_connection. The code works for about ${minutesLeft(expiresAt)} minutes; connect_account gives a new one.`,
          ...(sandbox
            ? {
                endpoints: movesEndpoints
                  ? "The sandbox endpoints move into that account with what they captured."
                  : "The sandbox endpoints were made in an earlier session, so they stay in the sandbox until it expires; the account starts without them.",
              }
            : {}),
        });
      })
    )
  );

  tools.push(
    server.tool(
      "wait_for_connection",
      `Wait for the human to enter the code from connect_account. On success the full webhooks.cc tools for their account replace these sandbox tools. Returns after timeoutSeconds (default ${DEFAULT_WAIT_SECONDS}) if they have not finished yet; call it again to keep waiting.`,
      {
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`How long to wait, in seconds (default ${DEFAULT_WAIT_SECONDS})`),
      },
      withErrorHandling(async ({ timeoutSeconds }) => {
        const pending = session.connect;
        if (!pending) {
          throw new Error("Nothing to wait for: call connect_account first.");
        }

        const timeout = (timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
        const expiresAt =
          pending.via === "sandbox" ? pending.attempt.expiresAt : pending.pending.expiresAt;
        let client: WebhooksCC;
        try {
          client =
            pending.via === "sandbox"
              ? await pending.sandbox.waitForClaim({ timeout })
              : await pending.pending.wait({ timeout });
        } catch (error) {
          if (!(error instanceof AgentAuthError)) throw error;
          if (error.code === "timeout") {
            return jsonContent({
              connected: false,
              status: "waiting",
              message: `Not connected yet. The code works until ${expiresAt.toISOString()}; call wait_for_connection again.`,
            });
          }
          if (error.code === "expired_token") {
            return jsonContent({
              connected: false,
              status: "expired",
              message: "The code expired. Call connect_account for a new one.",
            });
          }
          if (error.code === "access_denied") {
            return jsonContent({
              connected: false,
              status: "declined",
              message: "The human declined. Call connect_account again only if they ask you to.",
            });
          }
          throw error;
        }

        const movedEndpoints = pending.via === "sandbox" && pending.attempt.movesEndpoints;
        session.reset();
        showAccount(client);

        return jsonContent({
          connected: true,
          email: pending.email,
          message: `Connected to the webhooks.cc account of ${pending.email}. The full tool set has replaced the sandbox tools (the tool list changed; if your client does not pick that up, ask the user to restart it).${movedEndpoints ? " The sandbox endpoints are now that account's endpoints, with what they captured." : ""} ${
            file
              ? `The connection is saved in ${file}, so later sessions, the whk CLI and the SDKs start connected; it lasts 90 days, and the human can remove it under Account, Connected agents.`
              : "This connection lasts while this MCP server runs; for a lasting setup, the human can create an API key under Account and set WHK_API_KEY."
          }`,
        });
      })
    )
  );

  tools.push(
    server.tool(
      "about_sandbox",
      "Explain what this agent can do without a webhooks.cc account, the sandbox limits, and how to connect an account. No network call.",
      {},
      withErrorHandling(async () => {
        return jsonContent({
          mode: "sandbox (no WHK_API_KEY, no saved connection)",
          sandbox: {
            maxEndpoints: SANDBOX.maxEndpoints,
            requestsPerEndpoint: SANDBOX.requestsPerEndpoint,
            requestsInAll: SANDBOX.requests,
            lifetimeHours: SANDBOX.lifetimeHours,
            startsWith: "create_endpoint (registers the sandbox; a few seconds of proof of work)",
            captures:
              "Endpoints answer every request with 200; only this agent can read what they capture.",
            notAvailable:
              "Mock responses, response rules, notifications, signature verification, email capture, forwarding, teams and sending webhooks.",
          },
          connectAnAccount: [
            "Call connect_account with the email the human signs in to webhooks.cc with, and show them the link and code it returns.",
            "Call wait_for_connection until it reports connected; the full tools for their account then replace the sandbox tools.",
            "Sandbox endpoints registered by this server process move into the account with their captured requests; a sandbox resumed from an earlier session stays in the sandbox (connect_account says which).",
          ],
          savedIn: file
            ? `${file} (shared with the whk CLI and the SDKs): the sandbox and the connection survive restarts.`
            : "nowhere: this session only.",
          withAnApiKey:
            "Set WHK_API_KEY to a whcc_ key from the dashboard and restart for the full tools from the start.",
          docs: DOCS_URL,
          protocol: `${session.baseUrl}/auth.md`,
        });
      })
    )
  );

  return tools;
}

/**
 * @deprecated The auth.md v0.1 registration tools are gone; this registers
 * the sandbox tools that replaced them. Use registerSandboxTools.
 */
export function registerAgentRegistrationTools(server: McpServer): void {
  registerSandboxTools(server);
}
