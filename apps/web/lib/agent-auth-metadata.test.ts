// Pin the app URL BEFORE importing anything that calls publicEnv(). publicEnv()
// is lazy-evaluated and memoized on first call, reading process.env at that
// point — so these assignments must precede the import below.
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
// shape test — it must run with no DB and no network.
import {
  buildAuthMd,
  buildAuthMdUrl,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "@/lib/agent/metadata";

const APP_URL = "https://webhooks.cc";

describe("agent auth.md — Protected Resource Metadata (RFC 9728)", () => {
  const prm = buildProtectedResourceMetadata();

  test("resource is the protected API audience", () => {
    expect(prm.resource).toBe(`${APP_URL}/api/`);
  });

  test("advertises a human-readable resource name/documentation", () => {
    // The PRM must carry a resource_name or resource_documentation so agents
    // can identify the service. We accept either field being present.
    const named =
      ("resource_name" in prm &&
        typeof (prm as Record<string, unknown>).resource_name === "string" &&
        ((prm as Record<string, unknown>).resource_name as string).length > 0) ||
      (typeof prm.resource_documentation === "string" && prm.resource_documentation.length > 0);
    expect(named).toBe(true);
  });

  test("points at this app as its authorization server (matches the AS issuer)", () => {
    // Must equal buildAuthorizationServerMetadata().issuer (no trailing slash).
    expect(prm.authorization_servers).toEqual([APP_URL]);
  });

  test("advertises advisory scopes", () => {
    expect(prm.scopes_supported).toContain("webhooks:read");
    expect(prm.scopes_supported).toContain("webhooks:write");
  });

  test("bearer credential travels in the Authorization header", () => {
    expect(prm.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("agent auth.md — Authorization Server Metadata", () => {
  const as = buildAuthorizationServerMetadata();

  test("agent_auth.skill points at the hosted auth.md", () => {
    expect(as.agent_auth.skill).toBe(`${APP_URL}/auth.md`);
  });

  test("register/claim/revocation URIs are absolute under the app URL", () => {
    for (const uri of [
      as.agent_auth.register_uri,
      as.agent_auth.claim_uri,
      as.agent_auth.revocation_uri,
    ]) {
      expect(typeof uri).toBe("string");
      expect(uri.startsWith(`${APP_URL}/`)).toBe(true);
      // Must be a parseable absolute URL on the canonical origin.
      expect(new URL(uri).origin).toBe(APP_URL);
    }
  });

  test("identity_types_supported lists all three supported flows", () => {
    expect(as.agent_auth.identity_types_supported).toEqual([
      "anonymous",
      "verified_email",
      "identity_assertion",
    ]);
  });

  test("identity_assertion advertises only the ID-JAG assertion type", () => {
    // verified_email is an identity TYPE, not an assertion token format, so it
    // belongs in identity_types_supported (asserted below) — not here.
    expect(as.agent_auth.identity_assertion.assertion_types_supported).toEqual([
      "urn:ietf:params:oauth:token-type:id-jag",
    ]);
  });

  test("identity_types_supported still includes verified_email", () => {
    expect(as.agent_auth.identity_types_supported).toContain("verified_email");
  });

  test("anonymous flow advertises the api_key credential", () => {
    expect(as.agent_auth.anonymous.credential_types_supported).toContain("api_key");
  });

  test("events_supported is a non-empty array carrying the revoked event schema", () => {
    expect(Array.isArray(as.agent_auth.events_supported)).toBe(true);
    expect(as.agent_auth.events_supported.length).toBeGreaterThan(0);

    const revokedSchemaUri = `${APP_URL}/.well-known/agent-events/revoked`;
    const hasRevokedSchema = as.agent_auth.events_supported.some((event) => {
      const values = Object.values(event as Record<string, unknown>);
      return values.includes(revokedSchemaUri);
    });
    expect(hasRevokedSchema).toBe(true);
  });
});

describe("agent auth.md — proactive discovery pointers", () => {
  test("buildAuthMdUrl points at the hosted /auth.md on the app URL", () => {
    // Backs the root <head> <link rel="auth.md"> so probing agents can find the
    // doc without first hitting a 401 (RFC 9728) or reading the well-known docs.
    expect(buildAuthMdUrl()).toBe(`${APP_URL}/auth.md`);
    expect(new URL(buildAuthMdUrl()).origin).toBe(APP_URL);
  });

  test("the head link target matches the authorization server skill pointer", () => {
    const as = buildAuthorizationServerMetadata();
    expect(buildAuthMdUrl()).toBe(as.agent_auth.skill);
  });
});

describe("agent auth.md — hosted /auth.md document", () => {
  const md = buildAuthMd();
  const as = buildAuthorizationServerMetadata();

  test("returns a non-empty markdown string", () => {
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });

  test("documents all three registration flows", () => {
    expect(md).toContain("anonymous");
    expect(md).toContain("verified_email");
    expect(md).toContain("identity_assertion");
  });

  test("documents the whcc_ credential prefix", () => {
    expect(md).toContain("whcc_");
  });

  test("documents the in-app claim ceremony path", () => {
    // Either the bare claim path or the full claim_uri must appear.
    const hasClaimPath = md.includes("/agent/claim") || md.includes(as.agent_auth.claim_uri);
    expect(hasClaimPath).toBe(true);
  });

  test("documents the OTP step for the verified_email flow", () => {
    expect(md.toLowerCase()).toContain("otp");
  });

  test("documents the revocation section", () => {
    expect(md.toLowerCase()).toContain("revocation");
    expect(md).toContain(as.agent_auth.revocation_uri);
  });
});
