import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhooksCC } from "../client";
import {
  registerAnonymous,
  registerWithEmail,
  confirmEmailOtp,
  registerWithIdJag,
  pollClaim,
  describeRegistration,
  AgentRegisterError,
} from "../register";

const BASE_URL = "https://test.webhooks.cc";

function mockJson(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

describe("agent registration on-ramp", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("registerAnonymous returns credential + claim code, posting to /api/agent/auth", async () => {
    const fetchMock = mockJson(200, {
      registration_id: "reg-1",
      credential: "whcc_anon",
      scopes: ["webhooks:read"],
      claim_url: `${BASE_URL}/agent/claim`,
      claim_token: "clm_abc",
      user_code: "ABCD-EFGH",
      claim_token_expires: "2026-01-01T00:00:00Z",
      post_claim_scopes: ["webhooks:read"],
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const reg = await registerAnonymous({ baseUrl: BASE_URL, clientName: "agent" });
    expect(reg.credential).toBe("whcc_anon");
    expect(reg.userCode).toBe("ABCD-EFGH");
    expect(reg.claimToken).toBe("clm_abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agent/auth`);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.type).toBe("anonymous");
    expect(sent.requested_credential_type).toBe("api_key");
    expect(sent.client_name).toBe("agent");
  });

  it("throws AgentRegisterError with the auth.md code on non-200", async () => {
    globalThis.fetch = mockJson(400, { error: "invalid_email" }) as unknown as typeof globalThis.fetch;
    await expect(registerWithEmail("bad", { baseUrl: BASE_URL })).rejects.toMatchObject({
      name: "AgentRegisterError",
      code: "invalid_email",
      status: 400,
    });
    expect(AgentRegisterError).toBeDefined();
  });

  it("registerWithEmail posts verified_email and returns the claim challenge", async () => {
    const fetchMock = mockJson(200, {
      registration_id: "reg-2",
      claim_token: "clm_email",
      claim_url: `${BASE_URL}/agent/claim`,
      claim_token_expires: "2026-01-01T00:00:00Z",
      post_claim_scopes: ["webhooks:read"],
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const challenge = await registerWithEmail("dev@example.com", { baseUrl: BASE_URL });
    expect(challenge.claimToken).toBe("clm_email");
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.type).toBe("verified_email");
    expect(sent.email).toBe("dev@example.com");
  });

  it("confirmEmailOtp posts to verify-otp and returns the credential", async () => {
    const fetchMock = mockJson(200, { credential: "whcc_email", scopes: [] });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const issued = await confirmEmailOtp(
      { claimToken: "clm_email", otp: "123456" },
      { baseUrl: BASE_URL }
    );
    expect(issued.credential).toBe("whcc_email");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/agent/auth/claim/verify-otp`);
  });

  it("registerWithIdJag posts the id-jag assertion type", async () => {
    const fetchMock = mockJson(200, { credential: "whcc_idjag", scopes: [] });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const issued = await registerWithIdJag("eyJ...", { baseUrl: BASE_URL });
    expect(issued.credential).toBe("whcc_idjag");
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.assertion_type).toBe("urn:ietf:params:oauth:token-type:id-jag");
  });

  it("pollClaim maps terminal statuses without throwing", async () => {
    globalThis.fetch = mockJson(200, { status: "pending", user_code: "ABCD-EFGH" }) as unknown as typeof globalThis.fetch;
    expect(await pollClaim("clm_x", { baseUrl: BASE_URL })).toEqual({
      status: "pending",
      userCode: "ABCD-EFGH",
    });

    globalThis.fetch = mockJson(409, { error: "previously_claimed" }) as unknown as typeof globalThis.fetch;
    expect((await pollClaim("clm_x", { baseUrl: BASE_URL })).status).toBe("previously_claimed");

    globalThis.fetch = mockJson(410, { error: "claim_expired" }) as unknown as typeof globalThis.fetch;
    expect((await pollClaim("clm_x", { baseUrl: BASE_URL })).status).toBe("expired");
  });

  it("exposes static register helpers and registration discovery on WebhooksCC", () => {
    expect(typeof WebhooksCC.register.anonymous).toBe("function");
    expect(typeof WebhooksCC.register.withEmail).toBe("function");
    expect(typeof WebhooksCC.register.withIdJag).toBe("function");
    expect(typeof WebhooksCC.register.pollClaim).toBe("function");

    const desc = WebhooksCC.describeRegistration(BASE_URL);
    expect(desc.protocol).toBe("auth.md");
    expect(desc.documentation).toBe(`${BASE_URL}/auth.md`);
    expect(Object.keys(desc.flows)).toEqual(
      expect.arrayContaining(["anonymous", "verified_email", "identity_assertion"])
    );
  });

  it("describeRegistration is also a standalone export", () => {
    const d = describeRegistration(BASE_URL);
    expect(d.flows.anonymous.method).toContain("/api/agent/auth");
  });

  it("instance describe() includes the registration on-ramp block", () => {
    const client = new WebhooksCC({ apiKey: "whcc_test", baseUrl: BASE_URL });
    const described = client.describe();
    expect(described.registration).toBeDefined();
    expect(described.registration.params.anonymous).toContain("anonymous");
  });
});
