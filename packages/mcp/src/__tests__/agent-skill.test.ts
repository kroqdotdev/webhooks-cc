import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { WebhooksCC } from "@webhooks-cc/sdk";
import { registerSandboxTools } from "../sandbox-tools";
import { registerTools } from "../tools";

// The agent skill and the Claude Code plugin (plugins/webhooks-cc) tell agents
// which of this server's tools to call, so a renamed tool must fail here.
const repo = join(__dirname, "..", "..", "..", "..");
const plugin = join(repo, "plugins", "webhooks-cc");
const skillDir = join(plugin, "skills", "webhook-testing");
const read = (path: string) => readFileSync(path, "utf-8");

function toolNames(register: (server: McpServer) => void): Set<string> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const spy = vi.spyOn(server, "tool");
  register(server);
  return new Set(spy.mock.calls.map((call) => call[0] as string));
}

const fullTools = toolNames((server) => registerTools(server, {} as WebhooksCC));
const sandboxTools = toolNames((server) => registerSandboxTools(server, {}));

function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) throw new Error("SKILL.md has no frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
  );
}

/** Backticked snake_case words, which in the skill are tool names. */
function mentionedTools(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];
}

describe("agent skill", () => {
  const skill = read(join(skillDir, "SKILL.md"));

  it("has valid Agent Skills frontmatter", () => {
    const { name, description } = frontmatter(skill);
    expect(name).toBe("webhook-testing");
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("only names tools the server has", () => {
    const named = mentionedTools(skill);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((name) => !fullTools.has(name) && !sandboxTools.has(name))).toEqual([]);
  });

  it("lists sandbox tools the sandbox really has", () => {
    const sandboxParagraph = skill.slice(
      skill.indexOf("Without an API key"),
      skill.indexOf("## Workflows")
    );
    for (const name of mentionedTools(sandboxParagraph)) {
      expect(sandboxTools.has(name), `${name} in the sandbox paragraph`).toBe(true);
    }
  });

  it("links only to files that exist", () => {
    for (const [, target] of skill.matchAll(/\]\(((?!https?:)[^)]+)\)/g)) {
      expect(() => read(join(skillDir, target)), target).not.toThrow();
    }
  });
});

describe("Claude Code plugin", () => {
  const manifest = JSON.parse(read(join(plugin, ".claude-plugin", "plugin.json")));
  const marketplace = JSON.parse(read(join(repo, ".claude-plugin", "marketplace.json")));
  const mcp = JSON.parse(read(join(plugin, ".mcp.json")));

  it("is listed in the marketplace under its own name", () => {
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: manifest.name,
      source: "./plugins/webhooks-cc",
      skills: ["./skills/webhook-testing"],
    });
  });

  it("starts this package with the key the user entered", () => {
    expect(mcp.mcpServers["webhooks-cc"]).toEqual({
      command: "npx",
      args: ["-y", "@webhooks-cc/mcp"],
      env: { WHK_API_KEY: "${user_config.api_key}" },
    });
    expect(manifest.userConfig.api_key).toMatchObject({ sensitive: true, default: "" });
  });

  it("gives AGENTS.md users the same snippet in the README and the docs", () => {
    const snippet = (markdown: string) => {
      const start = markdown.indexOf("```markdown\n## Webhooks");
      return markdown.slice(start, markdown.indexOf("```\n", start + 3));
    };
    const readme = snippet(read(join(plugin, "README.md")));
    expect(readme).toContain("generate_payload_schema");
    expect(snippet(read(join(repo, "content", "docs", "mcp", "skills.mdx")))).toBe(readme);
  });
});
