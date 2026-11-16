import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import type { WebhooksCC } from "@webhooks-cc/sdk";
import { asToolServer } from "../local-tools";
import { registerSandboxTools } from "../sandbox-tools";
import { registerTools, type RegisterToolsOptions } from "../tools";
import { ENABLE_TOOLS } from "../catalog";

// The docs, the README and the pages that compare us state how many tools
// the servers have, and /docs/mcp/tools documents each one. The tools are
// the one source: these fail when a tool is added or removed without them.
const repo = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(repo, path), "utf-8");

function toolNames(register: (server: McpServer) => void): string[] {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const spy = vi.spyOn(server, "registerTool");
  register(server);
  return spy.mock.calls.map((call) => call[0] as string);
}

const tools = (options: RegisterToolsOptions = {}) =>
  toolNames((server) => registerTools(asToolServer(server), {} as WebhooksCC, options));

const core = new Set(["core"] as const);
const counts = {
  local: tools().length,
  remote: tools({ remote: true }).length,
  core: tools({ groups: core }).length,
  remoteCore: tools({ remote: true, groups: core }).length,
  sandbox: toolNames((server) => registerSandboxTools(server, {})).length,
};

describe("the tool counts the docs state", () => {
  const stated: Array<[string, string]> = [
    ["content/docs/mcp/index.mdx", `${counts.local} MCP tools, a remote server at webhooks.cc/mcp`],
    [
      "content/docs/mcp/index.mdx",
      `The local server has ${counts.local} tools in all, and the remote server ${counts.remote} of them. Without an API key or a saved connection, ${counts.sandbox} sandbox tools`,
    ],
    [
      "content/docs/mcp/index.mdx",
      `(${counts.core} tools, ${counts.remoteCore} on the remote server)`,
    ],
    [
      "content/docs/mcp/index.mdx",
      `The remote server has ${counts.remote} of the ${counts.local} tools`,
    ],
    ["content/docs/mcp/index.mdx", `sandbox mode with ${counts.sandbox} tools`],
    ["content/docs/mcp/tools.mdx", `all ${counts.local} MCP tools`],
    ["content/docs/mcp/workflows.mdx", `all ${counts.local} MCP tools`],
    ["packages/mcp/README.md", `The remote server has ${counts.remote} tools:`],
    [
      "packages/mcp/README.md",
      `the \`${counts.core}\` core tools and \`enable_tools\` by default, and all \`${counts.local}\` tools`,
    ],
    ["packages/mcp/README.md", `it lists \`${counts.sandbox}\` sandbox tools`],
    [
      "packages/mcp/README.md",
      `exposes the \`${counts.remoteCore}\` core tools it can run by default, and \`${counts.remote}\` with`,
    ],
    [
      "apps/web/public/llms-full.txt",
      `The local server has ${counts.local} tools once it is connected to an account`,
    ],
    ["apps/web/public/llms-full.txt", `\`share_port\` (${counts.remote})`],
    ["apps/web/app/compare/stripe-cli/page.tsx", `@webhooks-cc/mcp, ${counts.local} tools`],
    ["apps/web/app/compare/svix/page.tsx", `the local package with ${counts.local} tools`],
    ["apps/web/app/compare/svix/page.tsx", `or local (${counts.local} tools)`],
    ["apps/web/app/compare/svix/page.tsx", `server exposes ${counts.local}\n`],
  ];

  it.each(stated)("%s says %j", (path, phrase) => {
    // Prettier may wrap a long line: compare with whitespace folded.
    const fold = (text: string) => text.replace(/\s+/g, " ");
    expect(fold(read(path))).toContain(fold(phrase));
  });
});

describe("the tool reference", () => {
  const reference = read("content/docs/mcp/tools.mdx");
  const sections = new Set(
    [...reference.matchAll(/^### +`?([a-z_]+)`?\s*$/gm)].map((match) => match[1])
  );

  it("has a section of its own for every tool, sandbox tools included", () => {
    // enable_tools is the local server's own (local-tools.ts), outside registerTools.
    const all = new Set([
      ...tools(),
      ...toolNames((server) => registerSandboxTools(server, {})),
      ENABLE_TOOLS,
    ]);
    const missing = [...all].filter((name) => !sections.has(name));
    expect(missing).toEqual([]);
  });

  it("documents no tool the servers do not have", () => {
    // enable_tools is the local server's own (local-tools.ts), outside registerTools.
    const all = new Set([
      ...tools(),
      ...toolNames((server) => registerSandboxTools(server, {})),
      ENABLE_TOOLS,
    ]);
    expect([...sections].filter((name) => !all.has(name))).toEqual([]);
  });
});
