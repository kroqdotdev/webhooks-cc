// publicEnv() validates the whole public schema on first use and is
// memoized, so pin the app URL and give the other required values dummies.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { describe, expect, it } from "vitest";
import { GET, HEAD } from "./route";

const APP = "https://webhooks.cc";
const PROFILE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

type Target = { href: string; type?: string };
type Context = { anchor: string } & Record<string, Target[] | string>;

async function linkset(): Promise<Context[]> {
  const body = await (await GET()).json();
  return body.linkset;
}

function context(contexts: Context[], anchor: string): Context {
  const found = contexts.find((c) => c.anchor === anchor);
  expect(found, `link context ${anchor}`).toBeDefined();
  return found!;
}

function hrefs(ctx: Context, relation: string): string[] {
  return ((ctx[relation] as Target[] | undefined) ?? []).map((target) => target.href);
}

describe("/.well-known/api-catalog (RFC 9727)", () => {
  it("answers GET with a linkset carrying the RFC 9727 profile", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(PROFILE);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("link")).toBe(
      `<${APP}/.well-known/api-catalog>; rel="api-catalog"`
    );
  });

  it("answers HEAD with the api-catalog relation and no body", async () => {
    const response = await HEAD();

    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toContain('rel="api-catalog"');
    expect(response.headers.get("content-type")).toBe(PROFILE);
    expect(response.body).toBeNull();
  });

  it("lists the REST API and the remote MCP server as items", async () => {
    const catalog = context(await linkset(), `${APP}/.well-known/api-catalog`);
    expect(hrefs(catalog, "item")).toEqual([`${APP}/api/`, `${APP}/mcp`]);
  });

  it("describes the REST API with its OpenAPI file, docs and discovery documents", async () => {
    const api = context(await linkset(), `${APP}/api/`);

    expect(api["service-desc"]).toEqual([
      expect.objectContaining({ href: `${APP}/openapi.yaml`, type: "application/yaml" }),
    ]);
    expect(hrefs(api, "service-doc")).toContain(`${APP}/docs/api`);
    expect(hrefs(api, "service-meta")).toEqual([`${APP}/.well-known/oauth-protected-resource`]);
    expect(hrefs(api, "describedby")).toEqual([`${APP}/llms.txt`]);
    expect(hrefs(api, "auth.md")).toEqual([`${APP}/auth.md`]);
    expect(hrefs(api, "agent-skills")).toEqual([`${APP}/.well-known/agent-skills/index.json`]);
  });

  it("points the MCP server at its docs and protected resource metadata", async () => {
    const mcp = context(await linkset(), `${APP}/mcp`);

    expect(hrefs(mcp, "service-doc")).toEqual([`${APP}/docs/mcp`]);
    expect(hrefs(mcp, "service-meta")).toEqual([`${APP}/.well-known/oauth-protected-resource/mcp`]);
  });

  it("writes every relation as an array of target objects (RFC 9264 section 4.2)", async () => {
    for (const ctx of await linkset()) {
      for (const [relation, value] of Object.entries(ctx)) {
        if (relation === "anchor") continue;
        expect(Array.isArray(value), relation).toBe(true);
        for (const target of value as Target[]) expect(target.href).toMatch(/^https:\/\//);
      }
    }
  });
});
