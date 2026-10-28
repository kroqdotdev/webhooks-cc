import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { GET as getSkillFile, generateStaticParams } from "../[name]/[...path]/route";

function fileRequest(name: string, path: string[]) {
  return getSkillFile(new Request(`https://webhooks.cc/.well-known/agent-skills/${name}/x`), {
    params: Promise.resolve({ name, path }),
  });
}

describe("GET /.well-known/agent-skills/index.json", () => {
  it("returns the v0.2.0 index as JSON that browser agents may read", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");

    const index = await response.json();
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills.map((skill: { name: string }) => skill.name)).toContain("webhook-testing");
  });

  it("lists digests that match the bytes the file route serves", async () => {
    const index = await (await GET()).json();
    for (const skill of index.skills) {
      const [, name, file] =
        /^\/\.well-known\/agent-skills\/([^/]+)\/(SKILL\.md)$/.exec(skill.url) ?? [];
      expect(name).toBe(skill.name);

      const response = await fileRequest(name, [file]);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(skill.digest);
    }
  });
});

describe("GET /.well-known/agent-skills/{name}/{path}", () => {
  it("serves SKILL.md as markdown", async () => {
    const response = await fileRequest("webhook-testing", ["SKILL.md"]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toMatch(/^---\nname: webhook-testing\n/);
  });

  it("serves the reference files SKILL.md links to", async () => {
    const response = await fileRequest("webhook-testing", ["references", "sdk-tests.md"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("answers 404 for files that are not there", async () => {
    expect((await fileRequest("webhook-testing", ["nope.md"])).status).toBe(404);
    expect((await fileRequest("webhook-testing", ["..", "SKILL.md"])).status).toBe(404);
    expect((await fileRequest("unknown-skill", ["SKILL.md"])).status).toBe(404);
  });

  it("prerenders every file of every skill", async () => {
    const params = await generateStaticParams();
    expect(params).toContainEqual({ name: "webhook-testing", path: ["SKILL.md"] });
    expect(params).toContainEqual({
      name: "webhook-testing",
      path: ["references", "sdk-tests.md"],
    });
  });
});
