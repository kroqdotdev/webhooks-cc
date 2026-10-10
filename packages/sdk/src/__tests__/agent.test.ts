import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAuthError, exchange, pollClaim, registerAnonymous, waitForClaim } from "../agent";
import { WebhooksCC } from "../client";
import { WebhooksCCError } from "../errors";
import { SandboxError } from "../sandbox";

const BASE = "https://agent.test";

type Route = (url: URL, init: RequestInit) => { status: number; body?: unknown } | undefined;

/** Answers fetch calls from a list of handlers; unmatched calls fail the test. */
function mockFetch(...routes: Route[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const route of routes) {
      const answer = route(url, init);
      if (answer) {
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`Unexpected fetch ${init.method ?? "GET"} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function form(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

function challengeBody(id: string) {
  return { challenge: `pow1.${id}.sig`, algorithm: "sha256-zero-bits", difficulty: 4, count: 2 };
}

const registration = {
  registration_id: "11111111-1111-4111-8111-111111111111",
  registration_type: "anonymous",
  identity_assertion: "assertion-1",
  assertion_expires: "2026-10-11T00:00:00.000Z",
  pre_claim_scopes: ["webhooks:sandbox"],
  claim_url: `${BASE}/api/agent/identity/claim`,
  claim_token: "clm_token",
  claim_token_expires: "2026-10-11T00:00:00.000Z",
  post_claim_scopes: ["webhooks:read", "webhooks:write"],
  sandbox: { status: "available", endpoints_url: `${BASE}/api/agent/sandbox/endpoints` },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerAnonymous", () => {
  it("solves the challenge and registers with its nonces", async () => {
    const calls = mockFetch(
      (url) =>
        url.pathname === "/api/agent/identity/challenge"
          ? { status: 200, body: challengeBody("a") }
          : undefined,
      (url) =>
        url.pathname === "/api/agent/identity" ? { status: 200, body: registration } : undefined
    );
    const result = await registerAnonymous({ baseUrl: BASE, clientName: "unit" });
    expect(result).toMatchObject({
      registrationId: registration.registration_id,
      identityAssertion: "assertion-1",
      claimToken: "clm_token",
      sandbox: { status: "available" },
    });

    const sent = JSON.parse(String(calls[1].init.body));
    expect(sent).toMatchObject({ type: "anonymous", client_name: "unit" });
    sent.proof_of_work.nonces.forEach((nonce: string, i: number) => {
      const digest = createHash("sha256").update(`pow1.a.sig.${i}.${nonce}`).digest();
      expect(digest[0] >> 4).toBe(0);
    });
  });

  it("solves the fresh challenge once when the first is refused", async () => {
    let registrations = 0;
    const calls = mockFetch(
      (url) =>
        url.pathname === "/api/agent/identity/challenge"
          ? { status: 200, body: challengeBody("old") }
          : undefined,
      (url) => {
        if (url.pathname !== "/api/agent/identity") return undefined;
        registrations++;
        return registrations === 1
          ? { status: 400, body: { error: "invalid_challenge", ...challengeBody("new") } }
          : { status: 200, body: registration };
      }
    );
    await registerAnonymous({ baseUrl: BASE });
    expect(JSON.parse(String(calls[2].init.body)).proof_of_work.challenge).toBe("pow1.new.sig");
  });

  it("surfaces refusals as AgentAuthError", async () => {
    mockFetch(
      (url) =>
        url.pathname === "/api/agent/identity/challenge"
          ? { status: 200, body: challengeBody("a") }
          : undefined,
      (url) =>
        url.pathname === "/api/agent/identity"
          ? { status: 400, body: { error: "anonymous_not_enabled", error_description: "off" } }
          : undefined
    );
    await expect(registerAnonymous({ baseUrl: BASE })).rejects.toMatchObject({
      name: "AgentAuthError",
      code: "anonymous_not_enabled",
      status: 400,
      description: "off",
    });
  });
});

describe("tokens and claims", () => {
  it("exchanges with the jwt-bearer grant, form-encoded", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/oauth2/token"
        ? {
            status: 200,
            body: {
              access_token: "whcc_a",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "webhooks:sandbox",
            },
          }
        : undefined
    );
    const token = await exchange({ baseUrl: BASE, assertion: "assertion-1" });
    expect(token.accessToken).toBe("whcc_a");
    expect(form(calls[0].init).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer"
    );
    expect(form(calls[0].init).get("assertion")).toBe("assertion-1");
  });

  it("maps the claim grant's answers", async () => {
    for (const [error, status] of [
      ["authorization_pending", "pending"],
      ["slow_down", "slow_down"],
      ["expired_token", "expired"],
      ["access_denied", "denied"],
    ] as const) {
      mockFetch(() => ({ status: 400, body: { error } }));
      expect(await pollClaim({ baseUrl: BASE, claimToken: "clm_token" })).toEqual({ status });
    }
    mockFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
    await expect(pollClaim({ baseUrl: BASE, claimToken: "clm_token" })).rejects.toBeInstanceOf(
      AgentAuthError
    );
  });

  it("waits through pending and returns the claimed credentials", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockFetch(() => {
      polls++;
      return polls < 3
        ? { status: 400, body: { error: "authorization_pending" } }
        : {
            status: 200,
            body: {
              access_token: "whcc_account",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "webhooks:read webhooks:write",
              identity_assertion: "claimed-assertion",
              assertion_expires: "2027-01-08T00:00:00.000Z",
            },
          };
    });
    const waiting = waitForClaim({ baseUrl: BASE, claimToken: "clm_token", interval: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await waiting;
    vi.useRealTimers();
    expect(result).toMatchObject({ status: "claimed", identityAssertion: "claimed-assertion" });
    expect(result.token.accessToken).toBe("whcc_account");
    expect(polls).toBe(3);
  });

  it("stops waiting when the human declines", async () => {
    mockFetch(() => ({ status: 400, body: { error: "access_denied" } }));
    await expect(waitForClaim({ baseUrl: BASE, claimToken: "clm_token" })).rejects.toMatchObject({
      code: "access_denied",
    });
  });
});

describe("sandbox client", () => {
  function sandboxRoutes(state: { exchanges: number; rejectFirstToken: boolean }): Route[] {
    return [
      (url) =>
        url.pathname === "/api/agent/identity/challenge"
          ? { status: 200, body: challengeBody("a") }
          : undefined,
      (url) =>
        url.pathname === "/api/agent/identity" ? { status: 200, body: registration } : undefined,
      (url, init) => {
        if (url.pathname !== "/api/oauth2/token") return undefined;
        if (form(init).get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer")
          return undefined;
        state.exchanges++;
        return {
          status: 200,
          body: {
            access_token: `whcc_t${state.exchanges}`,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "webhooks:sandbox",
          },
        };
      },
      (url, init) => {
        if (!url.pathname.startsWith("/api/agent/sandbox/")) return undefined;
        const auth = new Headers(init.headers).get("authorization");
        if (state.rejectFirstToken && auth === "Bearer whcc_t1")
          return { status: 401, body: { error: "Invalid token" } };
        if (url.pathname === "/api/agent/sandbox/endpoints" && init.method === "POST") {
          return {
            status: 503,
            body: { error: "sandbox_full", error_description: "The sandbox is full." },
          };
        }
        return {
          status: 200,
          body: { endpoints: [], sandbox: { budget: { used: 0, limit: 100 } } },
        };
      },
    ];
  }

  it("exchanges once, renews after a 401, and maps refusals to SandboxError", async () => {
    const state = { exchanges: 0, rejectFirstToken: true };
    mockFetch(...sandboxRoutes(state));
    const sandbox = await WebhooksCC.sandbox({ baseUrl: BASE });
    expect(state.exchanges).toBe(1);
    expect(await sandbox.endpoints.list()).toEqual([]);
    expect(state.exchanges).toBe(2);
    const refused = await sandbox.endpoints.create().catch((error) => error);
    expect(refused).toBeInstanceOf(SandboxError);
    expect(refused).toMatchObject({ code: "sandbox_full", status: 503 });
  });

  it("refuses to wait for more requests than an endpoint can capture", async () => {
    const state = { exchanges: 0, rejectFirstToken: false };
    const requestPolls = vi.fn();
    mockFetch(
      (url) => {
        if (url.pathname.endsWith("/requests")) requestPolls();
        return undefined;
      },
      ...sandboxRoutes(state)
    );
    const sandbox = await WebhooksCC.sandbox({ baseUrl: BASE });
    await expect(sandbox.requests.waitForAll("abc123", { count: 26 })).rejects.toThrow(RangeError);
    expect(requestPolls).not.toHaveBeenCalled();
  });

  it("waitFor stops at once on a sandbox refusal, and tolerates an HTML error page", async () => {
    const state = { exchanges: 0, rejectFirstToken: false };
    let html = true;
    mockFetch(
      (url) => {
        if (!url.pathname.endsWith("/requests")) return undefined;
        if (html) {
          html = false;
          return { status: 502, body: undefined };
        }
        return { status: 403, body: { error: "sandbox_closed", error_description: "Claimed." } };
      },
      ...sandboxRoutes(state)
    );
    const sandbox = await WebhooksCC.sandbox({ baseUrl: BASE });
    const started = Date.now();
    const refused = await sandbox.requests
      .waitFor("abc123", { timeout: 20_000, pollInterval: 10 })
      .catch((error) => error);
    expect(refused).toBeInstanceOf(SandboxError);
    expect(refused).toBeInstanceOf(WebhooksCCError);
    expect(refused).toMatchObject({ code: "sandbox_closed", status: 403 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a client built on getAccessToken renews its token after a 401", async () => {
    let issued = 0;
    const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh || issued === 0) issued++;
      return `whcc_account${issued}`;
    });
    mockFetch((url, init) => {
      if (url.pathname !== "/api/endpoints") return undefined;
      return new Headers(init.headers).get("authorization") === "Bearer whcc_account1"
        ? { status: 401, body: { error: "Invalid token" } }
        : { status: 200, body: { owned: [], shared: [] } };
    });
    const client = new WebhooksCC({ baseUrl: BASE, getAccessToken });
    await client.endpoints.list();
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("needs an API key or a token source", () => {
    expect(() => new WebhooksCC({})).toThrow(/apiKey/);
  });
});
