// Pin the app URL BEFORE importing anything that calls publicEnv(). publicEnv()
// is lazy-evaluated and memoized on first call, reading process.env at that
// point, so these assignments must precede the import below.
//
// The metadata builders under test only read NEXT_PUBLIC_APP_URL, but
// publicEnv() validates the FULL public schema on first access. The unit
// config loads no .env, so we provide the remaining required public vars here
// with deterministic dummies (unused by the builders) to keep this a pure,
// no-DB / no-network shape test.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { describe, expect, test } from "vitest";

// PURE builders only. We deliberately do NOT import the route handlers or any
// DB/email lib: those pull in the admin client and secret-only env (e.g.
// SUPABASE_SERVICE_ROLE_KEY) which may be unset in CI. This is the CI-protected
// shape test: it must run with no DB and no network.
import {
  buildAuthMd,
  buildAuthMdUrl,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "@/lib/agent/metadata";

const APP_URL = "https://webhooks.cc";

describe("agent auth.md: Protected Resource Metadata (RFC 9728)", () => {
  const prm = buildProtectedResourceMetadata();

  test("resource is the protected API audience", () => {
    expect(prm.resource).toBe(`${APP_URL}/api/`);
  });

  test("points agents at /auth.md for documentation", () => {
    expect(prm.resource_documentation).toBe(`${APP_URL}/auth.md`);
  });

  test("points at this app as its authorization server (matches the AS issuer)", () => {
    // Must equal buildAuthorizationServerMetadata().issuer (no trailing slash).
    expect(prm.authorization_servers).toEqual([APP_URL]);
  });

  test("advertises the sandbox and account scopes", () => {
    expect(prm.scopes_supported).toEqual(["webhooks:sandbox", "webhooks:read", "webhooks:write"]);
  });

  test("names the service and its logo for consent screens", () => {
    expect(prm.resource_name).toBe("webhooks.cc");
    expect(prm.resource_logo_uri).toBe(`${APP_URL}/icon-512.png`);
  });

  test("bearer credential travels in the Authorization header", () => {
    expect(prm.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("agent auth.md: Authorization Server Metadata", () => {
  const as = buildAuthorizationServerMetadata({ idJagEnabled: false });

  test("pins the v0.6 discovery document", () => {
    expect(as).toEqual({
      resource: `${APP_URL}/api/`,
      authorization_servers: [APP_URL],
      scopes_supported: ["webhooks:sandbox", "webhooks:read", "webhooks:write"],
      bearer_methods_supported: ["header"],
      issuer: APP_URL,
      token_endpoint: `${APP_URL}/api/oauth2/token`,
      revocation_endpoint: `${APP_URL}/api/oauth2/revoke`,
      jwks_uri: `${APP_URL}/.well-known/jwks.json`,
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
      service_documentation: `${APP_URL}/auth.md`,
      agent_auth: {
        skill: `${APP_URL}/auth.md`,
        identity_endpoint: `${APP_URL}/api/agent/identity`,
        claim_endpoint: `${APP_URL}/api/agent/identity/claim`,
        identity_types_supported: ["anonymous"],
        anonymous: {
          credential_types_supported: ["access_token"],
          proof_of_work: {
            challenge_endpoint: `${APP_URL}/api/agent/identity/challenge`,
            algorithms_supported: ["sha256-zero-bits"],
          },
          sandbox: {
            endpoints_url: `${APP_URL}/api/agent/sandbox/endpoints`,
            lifetime_seconds: 86400,
            max_endpoints: 3,
            max_requests_per_endpoint: 25,
            max_requests: 100,
          },
        },
        register_uri: `${APP_URL}/api/agent/identity`,
        claim_uri: `${APP_URL}/api/agent/identity/claim`,
      },
    });
  });

  test("does not advertise endpoints that do not exist", () => {
    expect(as).not.toHaveProperty("authorization_endpoint");
    expect(as).not.toHaveProperty("registration_endpoint");
    expect(as.agent_auth).not.toHaveProperty("events_endpoint");
  });

  test("offers identity_assertion only while an issuer is trusted", () => {
    expect(as.agent_auth).not.toHaveProperty("identity_assertion");
    const trusting = buildAuthorizationServerMetadata({ idJagEnabled: true });
    expect(trusting.agent_auth.identity_types_supported).toEqual([
      "anonymous",
      "identity_assertion",
    ]);
    expect(trusting.agent_auth.identity_assertion).toEqual({
      assertion_types_supported: ["urn:ietf:params:oauth:token-type:id-jag"],
    });
  });
});

describe("agent auth.md: proactive discovery pointers", () => {
  test("buildAuthMdUrl points at the hosted /auth.md on the app URL", () => {
    // Backs the root <head> <link rel="auth.md"> so probing agents can find the
    // doc without first hitting a 401 (RFC 9728) or reading the well-known docs.
    expect(buildAuthMdUrl()).toBe(`${APP_URL}/auth.md`);
    expect(new URL(buildAuthMdUrl()).origin).toBe(APP_URL);
  });

  test("the head link target matches the authorization server skill pointer", () => {
    const as = buildAuthorizationServerMetadata({ idJagEnabled: false });
    expect(buildAuthMdUrl()).toBe(as.agent_auth.skill);
  });
});

describe("agent auth.md: hosted /auth.md document", () => {
  const md = buildAuthMd({ idJagEnabled: false });
  const as = buildAuthorizationServerMetadata({ idJagEnabled: false });

  test("follows the auth.md steps", () => {
    for (const step of [
      "## Step 1: Discover",
      "## Step 2: Pick a method",
      "## Step 3: Register",
      "## Step 4: Claim ceremony",
      "## Step 5: Exchange the assertion",
      "## Step 6: Use the access token",
    ]) {
      expect(md).toContain(step);
    }
  });

  test("names every endpoint the discovery document advertises", () => {
    for (const url of [
      as.token_endpoint,
      as.revocation_endpoint,
      as.agent_auth.identity_endpoint,
      as.agent_auth.claim_endpoint,
      as.agent_auth.anonymous.proof_of_work.challenge_endpoint,
      as.agent_auth.anonymous.sandbox.endpoints_url,
    ]) {
      expect(md).toContain(url);
    }
  });

  test("states the lifetimes and limits", () => {
    expect(md).toContain(
      "| Unclaimed registration, its identity assertion and its sandbox | 24 hours |"
    );
    expect(md).toContain("| Access token | 60 minutes");
    expect(md).toContain("25 per endpoint, 100 per registration");
  });

  test("writes discovery URLs as plain links, not code spans", () => {
    // A scanner once requested `/.well-known/oauth-protected-resource%60`.
    expect(md).toContain(
      `- Protected Resource Metadata: ${APP_URL}/.well-known/oauth-protected-resource\n`
    );
    expect(md).not.toContain("`" + APP_URL + "/.well-known/");
  });

  test("documents the proof of work with working solvers", () => {
    expect(md).toContain("sha256-zero-bits");
    expect(md).toContain("<challenge>.<i>.<nonce>");
    expect(md).toContain("def solve(challenge: str, difficulty: int, count: int)");
    expect(md).toContain('import { createHash } from "node:crypto";');
  });

  test("says ID-JAG has no trusted issuer unless one is configured", () => {
    expect(md).toContain("`issuer_not_enabled`");
    expect(buildAuthMd({ idJagEnabled: true })).toContain(
      "accepted from the issuers this deployment trusts"
    );
  });

  test("points old clients at the 410", () => {
    expect(md).toContain("endpoint_moved");
  });

  test("contains no em dashes", () => {
    expect(md).not.toContain("\u2014");
  });
});
