import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

/**
 * Agent Skills discovery (agent-skills-discovery RFC v0.2.0): the index at
 * /.well-known/agent-skills/index.json and the files it points to. The skills
 * are the Claude Code plugin's own copies, read from disk rather than
 * duplicated, and each digest is taken over the exact bytes the file route
 * serves, which clients verify before using a skill.
 *
 * Each skill is listed as `skill-md` (its SKILL.md alone). The files a
 * SKILL.md links to, such as references/sdk-tests.md, are served next to it,
 * so its relative links resolve against the URL it was fetched from.
 */

/** Opaque version identifier of the v0.2.0 index format. */
export const AGENT_SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export const AGENT_SKILLS_BASE_PATH = "/.well-known/agent-skills";

// Relative to the server's working directory (apps/web), like lib/docs.ts.
// next.config.ts traces the directory into the standalone build.
const SKILLS_DIR = path.resolve(process.cwd(), "../../plugins/webhooks-cc/skills");

// Agent Skills naming rule: 1-64 characters, lowercase letters, digits and
// single hyphens, not at either end.
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
// One path segment of a served file: no dot files, no "..", no separators.
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface AgentSkillEntry {
  name: string;
  type: "skill-md";
  description: string;
  url: string;
  digest: string;
}

export interface AgentSkillsIndex {
  $schema: string;
  skills: AgentSkillEntry[];
}

/** `sha256:{64 lowercase hex}`, the digest format the RFC requires. */
export function skillDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isMissing(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

/** Names of the skill directories that hold a SKILL.md, sorted. */
export async function listSkillNames(): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
    try {
      await fs.access(path.join(SKILLS_DIR, entry.name, "SKILL.md"));
      names.push(entry.name);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return names.sort();
}

/**
 * Every markdown file of a skill as path segments relative to its directory,
 * SKILL.md first. Only markdown is served: a skill that ever ships scripts
 * belongs in an `archive` entry instead.
 */
export async function listSkillFiles(name: string): Promise<string[][]> {
  if (!SKILL_NAME.test(name)) return [];
  const files: string[][] = [];

  async function walk(dir: string, prefix: string[]) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!FILE_SEGMENT.test(entry.name)) continue;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), [...prefix, entry.name]);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push([...prefix, entry.name]);
      }
    }
  }

  try {
    await walk(path.join(SKILLS_DIR, name), []);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const key = (segments: string[]) => segments.join("/");
  return files.sort((a, b) => {
    if (key(a) === "SKILL.md") return -1;
    if (key(b) === "SKILL.md") return 1;
    return key(a).localeCompare(key(b));
  });
}

/**
 * The raw bytes of one markdown file of a skill, or null when the name or
 * path is not one this route serves.
 */
export async function readSkillFile(name: string, segments: string[]): Promise<Buffer | null> {
  if (!SKILL_NAME.test(name) || segments.length === 0) return null;
  if (!segments.every((segment) => FILE_SEGMENT.test(segment))) return null;
  if (!segments[segments.length - 1].endsWith(".md")) return null;
  try {
    return await fs.readFile(path.join(SKILLS_DIR, name, ...segments));
  } catch (err) {
    // EISDIR and ENOTDIR are as missing as ENOENT for a URL.
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
    }
    throw err;
  }
}

/**
 * Builds the discovery index. A SKILL.md whose frontmatter breaks the Agent
 * Skills rules throws, so a broken skill fails the build instead of quietly
 * dropping out of the index.
 */
export async function buildAgentSkillsIndex(): Promise<AgentSkillsIndex> {
  const skills: AgentSkillEntry[] = [];
  for (const name of await listSkillNames()) {
    const bytes = await readSkillFile(name, ["SKILL.md"]);
    if (!bytes) continue;
    const { data } = matter(bytes.toString("utf8"));
    if (data.name !== name) {
      throw new Error(`Agent skill ${name}: frontmatter name must equal the directory name`);
    }
    const description = typeof data.description === "string" ? data.description.trim() : "";
    if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `Agent skill ${name}: description must be 1 to ${MAX_DESCRIPTION_LENGTH} characters`
      );
    }
    skills.push({
      name,
      type: "skill-md",
      description,
      url: `${AGENT_SKILLS_BASE_PATH}/${name}/SKILL.md`,
      digest: skillDigest(bytes),
    });
  }
  return { $schema: AGENT_SKILLS_SCHEMA, skills };
}

/** Headers shared by the index and the skill files. */
export const AGENT_SKILLS_HEADERS = {
  // Browser-based agents fetch these cross-origin; the content is public.
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
} as const;
