// publicEnv() validates the whole public schema on first use and is
// memoized, so pin the app URL and give the other required values dummies.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { describe, expect, it } from "vitest";
import { GET, generateStaticParams } from "./route";

function get(slug?: string[]) {
  return GET(new Request("https://webhooks.cc/docs.md"), { params: Promise.resolve({ slug }) });
}

describe("GET /docs.md/[[...slug]] (markdown twins of the docs)", () => {
  it("serves a docs page as markdown", async () => {
    const response = await get(["agents"]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("canonical: https://webhooks.cc/docs/agents\n");
    expect(body).toMatch(/\n# .+\n/);
  });

  it("serves nested pages and the docs root", async () => {
    expect((await get(["sdk", "api"])).status).toBe(200);
    const root = await get(undefined);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("## All documentation pages");
  });

  it("answers 404 for a page that does not exist", async () => {
    const response = await get(["no-such-page"]);
    expect(response.status).toBe(404);
  });

  it("prerenders one twin per docs page, the root included", async () => {
    const params = await generateStaticParams();
    expect(params).toContainEqual({ slug: [] });
    expect(params).toContainEqual({ slug: ["agents"] });
    expect(params).toContainEqual({ slug: ["sdk", "api"] });
  });
});
