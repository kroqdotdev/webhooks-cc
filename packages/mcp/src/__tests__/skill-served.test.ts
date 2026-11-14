import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../index";
import { SKILL_FILES } from "../skill-files";
import { skillSource } from "../skills";

const SKILL_DIR = join(__dirname, "../../../../plugins/webhooks-cc/skills/webhooks-cc");
const ctx = {} as never;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

describe("the agent skill the MCP servers serve", () => {
  it("is the plugin's skill, file for file (run scripts/bundle-skill.mjs after changing it)", () => {
    const onDisk = Object.fromEntries(
      walk(SKILL_DIR).map((path) => [
        relative(SKILL_DIR, path).split("\\").join("/"),
        readFileSync(path, "utf8"),
      ])
    );
    expect(SKILL_FILES).toEqual(onDisk);
  });

  it("lists the skill and reads its files, and nothing else", async () => {
    const { skills } = await skillSource.list({}, ctx);
    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill.frontmatter.name).toBe("webhooks-cc");
    expect(await skillSource.get(skill.uri, ctx)).toBe(skill);
    const main = await skillSource.read(skill.uri, ctx);
    expect(main).toEqual({ text: SKILL_FILES["SKILL.md"], mimeType: "text/markdown" });
    const base = skill.uri.slice(0, -"SKILL.md".length);
    expect(await skillSource.read(`${base}references/testing.md`, ctx)).toMatchObject({
      text: SKILL_FILES["references/testing.md"],
    });
    expect(await skillSource.read(`${base}references/nope.md`, ctx)).toBeUndefined();
    expect(await skillSource.read(`${base}../etc/passwd`, ctx)).toBeUndefined();
    expect(await skillSource.read(`${base}constructor`, ctx)).toBeUndefined();
    expect(await skillSource.get("skill://other/SKILL.md", ctx)).toBeUndefined();
  });

  it("answers skills/list on the local server", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    open.push(
      serveStdio(() => createServer({ apiKey: "whcc_test", baseUrl: "http://127.0.0.1:9" }), {
        transport: serverSide,
      })
    );
    const answers: JSONRPCMessage[] = [];
    clientSide.onmessage = (message) => {
      answers.push(message);
    };
    await clientSide.start();
    open.push(clientSide);
    await clientSide.send({
      jsonrpc: "2.0",
      id: 1,
      method: "skills/list",
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "test", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    });
    await vi.waitFor(() =>
      expect(answers.some((message) => "id" in message && message.id === 1)).toBe(true)
    );
    const answer = answers.find((message) => "id" in message && message.id === 1) as {
      result?: { skills: Array<{ frontmatter: { name: string } }> };
      error?: unknown;
    };
    expect(answer.error).toBeUndefined();
    expect(answer.result!.skills.map((skill) => skill.frontmatter.name)).toEqual(["webhooks-cc"]);
  });
});
