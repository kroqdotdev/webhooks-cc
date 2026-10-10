/**
 * @fileoverview The agent sandbox: webhook capture without an account.
 *
 * `WebhooksCC.sandbox()` registers anonymously (with a few seconds of proof
 * of work), exchanges the identity assertion for an access token, and
 * returns a client for the sandbox routes: up to 3 endpoints, 25 captured
 * requests each and 100 in all, gone after 24 hours. `claim()` and
 * `waitForClaim()` connect the agent to a human's account, which keeps the
 * endpoints and returns a full `WebhooksCC` client.
 */
import {
  AgentAuthError,
  exchange,
  registerAnonymous,
  revoke,
  startClaim,
  waitForClaim as waitForAgentClaim,
  type AccessToken,
  type AnonymousRegistration,
  type ClaimAttempt,
  type RegisterAnonymousOptions,
} from "./agent";
import { collectMatchingRequests, validatePathSegment, waitListLimit, WebhooksCC } from "./client";
import { RateLimitError, WebhooksCCError } from "./errors";
import type { Endpoint, Request, WaitForAllOptions, WaitForOptions } from "./types";

const DEFAULT_BASE_URL = "https://webhooks.cc";
/** Re-exchange this long before a token expires. */
const REFRESH_MARGIN_MS = 60_000;

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

export interface SandboxOptions extends RegisterAnonymousOptions {
  /** Base URL for sending webhooks (default: https://go.webhooks.cc). */
  webhookUrl?: string;
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

/**
 * Keeps an access token fresh from an identity assertion: exchanges on
 * first use, again shortly before expiry, and on demand after a 401.
 */
class TokenSource {
  private current: AccessToken | null = null;
  private pending: Promise<AccessToken> | null = null;

  constructor(
    private readonly baseUrl: string,
    private assertion: string,
    private readonly timeout?: number
  ) {}

  async get(forceRefresh = false): Promise<string> {
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
      }).finally(() => {
        this.pending = null;
      });
    }
    this.current = await this.pending;
    return this.current.accessToken;
  }

  peek(): string | null {
    return this.current?.accessToken ?? null;
  }

  replace(assertion: string, token?: AccessToken): void {
    this.assertion = assertion;
    this.current = token ?? null;
  }
}

export class SandboxClient {
  private readonly tokens: TokenSource;
  private readonly baseUrl: string;
  private readonly webhookUrl?: string;
  private readonly timeout?: number;
  private closed = false;

  /** @internal Use `WebhooksCC.sandbox()`. */
  constructor(
    readonly registration: AnonymousRegistration,
    options: SandboxOptions
  ) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.webhookUrl = options.webhookUrl;
    this.timeout = options.timeout;
    this.tokens = new TokenSource(this.baseUrl, registration.identityAssertion, options.timeout);
  }

  /** The registration id, for logs; the server never asks for it. */
  get registrationId(): string {
    return this.registration.registrationId;
  }

  /** When the sandbox, its endpoints and its captures are deleted. */
  get expiresAt(): Date {
    return this.registration.claimTokenExpires;
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
        throw new SandboxError(
          String(json.error ?? `http_${response.status}`),
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
   */
  async claim(options: { email: string }): Promise<ClaimAttempt> {
    const attempt = await startClaim({
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      claimToken: this.registration.claimToken,
      email: options.email,
    });
    return {
      userCode: attempt.userCode,
      verificationUri: attempt.verificationUri,
      expiresAt: attempt.expiresAt,
      interval: attempt.interval,
    };
  }

  /**
   * Waits until the human enters the code, then returns a `WebhooksCC`
   * client acting for their account. Its token renews itself from the
   * claimed assertion. The sandbox endpoints are now that account's
   * endpoints, and this sandbox client stops working.
   */
  async waitForClaim(
    options: { timeout?: number; signal?: AbortSignal } = {}
  ): Promise<WebhooksCC> {
    const claimed = await waitForAgentClaim({
      baseUrl: this.baseUrl,
      claimToken: this.registration.claimToken,
      timeout: options.timeout,
      signal: options.signal,
    });
    this.closed = true;
    const tokens = new TokenSource(this.baseUrl, claimed.identityAssertion, this.timeout);
    tokens.replace(claimed.identityAssertion, claimed.token);
    return new WebhooksCC({
      baseUrl: this.baseUrl,
      webhookUrl: this.webhookUrl,
      timeout: this.timeout,
      getAccessToken: (refresh) => tokens.get(refresh?.forceRefresh ?? false),
    });
  }

  /** Drops the current access token. A later call exchanges a new one. */
  async revokeToken(): Promise<void> {
    const token = this.tokens.peek();
    if (!token) return;
    await revoke({ baseUrl: this.baseUrl, timeout: this.timeout, token });
    this.tokens.replace(this.registration.identityAssertion);
  }
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

/** Registers, exchanges, and returns the sandbox client. */
export async function createSandbox(options: SandboxOptions = {}): Promise<SandboxClient> {
  const registration = await registerAnonymous(options);
  const client = new SandboxClient(registration, options);
  // Fail early, with the server's reason, if the token cannot be had.
  await client["tokens"].get();
  return client;
}

export { AgentAuthError };
