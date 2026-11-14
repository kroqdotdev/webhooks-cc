import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { CONDITION_FIELDS, CONDITION_OPS, type WebhooksCC } from "@webhooks-cc/sdk";
import { ENABLE_TOOLS } from "../catalog";
import { asToolServer } from "../local-tools";
import { registerSandboxTools } from "../sandbox-tools";
import { registerTools } from "../tools";

// The agent skill and the Claude Code plugin (plugins/webhooks-cc) tell agents
// which of this server's tools to call, so a renamed tool must fail here.
const repo = join(__dirname, "..", "..", "..", "..");
const plugin = join(repo, "plugins", "webhooks-cc");
const skillDir = join(plugin, "skills", "webhooks-cc");
const referencesDir = join(skillDir, "references");
const read = (path: string) => readFileSync(path, "utf-8");
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function toolNames(register: (server: McpServer) => void): Set<string> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const spy = vi.spyOn(server, "registerTool");
  register(server);
  return new Set(spy.mock.calls.map((call) => call[0] as string));
}

const fullTools = toolNames((server) => registerTools(asToolServer(server), {} as WebhooksCC));
const sandboxTools = toolNames((server) => registerSandboxTools(server, {}));
// enable_tools is registered by the local server's group loader, not registerTools.
const knownTools = new Set([...fullTools, ...sandboxTools, ENABLE_TOOLS]);

// Backticked snake_case words in the skill that are SDK identifiers, not tools.
const NOT_TOOLS = new Set([
  "webhooks_cc",
  "webhooks_cc_endpoint",
  "build_template_request",
  // A `whk` error code.
  "delivery_failed",
]);

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

/**
 * Backticked snake_case words, which in the skill are tool names unless they
 * are condition fields, condition operators, SDK identifiers or CLI error codes.
 */
function mentionedTools(markdown: string): string[] {
  const ops: readonly string[] = CONDITION_OPS;
  return [...new Set([...markdown.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))].filter(
    (name) => !(name in CONDITION_FIELDS) && !ops.includes(name) && !NOT_TOOLS.has(name)
  );
}

const references = readdirSync(referencesDir)
  .filter((file) => file.endsWith(".md"))
  .sort();

describe("agent skill", () => {
  const skill = read(join(skillDir, "SKILL.md"));

  it("has valid Agent Skills frontmatter", () => {
    const { name, description } = frontmatter(skill);
    expect(name).toBe("webhooks-cc");
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThan(1024);
  });

  it("stays short enough to load into every session", () => {
    expect(words(skill)).toBeLessThan(900);
  });

  it("only names tools the server has", () => {
    const named = mentionedTools(skill);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((name) => !knownTools.has(name))).toEqual([]);
  });

  it("lists sandbox tools the sandbox really has", () => {
    const start = skill.indexOf("## Without an account");
    expect(start).toBeGreaterThan(0);
    const sandboxSection = skill.slice(start, skill.indexOf("\n## ", start + 1));
    const named = mentionedTools(sandboxSection);
    expect(named).toContain("connect_account");
    for (const name of named) {
      expect(sandboxTools.has(name), `${name} in the sandbox section`).toBe(true);
    }
  });

  it("links only to files that exist", () => {
    for (const [, target] of skill.matchAll(/\]\(((?!https?:)[^)]+)\)/g)) {
      expect(() => read(join(skillDir, target)), target).not.toThrow();
    }
  });

  it("links every reference file from SKILL.md", () => {
    expect(references.length).toBeGreaterThan(1);
    for (const file of references) {
      expect(skill, file).toContain(`](references/${file})`);
    }
  });

  describe.each(references)("references/%s", (file) => {
    const markdown = read(join(referencesDir, file));

    it("only names tools the server has", () => {
      expect(mentionedTools(markdown).filter((name) => !knownTools.has(name))).toEqual([]);
    });

    it("links only to files that exist", () => {
      for (const [, target] of markdown.matchAll(/\]\(((?!https?:)[^)]+)\)/g)) {
        expect(() => read(join(referencesDir, target)), target).not.toThrow();
      }
    });
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
      skills: ["./skills/webhooks-cc"],
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
