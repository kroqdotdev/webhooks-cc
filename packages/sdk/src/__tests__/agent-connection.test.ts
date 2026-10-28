/**
 * The sandbox and account connections kept in the agent credential file:
 * reuse across runs, cached tokens, invalid_grant clean-up, and claims with
 * and without the claim token.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";

const BASE = "https://agent.test";
const DAY = 86_400_000;

type Answer = { status: number; body?: unknown };
type Route = (url: URL, init: RequestInit) => Answer | undefined;

function mockFetch(...routes: Route[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
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
    })
  );
  return calls;
}

function form(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface Server {
  registrations: number;
  exchanges: number;
  serviceAuth: number;
  /** Assertions the token endpoint refuses with invalid_grant. */
  refused: Set<string>;
  claimPolls: number;
  /** Access tokens the API refuses. */
  revokedTokens: Set<string>;
}

/** A small fake of the auth.md v0.6 routes. */
function server(state: Server): Route[] {
  return [
    (url) =>
      url.pathname === "/api/agent/identity/challenge"
        ? {
            status: 200,
            body: {
              challenge: "pow1.c.sig",
              algorithm: "sha256-zero-bits",
              difficulty: 2,
              count: 1,
            },
          }
        : undefined,
    (url, init) => {
      if (url.pathname !== "/api/agent/identity") return undefined;
      const body = JSON.parse(String(init.body));
      if (body.type === "service_auth") {
        state.serviceAuth++;
        return {
          status: 200,
          body: {
            registration_id: `svc-${state.serviceAuth}`,
            claim_token: `clm_svc${state.serviceAuth}`,
            claim_token_expires: iso(DAY),
            post_claim_scopes: ["webhooks:read", "webhooks:write"],
            claim: {
              user_code: "654321",
              expires_in: 900,
              verification_uri: `${BASE}/agent/claim?attempt=cat_svc`,
              interval: 1,
            },
          },
        };
      }
      state.registrations++;
      return {
        status: 200,
        body: {
          registration_id: `anon-${state.registrations}`,
          identity_assertion: `assertion-anon-${state.registrations}`,
          assertion_expires: iso(DAY),
          claim_token: `clm_anon${state.registrations}`,
          claim_token_expires: iso(DAY),
          sandbox: { status: "available", endpoints_url: `${BASE}/api/agent/sandbox/endpoints` },
        },
      };
    },
    (url, init) => {
      if (url.pathname !== "/api/agent/identity/claim") return undefined;
      return {
        status: 200,
        body: {
          registration_id: "anon-1",
          claim_attempt: {
            user_code: "123456",
            expires_in: 900,
            verification_uri: `${BASE}/agent/claim?attempt=cat_1`,
            interval: 1,
          },
          sent: JSON.parse(String(init.body)),
        },
      };
    },
    (url, init) => {
      if (url.pathname !== "/api/oauth2/token") return undefined;
      const params = form(init);
      if (params.get("grant_type") === "urn:workos:agent-auth:grant-type:claim") {
        state.claimPolls++;
        return {
          status: 200,
          body: {
            access_token: "whcc_account1",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "webhooks:read webhooks:write",
            identity_assertion: `claimed-${params.get("claim_token")}`,
            assertion_expires: iso(90 * DAY),
          },
        };
      }
      const assertion = params.get("assertion") ?? "";
      if (state.refused.has(assertion)) {
        return { status: 400, body: { error: "invalid_grant", error_description: "Gone." } };
      }
      state.exchanges++;
      return {
        status: 200,
        body: {
          access_token: `whcc_x${state.exchanges}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: assertion.startsWith("claimed-")
            ? "webhooks:read webhooks:write"
            : "webhooks:sandbox",
        },
      };
    },
    (url) =>
      url.pathname === "/api/agent/sandbox/endpoints"
        ? { status: 200, body: { endpoints: [] } }
        : undefined,
    (url) =>
      url.pathname === "/api/endpoints"
        ? { status: 200, body: { owned: [], shared: [] } }
        : undefined,
    (url, init) => {
      if (url.pathname !== "/api/usage") return undefined;
      const auth = new Headers(init.headers).get("authorization") ?? "";
      return state.revokedTokens.has(auth.slice(7))
        ? { status: 401, body: { error: "Invalid token" } }
        : { status: 200, body: { used: 0, limit: 200 } };
    },
  ];
}

let dir: string;
let file: string;
let state: Server;

type Slot = Record<string, string>;
type SavedFile = { issuers: Record<string, { claimed?: Slot; sandbox?: Slot }> };

function readFile(): SavedFile | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whk-connection-"));
  file = join(dir, "agent.json");
  state = {
    registrations: 0,
    exchanges: 0,
    serviceAuth: 0,
    refused: new Set(),
    claimPolls: 0,
    revokedTokens: new Set(),
  };
  mockFetch(...server(state));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("sandbox in the credential file", () => {
  it("saves a new sandbox and reuses it, with its cached token, on the next run", async () => {
    const first = await WebhooksCC.sandbox({
      baseUrl: BASE,
      credentialsFile: file,
      clientName: "unit",
    });
    expect(state.registrations).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = readFile()?.issuers[BASE].sandbox;
    expect(saved).toMatchObject({
      registration_id: "anon-1",
      identity_assertion: "assertion-anon-1",
      client_name: "unit",
      access_token: "whcc_x1",
    });

    const second = await WebhooksCC.sandbox({ baseUrl: `${BASE}/`, credentialsFile: file });
    expect(state.registrations).toBe(1);
    expect(state.exchanges).toBe(1);
    expect(second.registrationId).toBe(first.registrationId);
    expect(second.registration.claimToken).toBeNull();
    await second.endpoints.list();
    expect(state.exchanges).toBe(1);
  });

  it("registers again when the saved sandbox is refused", async () => {
    await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: file });
    // The cached token would hide a refusal; age it out.
    const saved = readFile()!;
    delete saved.issuers[BASE].sandbox!.access_token;
    writeFileSync(file, JSON.stringify(saved));
    state.refused.add("assertion-anon-1");

    const fresh = await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: file });
    expect(state.registrations).toBe(2);
    expect(fresh.registrationId).toBe("anon-2");
    expect(readFile()?.issuers[BASE].sandbox?.registration_id).toBe("anon-2");
  });

  it("keeps nothing on disk with credentialsFile: false", async () => {
    await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: false });
    expect(readFile()).toBeNull();
  });

  it("moves the sandbox on a claim and saves the account connection", async () => {
    const sandbox = await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: file });
    const attempt = await sandbox.claim({ email: " Dev@Example.com " });
    expect(attempt).toMatchObject({ userCode: "123456", movesEndpoints: true });
    const client = await sandbox.waitForClaim({ timeout: 5_000 });
    const issuer = readFile()!.issuers[BASE];
    expect(issuer.sandbox).toBeUndefined();
    expect(issuer.claimed).toMatchObject({
      registration_id: "anon-1",
      identity_assertion: "claimed-clm_anon1",
      email: "dev@example.com",
      access_token: "whcc_account1",
    });
    await client.endpoints.list();
    await expect(sandbox.endpoints.list()).rejects.toMatchObject({ code: "sandbox_closed" });
  });

  it("connects through service_auth when the sandbox came from the file", async () => {
    await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: file });
    const loaded = await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: file });
    const attempt = await loaded.claim({ email: "dev@example.com" });
    expect(attempt).toMatchObject({ userCode: "654321", movesEndpoints: false });
    expect(state.serviceAuth).toBe(1);

    await loaded.waitForClaim({ timeout: 5_000 });
    const issuer = readFile()!.issuers[BASE];
    expect(issuer.claimed?.registration_id).toBe("svc-1");
    expect(issuer.sandbox?.registration_id).toBe("anon-1");
    await loaded.endpoints.list();
  });
});

describe("WebhooksCC.connected", () => {
  it("is null without a connection", async () => {
    expect(await WebhooksCC.connected({ baseUrl: BASE, credentialsFile: file })).toBeNull();
  });

  it("returns the saved account, and forgets one the human removed", async () => {
    const pending = await WebhooksCC.connect({
      baseUrl: BASE,
      credentialsFile: file,
      email: "dev@example.com",
    });
    expect(pending.userCode).toBe("654321");
    await pending.wait({ timeout: 5_000 });

    const client = await WebhooksCC.connected({ baseUrl: BASE, credentialsFile: file });
    expect(client).toBeInstanceOf(WebhooksCC);
    // The cached token from the claim is still good: no exchange needed.
    expect(state.exchanges).toBe(0);

    // The human disconnects the agent: its tokens die and the assertion is refused.
    state.revokedTokens.add("whcc_account1");
    state.refused.add("claimed-clm_svc1");
    const onRevoked = vi.fn();
    expect(
      await WebhooksCC.connected({ baseUrl: BASE, credentialsFile: file, onRevoked })
    ).toBeNull();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(readFile()).toBeNull();
  });

  it("never serialises the claim token", async () => {
    const pending = await WebhooksCC.connect({
      baseUrl: BASE,
      credentialsFile: file,
      email: "dev@example.com",
    });
    expect(JSON.stringify(pending)).not.toContain("clm_");
    expect(JSON.stringify(pending)).toContain("654321");
    const sandbox = await WebhooksCC.sandbox({ baseUrl: BASE, credentialsFile: file });
    expect(JSON.stringify(sandbox)).not.toMatch(/clm_|whcc_|assertion/);
  });

  it("reports a revoked connection once, and keeps a newer one another process saved", async () => {
    const pending = await WebhooksCC.connect({
      baseUrl: BASE,
      credentialsFile: file,
      email: "dev@example.com",
    });
    await pending.wait({ timeout: 5_000 });
    const onRevoked = vi.fn();
    const client = WebhooksCC.fromSavedConnection({
      baseUrl: BASE,
      credentialsFile: file,
      onRevoked,
    })!;

    // Another process connects again: a new registration in the slot.
    const saved = readFile()!;
    saved.issuers[BASE].claimed = { ...saved.issuers[BASE].claimed!, registration_id: "svc-new" };
    writeFileSync(file, JSON.stringify(saved));
    state.revokedTokens.add("whcc_account1");
    state.refused.add("claimed-clm_svc1");

    await expect(client.usage()).rejects.toThrow();
    await expect(client.usage()).rejects.toThrow();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(readFile()!.issuers[BASE].claimed?.registration_id).toBe("svc-new");
  });
});
