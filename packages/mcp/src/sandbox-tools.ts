import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AgentAuthError,
  WebhooksCC,
  type AgentAccessToken,
  type AgentClaimAttempt,
  type Request,
  type SandboxClient,
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
  registerTools,
  waitForRequestShape,
  withErrorHandling,
} from "./tools";

/**
 * The tools of a server started without an API key (auth.md v0.6). The
 * endpoint and request tools keep the names and arguments of the full tools
 * but run in the agent sandbox, which the first create_endpoint registers
 * (a few seconds of proof of work). connect_account and
 * wait_for_connection connect the agent to a human's account; once the human
 * enters the code, these tools are replaced by the full set for that account
 * (notifications/tools/list_changed).
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
/** Exchange the claimed assertion again this long before the token expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
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
  /** Called once a human has connected the agent, with a client for their account. */
  onConnected?: (client: WebhooksCC) => void;
}

interface PendingClaim {
  kind: "sandbox" | "service_auth";
  claimToken: string;
  email: string;
  attempt: AgentClaimAttempt;
  /** When the registration, and so the claim token, expires. */
  claimExpires: Date;
}

class AgentSession {
  private sandbox: Promise<SandboxClient> | null = null;
  claim: PendingClaim | null = null;
  connected = false;

  constructor(
    readonly baseUrl: string,
    readonly webhookUrl: string | undefined,
    readonly clientName: string
  ) {}

  /**
   * The sandbox, registered on first use and again after it expired. Tool
   * calls can run in parallel: this.sandbox is read again after every await,
   * and a new sandbox is assigned with no await in between, so parallel
   * calls share one registration. Calls waiting on a registration that fails
   * get its error (a 429 asks them to wait); the next call starts again.
   */
  async sandboxClient(): Promise<SandboxClient> {
    while (this.sandbox) {
      const pending = this.sandbox;
      const sandbox = await pending;
      if (!this.expired(pending, sandbox)) return sandbox;
      // Another call may have started the next one meanwhile; the loop then
      // waits for it.
    }
    const created = WebhooksCC.sandbox({
      baseUrl: this.baseUrl,
      webhookUrl: this.webhookUrl,
      clientName: this.clientName,
    });
    this.sandbox = created;
    created.catch(() => {
      if (this.sandbox === created) this.sandbox = null;
    });
    return created;
  }

  /** The live sandbox, if one was registered; never registers one. */
  async existingSandbox(): Promise<SandboxClient | null> {
    const pending = this.sandbox;
    if (!pending) return null;
    let sandbox: SandboxClient;
    try {
      sandbox = await pending;
    } catch {
      return null;
    }
    return this.expired(pending, sandbox) ? null : sandbox;
  }

  /** True when the sandbox is past its 24 hours; then it is dropped. */
  private expired(pending: Promise<SandboxClient>, sandbox: SandboxClient): boolean {
    if (sandbox.expiresAt.getTime() > Date.now()) return false;
    if (this.sandbox === pending) this.sandbox = null;
    if (
      this.claim?.kind === "sandbox" &&
      this.claim.claimToken === sandbox.registration.claimToken
    ) {
      this.claim = null;
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

  forgetSandbox(): void {
    this.sandbox = null;
  }
}

/**
 * A token getter for the account client: the access token from the claim
 * first, then fresh ones exchanged from the claimed assertion.
 */
function claimedTokens(
  baseUrl: string,
  assertion: string,
  first: AgentAccessToken
): (options?: { forceRefresh?: boolean }) => Promise<string> {
  let current = first;
  let pending: Promise<AgentAccessToken> | null = null;
  return async (options) => {
    if (
      !options?.forceRefresh &&
      current.expiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS
    ) {
      return current.accessToken;
    }
    if (!pending) {
      pending = WebhooksCC.agent.exchange({ baseUrl, assertion }).finally(() => {
        pending = null;
      });
    }
    current = await pending;
    return current.accessToken;
  };
}

function minutesLeft(until: Date): number {
  return Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
}

function onlyKind(requests: Request[], kind: "http" | "email" | undefined): Request[] {
  if (!kind) return requests;
  return requests.filter((request) => (request.kind ?? "http") === kind);
}

/**
 * Registers the sandbox tools (create_endpoint, list_endpoints,
 * get_endpoint, delete_endpoint, list_requests, get_request,
 * wait_for_request) and connect_account, wait_for_connection and
 * about_sandbox.
 */
export function registerSandboxTools(server: McpServer, options: SandboxToolOptions = {}): void {
  const baseUrl = options.baseUrl ?? process.env.WHK_BASE_URL ?? "https://webhooks.cc";
  const session = new AgentSession(
    baseUrl,
    options.webhookUrl ?? process.env.WHK_WEBHOOK_URL,
    options.clientName ?? "webhooks-cc-mcp"
  );
  const registered: RegisteredTool[] = [];
  const limits = `up to ${SANDBOX.maxEndpoints} endpoints at a time, ${SANDBOX.requestsPerEndpoint} captured requests each and ${SANDBOX.requests} in all, deleted ${SANDBOX.lifetimeHours} hours after the sandbox was created`;

  registered.push(
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

  registered.push(
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

  registered.push(
    server.tool(
      "get_endpoint",
      "Get one of this agent's sandbox endpoints by slug, with its sandbox limits and usage.",
      getEndpointShape,
      withErrorHandling(async ({ slug }) => {
        return jsonContent(await (await session.requireSandbox()).endpoints.get(slug));
      })
    )
  );

  registered.push(
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

  registered.push(
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

  registered.push(
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

  registered.push(
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

  registered.push(
    server.tool(
      "connect_account",
      "Connect this agent to a human's webhooks.cc account, for the full tool set (mock responses, signatures, email, teams) and to keep the sandbox endpoints. Returns a link and a 6-digit code: show both to the human, who signs in or signs up with that email and enters the code. Then call wait_for_connection. Calling again gives a new code.",
      {
        email: z
          .string()
          .email({ message: "Invalid email address" })
          .describe("The human's email address; only someone signed in as it can connect"),
      },
      withErrorHandling(async ({ email }) => {
        if (session.connected) {
          return jsonContent({ connected: true, message: "Already connected to an account." });
        }
        const normalized = email.trim().toLowerCase();
        const sandbox = await session.existingSandbox();
        let claim: PendingClaim;
        if (sandbox) {
          claim = {
            kind: "sandbox",
            claimToken: sandbox.registration.claimToken,
            email: normalized,
            attempt: await sandbox.claim({ email: normalized }),
            claimExpires: sandbox.expiresAt,
          };
        } else if (
          session.claim?.kind === "service_auth" &&
          session.claim.email === normalized &&
          session.claim.claimExpires.getTime() > Date.now()
        ) {
          // The same human again: a new code for the same registration.
          const attempt = await WebhooksCC.agent.startClaim({
            baseUrl,
            claimToken: session.claim.claimToken,
          });
          claim = { ...session.claim, attempt };
        } else {
          const registration = await WebhooksCC.agent.registerServiceAuth({
            baseUrl,
            email: normalized,
            clientName: session.clientName,
          });
          claim = {
            kind: "service_auth",
            claimToken: registration.claimToken,
            email: normalized,
            attempt: registration.claim,
            claimExpires: registration.claimTokenExpires,
          };
        }
        session.claim = claim;

        const { verificationUri, userCode, expiresAt } = claim.attempt;
        return jsonContent({
          verificationUri,
          userCode,
          expiresAt: expiresAt.toISOString(),
          tellTheHuman: `Open ${verificationUri}, sign in or sign up as ${normalized}, and enter the code ${userCode}.`,
          next: `Show the human that line, then call wait_for_connection. The code works for about ${minutesLeft(expiresAt)} minutes; connect_account gives a new one.`,
          ...(claim.kind === "sandbox"
            ? { endpoints: "The sandbox endpoints move into that account with what they captured." }
            : {}),
        });
      })
    )
  );

  registered.push(
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
        if (session.connected) {
          return jsonContent({ connected: true, message: "Already connected to an account." });
        }
        const claim = session.claim;
        if (!claim) {
          throw new Error("Nothing to wait for: call connect_account first.");
        }

        let claimed;
        try {
          claimed = await WebhooksCC.agent.waitForClaim({
            baseUrl,
            claimToken: claim.claimToken,
            interval: claim.attempt.interval,
            timeout: (timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
          });
        } catch (error) {
          if (!(error instanceof AgentAuthError)) throw error;
          if (error.code === "timeout") {
            return jsonContent({
              connected: false,
              status: "waiting",
              message: `Not connected yet. The code works until ${claim.attempt.expiresAt.toISOString()}; call wait_for_connection again.`,
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

        const client = new WebhooksCC({
          baseUrl,
          webhookUrl: session.webhookUrl,
          getAccessToken: claimedTokens(baseUrl, claimed.identityAssertion, claimed.token),
        });
        session.connected = true;
        session.claim = null;
        session.forgetSandbox();

        // Swap to the full tool set for the account. Removing and adding
        // tools sends notifications/tools/list_changed.
        for (const tool of registered) tool.remove();
        registerTools(server, client);
        options.onConnected?.(client);

        return jsonContent({
          connected: true,
          email: claim.email,
          scope: claimed.token.scope,
          message: `Connected to the webhooks.cc account of ${claim.email}. The full tool set has replaced the sandbox tools (the tool list changed; if your client does not pick that up, ask the user to restart it).${claim.kind === "sandbox" ? " The sandbox endpoints are now that account's endpoints, with what they captured." : ""} This connection lasts while this MCP server runs; for a lasting setup, the human can create an API key under Account and set WHK_API_KEY.`,
        });
      })
    )
  );

  registered.push(
    server.tool(
      "about_sandbox",
      "Explain what this agent can do without a webhooks.cc account, the sandbox limits, and how to connect an account. No network call.",
      {},
      withErrorHandling(async () => {
        return jsonContent({
          mode: "sandbox (no WHK_API_KEY)",
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
            "Call connect_account with the human's email and show them the link and code it returns.",
            "Call wait_for_connection until it reports connected; the full tools for their account then replace the sandbox tools.",
            "Sandbox endpoints move into the account with their captured requests.",
          ],
          withAnApiKey:
            "Set WHK_API_KEY to a whcc_ key from the dashboard and restart for the full tools from the start.",
          docs: DOCS_URL,
          protocol: `${baseUrl}/auth.md`,
        });
      })
    )
  );
}

/**
 * @deprecated The auth.md v0.1 registration tools are gone; this registers
 * the sandbox tools that replaced them. Use registerSandboxTools.
 */
export function registerAgentRegistrationTools(server: McpServer): void {
  registerSandboxTools(server);
}
