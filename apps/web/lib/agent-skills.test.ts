import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@/lib/frontmatter";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILLS_SCHEMA,
  buildAgentSkillsIndex,
  listSkillFiles,
  listSkillNames,
  readSkillFile,
  skillDigest,
} from "./agent-skills";

const SKILL_PATH = path.resolve(
  process.cwd(),
  "../../plugins/webhooks-cc/skills/webhooks-cc/SKILL.md"
);

describe("agent skills discovery", () => {
  it("lists the plugin's webhooks-cc skill with a digest over the file's bytes", async () => {
    const bytes = fs.readFileSync(SKILL_PATH);
    const { data } = parseFrontmatter(bytes.toString("utf8"));
    const index = await buildAgentSkillsIndex();

    expect(index.$schema).toBe(AGENT_SKILLS_SCHEMA);
    expect(index.skills).toContainEqual({
      name: "webhooks-cc",
      type: "skill-md",
      description: String(data.description).trim(),
      url: "/.well-known/agent-skills/webhooks-cc/SKILL.md",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  });

  it("keeps every entry within the RFC's field rules", async () => {
    const index = await buildAgentSkillsIndex();
    expect(index.skills.length).toBeGreaterThan(0);
    for (const skill of index.skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("formats digests as sha256: and 64 lowercase hex characters", () => {
    expect(skillDigest(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("serves SKILL.md and the markdown files it links to", async () => {
    expect(await listSkillNames()).toContain("webhooks-cc");
    const files = await listSkillFiles("webhooks-cc");
    expect(files[0]).toEqual(["SKILL.md"]);
    expect(files).toContainEqual(["references", "sdk-tests.md"]);

    const skill = fs.readFileSync(SKILL_PATH, "utf8");
    for (const [, link] of skill.matchAll(/\]\((references\/[^)#\s]+)\)/g)) {
      expect(files).toContainEqual(link.split("/"));
    }
  });

  it("refuses names and paths outside the skill directories", async () => {
    expect(await readSkillFile("webhooks-cc", ["SKILL.md"])).not.toBeNull();
    expect(await readSkillFile("webhooks-cc", ["..", "..", "plugin.json"])).toBeNull();
    expect(await readSkillFile("webhooks-cc", ["references", "..", "SKILL.md"])).toBeNull();
    expect(await readSkillFile("..", ["skills", "webhooks-cc", "SKILL.md"])).toBeNull();
    expect(await readSkillFile("Webhooks-CC", ["SKILL.md"])).toBeNull();
    expect(await readSkillFile("webhooks-cc", ["references"])).toBeNull();
    expect(await readSkillFile("webhooks-cc", ["missing.md"])).toBeNull();
    expect(await readSkillFile("webhooks-cc", [])).toBeNull();
    expect(await readSkillFile("no-such-skill", ["SKILL.md"])).toBeNull();
  });
});
