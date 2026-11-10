import { beforeEach, describe, expect, it, vi } from "vitest";

const env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

const { passedTurnstile, turnstileMissingInProduction, turnstileSiteKey } =
  await import("./turnstile");

function answer(success: boolean): typeof fetch {
  return vi.fn(async () => Response.json({ success })) as unknown as typeof fetch;
}

describe("turnstile", () => {
  beforeEach(() => {
    delete env.TURNSTILE_SITE_KEY;
    delete env.TURNSTILE_SECRET_KEY;
  });

  it("is off without both keys: no site key, every form passes", async () => {
    env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(turnstileSiteKey()).toBeNull();
    const fetcher = answer(false);
    expect(await passedTurnstile(null, "203.0.113.5", fetcher)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks Cloudflare with the secret, the token and the address", async () => {
    // Cloudflare's documented test keys: this pair always passes.
    env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
    expect(turnstileSiteKey()).toBe("1x00000000000000000000AA");
    const fetcher = answer(true);
    expect(await passedTurnstile("token-1", "203.0.113.5", fetcher)).toBe(true);
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("secret")).toBe("1x0000000000000000000000000000000AA");
    expect(body.get("response")).toBe("token-1");
    expect(body.get("remoteip")).toBe("203.0.113.5");
  });

  it("fails without a token, on a refusal, and when Cloudflare cannot be reached", async () => {
    env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    env.TURNSTILE_SECRET_KEY = "2x0000000000000000000000000000000AA";
    expect(await passedTurnstile(null, null, answer(true))).toBe(false);
    expect(await passedTurnstile("token", null, answer(false))).toBe(false);
    const broken = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await passedTurnstile("token", null, broken)).toBe(false);
  });

  it("counts as missing only in production, and only without both keys", () => {
    expect(turnstileMissingInProduction("development")).toBe(false);
    expect(turnstileMissingInProduction("test")).toBe(false);
    expect(turnstileMissingInProduction("production")).toBe(true);
    env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(turnstileMissingInProduction("production")).toBe(true);
    env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
    expect(turnstileMissingInProduction("production")).toBe(false);
  });
});
