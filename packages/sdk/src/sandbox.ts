/**
 * @fileoverview The agent sandbox, and connecting an agent to a human's
 * account.
 *
 * `WebhooksCC.sandbox()` registers anonymously (with a few seconds of proof
 * of work), exchanges the identity assertion for an access token, and
 * returns a client for the sandbox routes: up to 3 endpoints, 25 captured
 * requests each and 100 in all, gone after 24 hours. `claim()` and
 * `waitForClaim()` connect the agent to a human's account, which keeps the
 * endpoints and returns a full `WebhooksCC` client.
 *
 * Registrations are kept in the agent credential file shared with the MCP
 * server, the other SDKs and the CLI (conformance/agent-credentials.md): a
 * later run reuses the live sandbox instead of registering again, and
 * `WebhooksCC.connected()` returns the account a human connected before.
 * The claim token is never written; a process that did not register the
 * sandbox connects the human through a service_auth registration instead.
 */
import {
  AgentAuthError,
  exchange,
  registerAnonymous,
  registerServiceAuth,
  revoke,
  startClaim,
  waitForClaim as waitForAgentClaim,
  type AccessToken,
  type AnonymousRegistration,
  type ClaimAttempt,
  type ClaimPoll,
  type RegisterAnonymousOptions,
} from "./agent";
import {
  AgentCredentialStore,
  normalizeIssuer,
  parseTimestamp,
  usableToken,
  type CredentialSlot,
  type CredentialSlotName,
} from "./agent-credentials";
import { collectMatchingRequests, validatePathSegment, waitListLimit, WebhooksCC } from "./client";
import { RateLimitError, WebhooksCCError } from "./errors";
import type { Endpoint, Request, WaitForAllOptions, WaitForOptions } from "./types";

const DEFAULT_BASE_URL = "https://webhooks.cc";
/** Re-exchange this long before a token expires. */
const REFRESH_MARGIN_MS = 60_000;
/** Captures one sandbox endpoint takes before it answers 429 (as on the server). */
const SANDBOX_REQUESTS_PER_ENDPOINT = 25;
/** The sandbox limits webhooks.cc enforces, for a sandbox read back from the file. */
const SANDBOX_LIMITS = { maxEndpoints: 3, maxRequestsPerEndpoint: 25, maxRequests: 100 };

/** The registration-wide limits and what is used of them. */
export interface SandboxLimits {
  expiresAt: number;
  maxEndpoints: number;
  requestLimit: number;
  budget: { used: number; limit: number };
}

/** A sandbox endpoint: the usual endpoint fields, plus its sandbox limits. */
export interface SandboxEndpoint extends Endpoint {
  requestCount: number;
  sandbox: SandboxLimits;
}

/** Where the agent credential file is: its path, or false for none. */
export interface CredentialFileOption {
  /**
   * The agent credential file (default: WHK_AGENT_FILE, else
   * `~/.config/whk/agent.json` or the platform's equivalent). `false` keeps
   * everything in memory.
   */
  credentialsFile?: string | false;
}

export interface SandboxOptions extends RegisterAnonymousOptions, CredentialFileOption {
  /** Base URL for sending webhooks (default: https://go.webhooks.cc). */
  webhookUrl?: string;
}

/**
 * The sandbox's registration. `claimToken` is null for a sandbox read back
 * from the credential file: only the process that registered holds it.
 */
export interface SandboxRegistration extends Omit<AnonymousRegistration, "claimToken"> {
  claimToken: string | null;
}

/** A claim attempt; `movesEndpoints` says whether the sandbox endpoints go with it. */
export interface SandboxClaimAttempt extends ClaimAttempt {
  movesEndpoints: boolean;
}

/**
 * A refused sandbox call: `code` is the server's (sandbox_full, ...). A
 * WebhooksCCError, so `requests.waitFor()` stops on a 4xx refusal instead of
 * polling until it times out.
 */
export class SandboxError extends WebhooksCCError {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(status, message);
    this.name = "SandboxError";
  }
}

function isInvalidGrant(error: unknown): boolean {
  return error instanceof AgentAuthError && error.code === "invalid_grant";
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

/** A slot in the credential file that a token source keeps up to date. */
interface PersistedSlot {
  store: AgentCredentialStore;
  issuer: string;
  name: CredentialSlotName;
  slot: CredentialSlot;
}

/**
 * Keeps an access token fresh from an identity assertion: exchanges on
 * first use, again shortly before expiry, and on demand after a 401. With a
 * slot in the credential file it starts from the token cached there, writes
 * each new token back, and removes the slot when the assertion is refused
 * (`invalid_grant`: expired, revoked or claimed).
 */
class AssertionTokens {
  private current: AccessToken | null;
  private pending: Promise<AccessToken> | null = null;
  /** Set once the server refused the assertion; nothing will work again. */
  private refused: AgentAuthError | null = null;

  constructor(
    private readonly baseUrl: string,
    private assertion: string,
    private readonly timeout: number | undefined,
    private persisted: PersistedSlot | null = null,
    initial: AccessToken | null = null,
    private readonly onRevoked?: () => void
  ) {
    this.current = initial;
    if (!initial && persisted) {
      const cached = usableToken(persisted.slot, Date.now());
      if (cached) {
        this.current = {
          accessToken: cached,
          scope: persisted.slot.scope ?? "",
          expiresAt: new Date(parseTimestamp(persisted.slot.access_token_expires)),
        };
      }
    }
  }

  async get(forceRefresh = false): Promise<string> {
    if (this.refused) throw this.refused;
    if (
      !forceRefresh &&
      this.current &&
      this.current.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS
    ) {
      return this.current.accessToken;
    }
    if (!this.pending) {
      this.pending = exchange({
        baseUrl: this.baseUrl,
        timeout: this.timeout,
        assertion: this.assertion,
      })
        .then(
          (token) => {
            this.persist(token);
            return token;
          },
          (error: unknown) => {
            if (isInvalidGrant(error) && !this.refused) {
              this.refused = error as AgentAuthError;
              this.current = null;
              this.forgetSlot();
              this.onRevoked?.();
            }
            throw error;
          }
        )
        .finally(() => {
          this.pending = null;
        });
    }
    this.current = await this.pending;
    return this.current.accessToken;
  }

  peek(): string | null {
    return this.current?.accessToken ?? null;
  }

  /** Drops the current token; the next call exchanges again. */
  reset(): void {
    this.current = null;
  }

  /**
   * Removes this token source's slot from the credential file, unless
   * another process has replaced it with another registration since.
   */
  forgetSlot(): void {
    if (!this.persisted) return;
    const { store, issuer, name, slot } = this.persisted;
    store.remove(issuer, name, { ifRegistration: slot.registration_id });
    this.persisted = null;
  }

  /** Caches a new token in the slot, while the slot still holds this registration. */
  private persist(token: AccessToken): void {
    if (!this.persisted) return;
    const slot: CredentialSlot = {
      ...this.persisted.slot,
      access_token: token.accessToken,
      access_token_expires: token.expiresAt.toISOString(),
    };
    this.persisted.slot = slot;
    this.persisted.store.save(this.persisted.issuer, this.persisted.name, slot, {
      ifRegistration: slot.registration_id,
    });
  }
}

interface AccountClientInput {
  baseUrl: string;
  webhookUrl?: string;
  timeout?: number;
  store: AgentCredentialStore | null;
  registrationId: string;
  email?: string;
  clientName?: string;
  claimed: Extract<ClaimPoll, { status: "claimed" }>;
}

/**
 * Saves a claimed registration to the credential file and returns a client
 * for the account, whose token renews itself from the claimed assertion.
 */
function accountClient(input: AccountClientInput): WebhooksCC {
  const slot: CredentialSlot = {
    registration_id: input.registrationId,
    identity_assertion: input.claimed.identityAssertion,
    assertion_expires: input.claimed.assertionExpires.toISOString(),
    scope: input.claimed.token.scope,
    ...(input.email ? { email: input.email } : {}),
    ...(input.clientName ? { client_name: input.clientName } : {}),
    saved_at: new Date().toISOString(),
    access_token: input.claimed.token.accessToken,
    access_token_expires: input.claimed.token.expiresAt.toISOString(),
  };
  const issuer = normalizeIssuer(input.baseUrl);
  input.store?.save(issuer, "claimed", slot);
  const tokens = new AssertionTokens(
    input.baseUrl,
    input.claimed.identityAssertion,
    input.timeout,
    input.store ? { store: input.store, issuer, name: "claimed", slot } : null,
    input.claimed.token
  );
  return new WebhooksCC({
    baseUrl: input.baseUrl,
    webhookUrl: input.webhookUrl,
    timeout: input.timeout,
    getAccessToken: (refresh) => tokens.get(refresh?.forceRefresh ?? false),
  });
}

interface PendingClaim {
  kind: "sandbox" | "service_auth";
  claimToken: string;
  registrationId: string;
  email: string;
  claimTokenExpires: Date;
}

export class SandboxClient {
  private readonly tokens: AssertionTokens;
  private readonly baseUrl: string;
  private readonly webhookUrl?: string;
  private readonly timeout?: number;
  private readonly clientName?: string;
  private readonly store: AgentCredentialStore | null;
  private pendingClaim: PendingClaim | null = null;
  private closed = false;

  /** @internal Use `WebhooksCC.sandbox()`. */
  constructor(
    readonly registration: SandboxRegistration,
    options: SandboxOptions,
    store: AgentCredentialStore | null = null,
    slot: CredentialSlot | null = null
  ) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.webhookUrl = options.webhookUrl;
    this.timeout = options.timeout;
    this.clientName = options.clientName;
    this.store = store;
    this.tokens = new AssertionTokens(
      this.baseUrl,
      registration.identityAssertion,
      options.timeout,
      store && slot ? { store, issuer: normalizeIssuer(this.baseUrl), name: "sandbox", slot } : null
    );
  }

  /**
   * The live sandbox saved in the credential file, or null. Never registers:
   * a saved sandbox the server refuses is removed and gives null.
   */
  static async resume(options: SandboxOptions = {}): Promise<SandboxClient | null> {
    const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    const store = AgentCredentialStore.resolve(options.credentialsFile);
    const saved = store?.load(baseUrl).sandbox ?? null;
    if (!store || !saved) return null;
    const client = new SandboxClient(slotRegistration(saved), options, store, saved);
    try {
      await client.ready();
      return client;
    } catch (error) {
      if (isInvalidGrant(error)) return null;
      throw error;
    }
  }

  /** What JSON.stringify and console.log show: never the claim token or a token. */
  toJSON(): { registrationId: string; expiresAt: string } {
    return { registrationId: this.registrationId, expiresAt: this.expiresAt.toISOString() };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SandboxClient ${JSON.stringify(this.toJSON())}`;
  }

  /** The registration id, for logs; the server never asks for it. */
  get registrationId(): string {
    return this.registration.registrationId;
  }

  /** When the sandbox, its endpoints and its captures are deleted. */
  get expiresAt(): Date {
    return this.registration.assertionExpires;
  }

  /** @internal Exchanges the first token, so a dead registration shows at once. */
  async ready(): Promise<void> {
    await this.tokens.get();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.closed) {
      throw new SandboxError(
        "sandbox_closed",
        403,
        "This sandbox was claimed; use the client waitForClaim() returned."
      );
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.get(attempt > 0);
      const response = await fetch(`${this.baseUrl}/api/agent/sandbox${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout ?? 30_000),
      });
      // A 401 means the token expired or was revoked: exchange once more.
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        // A proxy's HTML error page: the status still says what happened.
        if (response.ok) throw new SandboxError("invalid_response", response.status, "Not JSON");
      }
      // A rate limit is worth waiting out, like the rest of the SDK does.
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new RateLimitError(Number.isFinite(retryAfter) ? retryAfter : undefined);
      }
      if (!response.ok) {
        const code = String(json.error ?? `http_${response.status}`);
        // Claimed, revoked or expired elsewhere: this registration is done.
        if (code === "sandbox_closed") this.tokens.forgetSlot();
        throw new SandboxError(
          code,
          response.status,
          String(json.error_description ?? `Sandbox request failed (HTTP ${response.status})`)
        );
      }
      return json as T;
    }
    throw new SandboxError("unauthorized", 401, "The sandbox token was refused.");
  }

  private withUrl(endpoint: SandboxEndpoint): SandboxEndpoint {
    if (!endpoint.url && this.webhookUrl) {
      return { ...endpoint, url: `${this.webhookUrl}/w/${endpoint.slug}` };
    }
    return endpoint;
  }

  endpoints = {
    /**
     * Creates a capture endpoint. Throws SandboxError `sandbox_endpoint_limit`
     * at 3 live endpoints, or `sandbox_full` when the shared pool is full.
     */
    create: async (): Promise<SandboxEndpoint> =>
      this.withUrl(await this.request<SandboxEndpoint>("POST", "/endpoints", {})),

    list: async (): Promise<SandboxEndpoint[]> => {
      const result = await this.request<{ endpoints: SandboxEndpoint[] }>("GET", "/endpoints");
      return result.endpoints.map((endpoint) => this.withUrl(endpoint));
    },

    get: async (slug: string): Promise<SandboxEndpoint> => {
      validatePathSegment(slug, "slug");
      return this.withUrl(await this.request<SandboxEndpoint>("GET", `/endpoints/${slug}`));
    },

    /** Frees a slot. The registration's request budget is not refunded. */
    delete: async (slug: string): Promise<void> => {
      validatePathSegment(slug, "slug");
      await this.request<void>("DELETE", `/endpoints/${slug}`);
    },
  };

  requests = {
    /** Captured requests, newest first (at most 100). */
    list: async (
      slug: string,
      options: { since?: number; limit?: number } = {}
    ): Promise<Request[]> => {
      validatePathSegment(slug, "slug");
      const query = new URLSearchParams();
      if (options.since !== undefined) query.set("since", String(options.since));
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      const suffix = query.size > 0 ? `?${query}` : "";
      return this.request<Request[]>("GET", `/endpoints/${slug}/requests${suffix}`);
    },

    get: async (requestId: string): Promise<Request> => {
      validatePathSegment(requestId, "requestId");
      return this.request<Request>("GET", `/requests/${requestId}`);
    },

    waitFor: async (slug: string, options: WaitForOptions = {}): Promise<Request> => {
      const [request] = await this.requests.waitForAll(slug, { ...options, count: 1 });
      return request;
    },

    waitForAll: async (slug: string, options: WaitForAllOptions): Promise<Request[]> => {
      validatePathSegment(slug, "slug");
      // A count above what one endpoint can capture could only time out.
      if (
        Number.isFinite(options.count) &&
        Math.floor(options.count) > SANDBOX_REQUESTS_PER_ENDPOINT
      ) {
        throw new RangeError(
          `A sandbox endpoint captures at most ${SANDBOX_REQUESTS_PER_ENDPOINT} requests, so count must be at most ${SANDBOX_REQUESTS_PER_ENDPOINT}.`
        );
      }
      const limit = Math.min(100, waitListLimit(options.count));
      return collectMatchingRequests(
        (since) => this.requests.list(slug, { since, limit }),
        options
      );
    },
  };

  /**
   * Starts connecting this agent to a human's account. Show the human
   * `verificationUri` and `userCode` together; only someone signed in as
   * `email` can complete it. Calling again replaces the previous code.
   *
   * A sandbox read back from the credential file has no claim token, so its
   * endpoints cannot move: the human is connected through a new registration
   * (`movesEndpoints` is false) and the sandbox keeps working until it
   * expires.
   */
  async claim(options: { email: string }): Promise<SandboxClaimAttempt> {
    const email = options.email.trim().toLowerCase();
    const claimToken = this.registration.claimToken;
    if (claimToken) {
      const attempt = await startClaim({
        baseUrl: this.baseUrl,
        timeout: this.timeout,
        claimToken,
        email,
      });
      this.pendingClaim = {
        kind: "sandbox",
        claimToken,
        registrationId: this.registration.registrationId,
        email,
        claimTokenExpires: this.registration.claimTokenExpires,
      };
      return { ...withoutRegistration(attempt), movesEndpoints: true };
    }

    const pending = this.pendingClaim;
    if (pending && pending.email === email && pending.claimTokenExpires.getTime() > Date.now()) {
      const attempt = await startClaim({
        baseUrl: this.baseUrl,
        timeout: this.timeout,
        claimToken: pending.claimToken,
      });
      return { ...withoutRegistration(attempt), movesEndpoints: false };
    }
    const registration = await registerServiceAuth({
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      email,
      clientName: this.clientName,
    });
    this.pendingClaim = {
      kind: "service_auth",
      claimToken: registration.claimToken,
      registrationId: registration.registrationId,
      email,
      claimTokenExpires: registration.claimTokenExpires,
    };
    return { ...registration.claim, movesEndpoints: false };
  }

  /**
   * Waits until the human enters the code, then returns a `WebhooksCC`
   * client acting for their account, saved to the credential file. Its
   * token renews itself from the claimed assertion. When the claim moved the
   * sandbox endpoints, they are now that account's endpoints and this
   * sandbox client stops working.
   */
  async waitForClaim(
    options: { timeout?: number; signal?: AbortSignal } = {}
  ): Promise<WebhooksCC> {
    const pending = this.pendingClaim;
    const claimToken = pending?.claimToken ?? this.registration.claimToken;
    if (!claimToken) {
      throw new SandboxError("no_claim", 400, "Call claim() first.");
    }
    const claimed = await waitForAgentClaim({
      baseUrl: this.baseUrl,
      claimToken,
      timeout: options.timeout,
      signal: options.signal,
    });
    this.pendingClaim = null;
    const movedSandbox = !pending || pending.kind === "sandbox";
    if (movedSandbox) {
      this.closed = true;
      this.tokens.forgetSlot();
    }
    return accountClient({
      baseUrl: this.baseUrl,
      webhookUrl: this.webhookUrl,
      timeout: this.timeout,
      store: this.store,
      registrationId: pending?.registrationId ?? this.registration.registrationId,
      email: pending?.email,
      clientName: this.clientName,
      claimed,
    });
  }

  /** Drops the current access token. A later call exchanges a new one. */
  async revokeToken(): Promise<void> {
    const token = this.tokens.peek();
    if (!token) return;
    await revoke({ baseUrl: this.baseUrl, timeout: this.timeout, token });
    this.tokens.reset();
  }
}

function withoutRegistration(attempt: ClaimAttempt & { registrationId: string }): ClaimAttempt {
  return {
    userCode: attempt.userCode,
    verificationUri: attempt.verificationUri,
    expiresAt: attempt.expiresAt,
    interval: attempt.interval,
  };
}

function slotRegistration(slot: CredentialSlot): SandboxRegistration {
  const expires = new Date(parseTimestamp(slot.assertion_expires));
  return {
    registrationId: slot.registration_id,
    identityAssertion: slot.identity_assertion,
    assertionExpires: expires,
    claimToken: null,
    claimTokenExpires: expires,
    preClaimScopes: ["webhooks:sandbox"],
    postClaimScopes: ["webhooks:read", "webhooks:write"],
    sandbox: { status: "available", endpointsUrl: "", ...SANDBOX_LIMITS },
  };
}

/**
 * Returns the sandbox client: the live sandbox from the credential file when
 * there is one, else a new registration (saved to the file).
 */
export async function createSandbox(options: SandboxOptions = {}): Promise<SandboxClient> {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
  const store = AgentCredentialStore.resolve(options.credentialsFile);
  const resumed = await SandboxClient.resume(options);
  if (resumed) return resumed;

  const registration = await registerAnonymous(options);
  const slot: CredentialSlot = {
    registration_id: registration.registrationId,
    identity_assertion: registration.identityAssertion,
    assertion_expires: registration.assertionExpires.toISOString(),
    ...(options.clientName ? { client_name: options.clientName } : {}),
    saved_at: new Date().toISOString(),
  };
  store?.save(normalizeIssuer(baseUrl), "sandbox", slot);
  const client = new SandboxClient(registration, options, store, slot);
  // Fail early, with the server's reason, if the token cannot be had.
  await client.ready();
  return client;
}

export interface ConnectedOptions extends CredentialFileOption {
  /** Base URL of the webhooks.cc app (default: https://webhooks.cc). */
  baseUrl?: string;
  /** Base URL for sending webhooks (default: https://go.webhooks.cc). */
  webhookUrl?: string;
  /** Request timeout in ms (default: 30000). */
  timeout?: number;
  /**
   * Called once when the server refuses the saved connection (the human
   * disconnected the agent, or its 90 days ran out); it is then removed
   * from the file and requests fail with UnauthorizedError.
   */
  onRevoked?: () => void;
}

/**
 * A client for the saved account connection, or null; synchronous. Nothing
 * is checked until the first request, which exchanges the assertion when the
 * cached token is gone.
 */
export function savedConnection(options: ConnectedOptions = {}): WebhooksCC | null {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
  const store = AgentCredentialStore.resolve(options.credentialsFile);
  const slot = store?.load(baseUrl).claimed ?? null;
  if (!store || !slot) return null;
  const tokens = new AssertionTokens(
    baseUrl,
    slot.identity_assertion,
    options.timeout,
    { store, issuer: normalizeIssuer(baseUrl), name: "claimed", slot },
    null,
    options.onRevoked
  );
  return new WebhooksCC({
    baseUrl,
    webhookUrl: options.webhookUrl,
    timeout: options.timeout,
    getAccessToken: (refresh) => tokens.get(refresh?.forceRefresh ?? false),
  });
}

/**
 * A client for the account a human connected this agent to before, read
 * from the credential file, or null. A connection the human removed (or
 * whose 90 days ran out) is deleted from the file and gives null.
 */
export async function connectedClient(options: ConnectedOptions = {}): Promise<WebhooksCC | null> {
  let revoked = false;
  const client = savedConnection({
    ...options,
    onRevoked: () => {
      revoked = true;
      options.onRevoked?.();
    },
  });
  if (!client) return null;
  try {
    // The cheapest authenticated call; it also refreshes the cached token.
    await client.usage();
  } catch (error) {
    if (revoked) return null;
    throw error;
  }
  return client;
}

export interface ConnectOptions extends ConnectedOptions {
  /** The human's email: only someone signed in to webhooks.cc as it can connect. */
  email: string;
  /** Your agent's name, shown to the human as self-reported (64 characters). */
  clientName?: string;
}

/**
 * A request to connect an agent to a human's account: show the human
 * `verificationUri` and `userCode`, then `wait()`.
 */
export class PendingConnection implements ClaimAttempt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: Date;
  readonly interval: number;

  /** @internal Use `WebhooksCC.connect()`. */
  constructor(
    private readonly options: ConnectOptions & { baseUrl: string },
    readonly registrationId: string,
    private readonly claimToken: string,
    attempt: ClaimAttempt
  ) {
    this.userCode = attempt.userCode;
    this.verificationUri = attempt.verificationUri;
    this.expiresAt = attempt.expiresAt;
    this.interval = attempt.interval;
  }

  /**
   * Waits until the human enters the code; resolves with a client for their
   * account, saved to the credential file. Rejects with an AgentAuthError:
   * `expired_token` (call `restart()`), `access_denied`, or `timeout`.
   */
  async wait(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<WebhooksCC> {
    const claimed = await waitForAgentClaim({
      baseUrl: this.options.baseUrl,
      claimToken: this.claimToken,
      interval: this.interval,
      timeout: options.timeout,
      signal: options.signal,
    });
    return accountClient({
      baseUrl: this.options.baseUrl,
      webhookUrl: this.options.webhookUrl,
      timeout: this.options.timeout,
      store: AgentCredentialStore.resolve(this.options.credentialsFile),
      registrationId: this.registrationId,
      email: this.options.email.trim().toLowerCase(),
      clientName: this.options.clientName,
      claimed,
    });
  }

  /** What JSON.stringify and console.log show: never the claim token. */
  toJSON(): ClaimAttempt & { registrationId: string } {
    return {
      registrationId: this.registrationId,
      userCode: this.userCode,
      verificationUri: this.verificationUri,
      expiresAt: this.expiresAt,
      interval: this.interval,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `PendingConnection ${JSON.stringify(this.toJSON())}`;
  }

  /** A new code for the same request; the previous one stops working. */
  async restart(): Promise<PendingConnection> {
    const attempt = await startClaim({
      baseUrl: this.options.baseUrl,
      timeout: this.options.timeout,
      claimToken: this.claimToken,
    });
    return new PendingConnection(this.options, this.registrationId, this.claimToken, attempt);
  }
}

/** Registers service_auth for the human and returns the first code. */
export async function connectAccount(options: ConnectOptions): Promise<PendingConnection> {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
  const registration = await registerServiceAuth({
    baseUrl,
    timeout: options.timeout,
    email: options.email.trim().toLowerCase(),
    clientName: options.clientName,
  });
  return new PendingConnection(
    { ...options, baseUrl },
    registration.registrationId,
    registration.claimToken,
    registration.claim
  );
}

export { AgentAuthError };
