import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedOgImagePath } from "@/lib/seo";
import { existsOnWebhooks, servedOnMailhooks } from "@/lib/site";
import { TOOLS, TOOL_SLUGS, getTool, requireTool, toolPath, toolsLastModified } from "./catalog";
import { toolConnectSources } from "./csp";
import { documentLoadedAs } from "./own-document";

describe("the tools catalogue", () => {
  it("names a page that exists for every tool, and nothing twice", () => {
    expect(new Set(TOOL_SLUGS).size).toBe(TOOLS.length);
    for (const tool of TOOLS) {
      const page = join(__dirname, "../../app/tools", tool.slug, "page.tsx");
      expect(existsSync(page), tool.slug).toBe(true);
      expect(tool.updated, tool.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(getTool(tool.slug)).toBe(tool);
    }
    expect(getTool("no-such-tool")).toBeNull();
    expect(() => requireTool("no-such-tool")).toThrow();
    expect(toolsLastModified().toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it("keeps titles and descriptions to what a search result shows", () => {
    for (const tool of TOOLS) {
      expect(tool.title.length, tool.slug).toBeLessThanOrEqual(70);
      expect(tool.description.length, tool.slug).toBeLessThanOrEqual(220);
      // No em dashes anywhere (AGENTS.md).
      expect(`${tool.title}${tool.description}${tool.summary}`).not.toContain(
        String.fromCharCode(0x2014)
      );
    }
  });

  it("gives the index and every tool page a generated image", () => {
    expect(generatedOgImagePath("/tools")).toBe("/tools/opengraph-image");
    for (const slug of TOOL_SLUGS) {
      expect(generatedOgImagePath(toolPath(slug))).toBe(`/tools/${slug}/opengraph-image`);
    }
    expect(generatedOgImagePath("/tools/no-such-tool")).toBeNull();
  });

  it("belongs to webhooks.cc: mailhooks.cc sends /tools there", () => {
    for (const path of ["/tools", ...TOOL_SLUGS.map(toolPath)]) {
      expect(servedOnMailhooks(path), path).toBe(false);
      expect(existsOnWebhooks(path), path).toBe(true);
    }
  });
});

describe("toolConnectSources", () => {
  it("allows each sending tool its one origin, on its own page only", () => {
    expect(toolConnectSources("/tools/discord-webhook-tester")).toEqual(["https://discord.com"]);
    expect(toolConnectSources("/tools/discord-webhook-tester/")).toEqual(["https://discord.com"]);
    expect(toolConnectSources("/tools/slack-webhook-tester")).toEqual(["https://hooks.slack.com"]);
  });

  it("adds nothing anywhere else", () => {
    for (const path of [
      "/",
      "/tools",
      "/tools/webhook-signature-checker",
      "/tools/discord-webhook-tester/opengraph-image",
      "/tools/discord-webhook-tester-2",
      "/dashboard",
      "/webhooks/discord",
      "/api/tools/discord-webhook-tester",
    ]) {
      expect(toolConnectSources(path), path).toEqual([]);
    }
  });

  it("only ever names an https origin, never a wildcard", () => {
    for (const tool of TOOLS) {
      if (tool.connectSource === null) continue;
      expect(tool.connectSource).toMatch(/^https:\/\/[a-z0-9.-]+$/);
      expect(new URL(tool.connectSource).origin).toBe(tool.connectSource);
    }
  });
});

describe("documentLoadedAs", () => {
  const path = "/tools/discord-webhook-tester";

  it("is true for the page's own document", () => {
    expect(documentLoadedAs(path, `https://webhooks.cc${path}`)).toBe(true);
    expect(documentLoadedAs(path, `https://webhooks.cc${path}/?utm_source=x#faq`)).toBe(true);
  });

  it("is false when the document was loaded as another page", () => {
    expect(documentLoadedAs(path, "https://webhooks.cc/tools")).toBe(false);
    expect(documentLoadedAs(path, "https://webhooks.cc/")).toBe(false);
    expect(documentLoadedAs(path, "https://webhooks.cc/tools/slack-webhook-tester")).toBe(false);
  });

  it("leaves the page be when the browser cannot say", () => {
    expect(documentLoadedAs(path, undefined)).toBe(true);
    expect(documentLoadedAs(path, "not a url")).toBe(true);
  });
});
