import { verifyStandardWebhookSignature } from "@webhooks-cc/sdk";
import { describe, expect, it } from "vitest";
import { forwardHeaders, forwardMessageId, generateForwardSecret, signForward } from "./sign";

describe("forward signing", () => {
  it("makes whsec_ secrets of 24 random bytes", () => {
    const secret = generateForwardSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(24);
    expect(generateForwardSecret()).not.toBe(secret);
  });

  it("uses one message id per email, without dashes", () => {
    expect(forwardMessageId("0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b")).toBe(
      "msg_0b9e5f3a6c1d4f7e9a2b3c4d5e6f7a8b"
    );
  });

  it("signs exactly what the SDK's Standard Webhooks verifier checks", async () => {
    const secret = generateForwardSecret();
    const body = JSON.stringify({ type: "email.received", data: { subject: "Hi" } });
    const headers = forwardHeaders(secret, "0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b", body);
    expect(headers).toMatchObject({
      "content-type": "application/json",
      "webhook-id": "msg_0b9e5f3a6c1d4f7e9a2b3c4d5e6f7a8b",
    });
    expect(await verifyStandardWebhookSignature(body, headers, secret)).toBe(true);
    expect(await verifyStandardWebhookSignature(`${body} `, headers, secret)).toBe(false);
    expect(await verifyStandardWebhookSignature(body, headers, generateForwardSecret())).toBe(
      false
    );
  });

  it("matches the Standard Webhooks reference vector", () => {
    // From github.com/standard-webhooks/standard-webhooks (libraries' test suites).
    expect(
      signForward(
        "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        "msg_p5jXN8AQM9LWM0D4loKWxJek",
        1614265330,
        '{"test": 2432232314}'
      )
    ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });
});
