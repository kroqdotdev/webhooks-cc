import { beforeEach, describe, expect, it, vi } from "vitest";
import { openBeginTicket, openState, sealBeginTicket, sealState } from "./google";

beforeEach(() => {
  vi.stubEnv("SIGNING_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
});

const CONSENT = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y";

describe("the begin ticket for a connection started on mailhooks.cc", () => {
  it("carries the consent URL and the nonce for two minutes", () => {
    const now = Date.now();
    const ticket = sealBeginTicket(CONSENT, "nonce-1", "hash-1", now);
    expect(openBeginTicket(ticket, now + 60_000)).toEqual({
      url: CONSENT,
      browserNonce: "nonce-1",
      handoff: "hash-1",
    });
    expect(openBeginTicket(ticket, now + 121_000)).toBeNull();
  });

  it("only ever leads to Google's consent page", () => {
    expect(openBeginTicket(sealBeginTicket("https://evil.example/auth", "n", "h"))).toBeNull();
  });

  it("is refused when tampered with, and is never a state (nor a state a ticket)", () => {
    const ticket = sealBeginTicket(CONSENT, "n", "h");
    const tampered = `${ticket.slice(0, -2)}${ticket.endsWith("A") ? "B" : "A"}A`;
    expect(openBeginTicket(tampered)).toBeNull();
    expect(openState(ticket)).toBeNull();
    const state = sealState({
      userId: "u",
      verifier: "v",
      returnTo: "/dashboard",
      expires: Date.now() + 60_000,
      browser: "b",
      site: "mailhooks",
    });
    expect(openBeginTicket(state)).toBeNull();
    expect(openState(state)?.site).toBe("mailhooks");
  });
});

describe("the handoff on mailhooks.cc", () => {
  it("goes on to Google only for the browser holding the handoff cookie", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    const { handoffHash } = await import("./google");
    const { GET } = await import("@/app/api/integrations/google/handoff/route");
    const ticket = sealBeginTicket(CONSENT, "n", handoffHash("mine"));
    const at = (cookie?: string) =>
      GET(
        new Request(
          `https://mailhooks.cc/api/integrations/google/handoff?ticket=${encodeURIComponent(ticket)}`,
          cookie ? { headers: { cookie } } : undefined
        )
      );
    expect((await at("whcc_google_handoff=mine")).headers.get("location")).toBe(CONSENT);
    for (const response of [await at(), await at("whcc_google_handoff=someone-else")]) {
      expect(response.headers.get("location")).toBe(
        "https://mailhooks.cc/dashboard?google=expired"
      );
    }
  });
});
