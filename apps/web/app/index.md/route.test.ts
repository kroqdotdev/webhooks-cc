// publicEnv() validates the whole public schema on first use and is
// memoized, so pin the app URL and give the other required values dummies.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /index.md (the home page as markdown)", () => {
  it("serves a markdown overview that links the agent entry points", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body).toMatch(/^---\ntitle: /);
    expect(body).toContain("\n# webhooks.cc\n");
    for (const url of [
      "https://webhooks.cc/auth.md",
      "https://webhooks.cc/llms.txt",
      "https://webhooks.cc/docs",
      "https://webhooks.cc/mcp",
      "https://webhooks.cc/openapi.yaml",
      "https://webhooks.cc/.well-known/api-catalog",
      "https://webhooks.cc/.well-known/agent-skills/index.json",
    ]) {
      expect(body).toContain(url);
    }
  });
});
