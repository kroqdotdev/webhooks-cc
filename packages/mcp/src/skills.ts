import type { McpServer } from "@modelcontextprotocol/server";
import {
  skillEntry,
  SkillsExtension,
  type Skill,
  type SkillSource,
} from "@modelcontextprotocol/server/ext/skills";
import { SKILL_FILES, SKILL_NAME } from "./skill-files";

/**
 * The agent skill (plugins/webhooks-cc/skills/webhooks-cc), served over the
 * MCP skills extension by the local and the hosted server alike, so a
 * client that reads skills from its servers gets it without installing
 * anything. The files ship inside the package (skill-files.ts).
 */

let entry: Promise<Skill> | undefined;

/** The published entry: frontmatter, file digests and sizes, built once. */
function skill(): Promise<Skill> {
  entry ??= skillEntry(SKILL_NAME, SKILL_FILES);
  return entry;
}

/** The bundled file a skill URI names, if it names one. */
async function fileAt(uri: string): Promise<string | undefined> {
  const published = await skill();
  const base = published.uri.slice(0, published.uri.length - "SKILL.md".length);
  if (!uri.startsWith(base)) return undefined;
  const path = uri.slice(base.length);
  return Object.prototype.hasOwnProperty.call(SKILL_FILES, path) ? SKILL_FILES[path] : undefined;
}

export const skillSource: SkillSource = {
  async list() {
    return { skills: [await skill()] };
  },
  async get(uri) {
    const published = await skill();
    return uri === published.uri ? published : undefined;
  },
  async read(uri) {
    const text = await fileAt(uri);
    return text === undefined ? undefined : { text, mimeType: "text/markdown" };
  },
};

// One extension serves every server it is attached to; the skill changes
// only with a release, so clients may cache it for an hour.
const extension = new SkillsExtension({
  source: skillSource,
  cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
});

/** Serves the agent skill from `server`; call it before connecting. */
export function attachSkill(server: McpServer): void {
  extension.attach(server);
}
