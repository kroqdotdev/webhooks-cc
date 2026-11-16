// publicEnv() validates the whole public schema on first use and is
// memoized, so pin the app URL and give the other required values dummies.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { describe, expect, it } from "vitest";
import { SHARE_FRAMEWORK_SLUGS } from "@/lib/share-framework-pages";
import { GET } from "./route";

const call = (framework: string) =>
  GET(new Request(`https://webhooks.cc/share/${framework}.md`), {
    params: Promise.resolve({ framework }),
  });

describe("GET /share/<framework>.md (a share guide as markdown)", () => {
  it("serves every guide as markdown", async () => {
    expect(SHARE_FRAMEWORK_SLUGS.length).toBeGreaterThan(0);
    for (const framework of SHARE_FRAMEWORK_SLUGS) {
      const response = await call(framework);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await response.text()).toMatch(/^---\ntitle: /);
    }
  });

  it("answers 404 for a guide that does not exist", async () => {
    const response = await call("no-such-framework");
    expect(response.status).toBe(404);
  });
});
