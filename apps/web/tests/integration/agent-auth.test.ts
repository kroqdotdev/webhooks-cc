/**
 * @fileoverview The auth.md v0.1 routes after the v0.6 move: anonymous and
 * ID-JAG registration, the claim poll, the claim confirmation and provider
 * revocation answer 410 with a pointer to /auth.md; the verified_email OTP
 * flow keeps working until its sunset.
 *
 * Needs the local Supabase stack. Run with:
 *   cd apps/web && npx vitest run --config vitest.config.ts tests/integration/agent-auth.test.ts
 *
 * The OTP is read from the dev email transport (RESEND_API_KEY unset and a
 * non-production NODE_ENV), so nothing is delivered.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, APP, configureAgentEnv, jsonPost, sha256Hex } from "./agent-helpers";

delete process.env.RESEND_API_KEY;
configureAgentEnv();

const admin = adminClient();
const OTP_EMAIL = `otp-user-${Date.now()}@webhooks-test.local`;

type Handler = (request: Request) => Promise<Response>;
let registerPost: Handler;
let pollPost: () => Promise<Response>;
let confirmPost: () => Promise<Response>;
let revokePost: () => Promise<Response>;
let verifyOtpPost: Handler;
let endpointsGet: Handler;
let getLastOtpForEmail: (email: string) => string | null;
let resetEmailStore: () => void;

const claimTokenHashes = new Set<string>();
const apiKeyHashes = new Set<string>();

async function expectMoved(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ error: "endpoint_moved", auth_md: `${APP}/auth.md` });
  expect(typeof body.error_description).toBe("string");
}

describe("auth.md v0.1 routes", () => {
  beforeAll(async () => {
    const [register, poll, confirm, revoke, verifyOtp, endpoints, devTransport] = await Promise.all(
      [
        import("@/app/api/agent/auth/route"),
        import("@/app/api/agent/auth/claim/route"),
        import("@/app/api/agent/auth/claim/confirm/route"),
        import("@/app/api/agent/auth/revoke/route"),
        import("@/app/api/agent/auth/claim/verify-otp/route"),
        import("@/app/api/endpoints/route"),
        import("@/lib/email/dev-transport"),
      ]
    );
    registerPost = register.POST;
    pollPost = poll.POST;
    confirmPost = confirm.POST;
    revokePost = revoke.POST;
    verifyOtpPost = verifyOtp.POST;
    endpointsGet = endpoints.GET;
    getLastOtpForEmail = devTransport.getLastOtpForEmail;
    resetEmailStore = devTransport.__resetEmailTestStore;
  });

  afterAll(async () => {
    if (apiKeyHashes.size > 0) {
      await admin
        .from("api_keys")
        .delete()
        .in("key_hash", [...apiKeyHashes]);
    }
    if (claimTokenHashes.size > 0) {
      await admin
        .from("agent_claims")
        .delete()
        .in("claim_token_hash", [...claimTokenHashes]);
    }
    const { data: user } = await admin
      .from("users")
      .select("id")
      .eq("email", OTP_EMAIL)
      .maybeSingle();
    if (user) await admin.auth.admin.deleteUser(user.id).catch(() => {});
  });

  it("anonymous and ID-JAG registration moved to /api/agent/identity", async () => {
    await expectMoved(
      await registerPost(
        jsonPost("/api/agent/auth", { type: "anonymous", requested_credential_type: "api_key" })
      )
    );
    await expectMoved(
      await registerPost(
        jsonPost("/api/agent/auth", {
          identity_type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion: "eyJ.x.y",
        })
      )
    );
    await expectMoved(
      await registerPost(
        new Request(`${APP}/api/agent/auth`, {
          method: "POST",
          headers: { "content-type": "application/jwt" },
          body: "eyJ.x.y",
        })
      )
    );
    const unknown = await registerPost(jsonPost("/api/agent/auth", { type: "magic" }));
    expect(unknown.status).toBe(400);
  });

  it("the poll, the confirmation and provider revocation answer 410", async () => {
    await expectMoved(await pollPost());
    await expectMoved(await confirmPost());
    await expectMoved(await revokePost());
  });

  it("verified_email: issues an OTP, withholds the credential until confirmed", async () => {
    resetEmailStore();
    const reg = await registerPost(
      jsonPost("/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "verified_email",
        assertion: OTP_EMAIL,
        client_name: "otp-test-agent",
      })
    );
    expect(reg.status).toBe(200);
    // Deprecated until its sunset (RFC 9745, RFC 8594).
    expect(reg.headers.get("deprecation")).toMatch(/^@\d+$/);
    expect(reg.headers.get("sunset")).toBe("Mon, 30 Nov 2026 00:00:00 GMT");
    const regBody = await reg.json();
    expect(regBody.claim_token).toMatch(/^clm_/);
    expect(regBody.credential).toBeUndefined();
    claimTokenHashes.add(sha256Hex(regBody.claim_token));

    const otp = getLastOtpForEmail(OTP_EMAIL);
    expect(otp).toMatch(/^\d{6}$/);

    const wrong = await verifyOtpPost(
      jsonPost("/api/agent/auth/claim/verify-otp", {
        claim_token: regBody.claim_token,
        otp: otp === "000000" ? "111111" : "000000",
      })
    );
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe("otp_invalid");

    const right = await verifyOtpPost(
      jsonPost("/api/agent/auth/claim/verify-otp", { claim_token: regBody.claim_token, otp: otp! })
    );
    expect(right.status).toBe(200);
    expect(right.headers.get("sunset")).toBe("Mon, 30 Nov 2026 00:00:00 GMT");
    const rightBody = await right.json();
    expect(rightBody.credential).toMatch(/^whcc_/);
    apiKeyHashes.add(sha256Hex(rightBody.credential));

    const works = await endpointsGet(
      new Request(`${APP}/api/endpoints`, {
        headers: { authorization: `Bearer ${rightBody.credential}` },
      })
    );
    expect(works.status).toBe(200);
  });

  it("verified_email: locks after max attempts -> otp_expired", async () => {
    resetEmailStore();
    const reg = await registerPost(
      jsonPost("/api/agent/auth", { type: "verified_email", assertion: OTP_EMAIL })
    );
    expect(reg.status).toBe(200);
    const claimToken: string = (await reg.json()).claim_token;
    claimTokenHashes.add(sha256Hex(claimToken));

    const realOtp = getLastOtpForEmail(OTP_EMAIL)!;
    const wrongOtp = realOtp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      const res = await verifyOtpPost(
        jsonPost("/api/agent/auth/claim/verify-otp", { claim_token: claimToken, otp: wrongOtp })
      );
      expect(res.status).toBe(401);
    }
    const locked = await verifyOtpPost(
      jsonPost("/api/agent/auth/claim/verify-otp", { claim_token: claimToken, otp: realOtp })
    );
    expect(locked.status).toBe(410);
    expect((await locked.json()).error).toBe("otp_expired");
  });

  it("verified_email refuses capture-domain addresses", async () => {
    const res = await registerPost(
      jsonPost("/api/agent/auth", { type: "verified_email", email: "someone@mailhooks.cc" })
    );
    expect(res.status).toBe(400);
    // Refusals carry the deprecation headers too.
    expect(res.headers.get("sunset")).toBe("Mon, 30 Nov 2026 00:00:00 GMT");
    expect((await res.json()).error).toBe("invalid_email");
  });
});
