import { describe, expect, it, vi } from "vitest";
import { refusalPhase, runOpen } from "./checkout-page-flow";

describe("refusalPhase", () => {
  it("keeps temporary failures retryable and refuses only the purchase", () => {
    expect(refusalPhase(409, { code: "opening", error: "being prepared" }, "x", "open")).toEqual({
      kind: "failed",
      message: "being prepared",
      retry: "open",
    });
    expect(refusalPhase(429, { code: "rate_limited" }, "x", "review")).toMatchObject({
      kind: "failed",
      retry: "review",
    });
    expect(refusalPhase(503, {}, "x", "open")).toMatchObject({ kind: "failed" });
    expect(refusalPhase(409, { code: "plan_active", error: "has it" }, "x", "open")).toEqual({
      kind: "refused",
      message: "has it",
    });
    expect(refusalPhase(404, {}, "x", "open")).toMatchObject({ kind: "gone" });
    expect(refusalPhase(403, { code: "wrong_account" }, "x", "open")).toMatchObject({
      kind: "wrong_account",
    });
  });
});

describe("runOpen", () => {
  const opening = { ok: false, status: 409, answer: { code: "opening", error: "being prepared" } };
  const redirect = {
    ok: true,
    status: 200,
    answer: { status: "redirect", url: "https://polar.test/c", summary: "Pro" },
  };

  it("asks again once while another tab opens it, then offers Try again", async () => {
    const request = vi.fn().mockResolvedValue(opening);
    const outcome = await runOpen({
      request,
      sleep: async () => {},
      active: () => true,
      failed: "x",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      kind: "refusal",
      phase: { kind: "failed", message: "being prepared", retry: "open" },
    });

    request.mockReset().mockResolvedValueOnce(opening).mockResolvedValueOnce(redirect);
    expect(
      await runOpen({ request, sleep: async () => {}, active: () => true, failed: "x" })
    ).toEqual({ kind: "redirect", summary: "Pro", url: "https://polar.test/c" });
  });

  it("neither redirects nor asks again once the person has left the page", async () => {
    let here = true;
    const request = vi.fn().mockImplementation(async () => {
      here = false; // the person clicked away while the request ran
      return redirect;
    });
    expect(
      await runOpen({ request, sleep: async () => {}, active: () => here, failed: "x" })
    ).toBeNull();

    here = true;
    const sleep = vi.fn().mockImplementation(async () => {
      here = false; // left during the wait before the second try
    });
    request.mockReset().mockResolvedValue(opening);
    expect(await runOpen({ request, sleep, active: () => here, failed: "x" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
