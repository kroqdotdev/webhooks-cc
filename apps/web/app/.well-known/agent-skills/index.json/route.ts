import { AGENT_SKILLS_HEADERS, buildAgentSkillsIndex } from "@/lib/agent-skills";

// Rendered once at build time, from the same bytes the file route serves, so
// the digests always match the files of the same deployment.
export const dynamic = "force-static";

/**
 * Agent Skills discovery index (agent-skills-discovery RFC v0.2.0). The RFC
 * renamed the well-known path from /.well-known/skills/ in v0.2.0; nothing
 * was ever published at the old path, and v0.1.0 clients cannot read this
 * format, so there is no redirect from it.
 */
export async function GET() {
  return Response.json(await buildAgentSkillsIndex(), { headers: AGENT_SKILLS_HEADERS });
}
