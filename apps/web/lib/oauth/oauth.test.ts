import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.test";
process.env.NEXT_PUBLIC_WEBHOOK_URL = "https://go.webhooks.test";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://supabase.webhooks.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key-for-tests";

const resolveClient = vi.fn();
vi.mock("./clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clients")>();
  return { ...actual, resolveClient: (id: string) => resolveClient(id) };
});

const {
  isMetadataDocumentClientId,
  parseMetadataDocument,
  redirectUriMatches,
  validRedirectUri,
  ClientMetadataError,
} = await import("./clients");
const { checkAuthorizationRequest, redirectWith } = await import("./authorize");
const { s256 } = await import("./tokens");

const APP = "https://webhooks.test";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CHALLENGE = s256("a".repeat(43));

function request(overrides: Record<string, string | null> = {}): URLSearchParams {
  const values: Record<string, string | null> = {
    client_id: CLAUDE,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "st4te",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "webhooks:read webhooks:write",
    resource: `${APP}/mcp`,
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) params.set(key, value);
  }
  return params;
}

describe("redirect URIs", () => {
  it("refuses webhooks.cc's own hosts and protocol handlers", () => {
    expect(validRedirectUri("https://webhooks.test/cb")).toBe(false);
    expect(validRedirectUri("https://go.webhooks.test/w/abc/cb")).toBe(false);
    expect(validRedirectUri("intent://scan/#Intent;end")).toBe(false);
    expect(validRedirectUri("ms-msdt:/id")).toBe(false);
    expect(validRedirectUri("search-ms:query=x")).toBe(false);
    expect(validRedirectUri("com.example.app:/oauth/cb")).toBe(true);
    expect(isMetadataDocumentClientId("https://go.webhooks.test/w/abc/client.json")).toBe(false);
    expect(isMetadataDocumentClientId("https://webhooks.test/client.json")).toBe(false);
  });

  it("accepts https, loopback http and app schemes, and nothing that runs code", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(validRedirectUri("http://localhost/callback")).toBe(true);
    expect(validRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(validRedirectUri("http://example.com/callback")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validRedirectUri("data:text/html,hi")).toBe(false);
    expect(validRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(validRedirectUri("/relative")).toBe(false);
  });

  it("matches exactly, except the port of a loopback http URI", () => {
    const registered = ["http://localhost/callback", "https://app.example/cb"];
    expect(redirectUriMatches(registered, "https://app.example/cb")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost:54321/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost:54321/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://127.0.0.1:54321/callback")).toBe(false);
    expect(redirectUriMatches(registered, "https://app.example/cb/")).toBe(false);
    expect(redirectUriMatches(registered, "https://app.example:8443/cb")).toBe(false);
  });
});

describe("client ID metadata documents", () => {
  it("recognises client_id URLs", () => {
    expect(isMetadataDocumentClientId(CLAUDE)).toBe(true);
    expect(isMetadataDocumentClientId("https://claude.ai/")).toBe(false);
    expect(isMetadataDocumentClientId("http://claude.ai/meta")).toBe(false);
    expect(isMetadataDocumentClientId("https://user:pw@claude.ai/meta")).toBe(false);
    expect(isMetadataDocumentClientId("https://claude.ai/a/../meta")).toBe(false);
    expect(isMetadataDocumentClientId("https://claude.ai/meta#x")).toBe(false);
    expect(isMetadataDocumentClientId("whoc_abc")).toBe(false);
    expect(isMetadataDocumentClientId("https://127.0.0.1/meta")).toBe(false);
    expect(isMetadataDocumentClientId("https://[::1]/meta")).toBe(false);
    expect(isMetadataDocumentClientId("https://app.localhost/meta")).toBe(false);
  });

  it("takes a document that names itself, and identifies the client by its host", () => {
    const client = parseMetadataDocument(
      CLAUDE,
      JSON.stringify({
        client_id: CLAUDE,
        client_name: "Claude",
        client_uri: "https://claude.ai",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      })
    );
    expect(client).toMatchObject({
      name: "Claude",
      verifiedHost: "claude.ai",
      kind: "metadata_document",
    });
  });

  it("refuses documents for another client, with secrets, or without redirect URIs", () => {
    const base = { client_id: CLAUDE, redirect_uris: ["https://claude.ai/cb"] };
    const bad = [
      { ...base, client_id: "https://evil.example/meta" },
      { ...base, client_secret: "x" },
      { ...base, token_endpoint_auth_method: "client_secret_basic" },
      { ...base, redirect_uris: [] },
      { ...base, redirect_uris: ["javascript:alert(1)"] },
    ];
    for (const document of bad) {
      expect(() => parseMetadataDocument(CLAUDE, JSON.stringify(document))).toThrow(
        ClientMetadataError
      );
    }
    expect(() => parseMetadataDocument(CLAUDE, "x".repeat(1024))).toThrow(/larger than/);
  });
});

describe("checkAuthorizationRequest", () => {
  beforeEach(() => {
    resolveClient.mockReset();
    resolveClient.mockResolvedValue({
      clientId: CLAUDE,
      name: "Claude",
      verifiedHost: "claude.ai",
      clientUri: "https://claude.ai",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      kind: "metadata_document",
    });
  });

  it("accepts a well-formed request and grants the account scopes", async () => {
    const check = await checkAuthorizationRequest(request({ scope: "openid webhooks:read" }));
    expect(check).toMatchObject({
      ok: true,
      request: {
        clientId: CLAUDE,
        state: "st4te",
        codeChallenge: CHALLENGE,
        scope: "webhooks:read webhooks:write",
        resource: `${APP}/mcp`,
      },
    });
  });

  it("shows, never redirects, an unknown client or a foreign redirect URI", async () => {
    resolveClient.mockResolvedValueOnce(null);
    expect(await checkAuthorizationRequest(request())).toMatchObject({
      ok: false,
      error: "invalid_client",
    });
    const foreign = await checkAuthorizationRequest(
      request({ redirect_uri: "https://evil.example/cb" })
    );
    expect(foreign).not.toHaveProperty("redirect");
    expect(foreign).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("refuses protocol errors on the page, never by redirect", async () => {
    for (const [overrides, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: null }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://elsewhere.example/" }, "invalid_target"],
    ] as const) {
      const check = await checkAuthorizationRequest(request(overrides));
      expect(check).toMatchObject({ ok: false, error });
      expect(check).not.toHaveProperty("redirect");
    }
  });

  it("treats a repeated parameter as missing", async () => {
    const params = request();
    params.append("client_id", "https://evil.example/meta");
    expect(await checkAuthorizationRequest(params)).toMatchObject({ ok: false });
  });

  it("accepts the API as the resource, with or without a trailing slash", async () => {
    for (const resource of [`${APP}/api/`, `${APP}/api`, `${APP}/mcp/`]) {
      expect((await checkAuthorizationRequest(request({ resource }))).ok).toBe(true);
    }
  });
});

describe("responses", () => {
  it("adds iss to every redirect (RFC 9207)", () => {
    const url = new URL(redirectWith("https://claude.ai/cb?x=1", { code: "whac_1", state: null }));
    expect(url.searchParams.get("x")).toBe("1");
    expect(url.searchParams.get("code")).toBe("whac_1");
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.get("iss")).toBe(APP);
  });

  it("computes S256 as RFC 7636 appendix B does", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });
});
