import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  saveGoogleConnection: vi.fn(),
}));

vi.mock("@/lib/integrations/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/google")>()),
  exchangeCode: mocks.exchangeCode,
  googleConfig: () => ({ clientId: "c", clientSecret: "s" }),
}));
vi.mock("@/lib/supabase/google-connections", () => ({
  saveGoogleConnection: mocks.saveGoogleConnection,
}));
vi.mock("@/lib/audit", () => ({ auditUserAction: vi.fn() }));

import {
  browserHash,
  handoffHash,
  sealFinishTicket,
  sealState,
  type OAuthState,
} from "@/lib/integrations/google";
import { GET as finish } from "./route";
import { GET as callback } from "../callback/route";

const state: OAuthState = {
  userId: "user-1",
  verifier: "verifier",
  returnTo: "/dashboard?endpoint=x",
  expires: Date.now() + 600_000,
  browser: browserHash("callback-nonce"),
  site: "mailhooks",
  handoff: handoffHash("mine"),
};

beforeEach(() => {
  vi.stubEnv("SIGNING_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
  vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
  mocks.exchangeCode.mockReset().mockResolvedValue({ email: "me@example.com" });
  mocks.saveGoogleConnection.mockReset().mockResolvedValue({ id: "conn-1" });
});

describe("a Google connection started on mailhooks.cc", () => {
  it("is not saved by webhooks.cc's callback, which hands the code to mailhooks.cc", async () => {
    const response = await callback(
      new Request(
        `https://webhooks.cc/api/integrations/google/callback?code=abc&state=${encodeURIComponent(sealState(state))}`,
        { headers: { cookie: "whcc_google_oauth=callback-nonce" } }
      )
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://mailhooks.cc/api/integrations/google/finish"
    );
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.saveGoogleConnection).not.toHaveBeenCalled();
  });

  it("is saved at the finish only for the browser that started it", async () => {
    const ticket = encodeURIComponent(sealFinishTicket("abc", state));
    const at = (cookie?: string) =>
      finish(
        new Request(
          `https://mailhooks.cc/api/integrations/google/finish?ticket=${ticket}`,
          cookie ? { headers: { cookie } } : undefined
        )
      );

    // Someone else's browser (planted links), or none: nothing is saved.
    for (const response of [await at(), await at("whcc_google_handoff=theirs")]) {
      expect(response.headers.get("location")).toContain("google=expired");
    }
    expect(mocks.saveGoogleConnection).not.toHaveBeenCalled();

    const response = await at("whcc_google_handoff=mine");
    expect(response.headers.get("location")).toBe(
      "https://mailhooks.cc/dashboard?endpoint=x&google=connected"
    );
    expect(mocks.exchangeCode).toHaveBeenCalledWith(expect.anything(), "abc", "verifier");
    expect(mocks.saveGoogleConnection).toHaveBeenCalledWith("user-1", { email: "me@example.com" });
  });
});
