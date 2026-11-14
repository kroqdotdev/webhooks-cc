import { AGENT_SKILLS_BASE_PATH, AGENT_SKILLS_HEADERS } from "@/lib/agent-skills";

/** The skill's name until it grew to cover all of webhooks.cc. */
const RENAMED_TO = "webhooks-cc";

/**
 * The agent skill was published as webhook-testing first. Clients that saved
 * its file URLs are sent to the same file under the new name (SKILL.md and
 * references/sdk-tests.md kept their paths). A route handler rather than a
 * next.config redirect, because Next drops configured headers on redirects,
 * and a browser-based agent's cross-origin fetch follows a redirect only when
 * the redirect itself carries Access-Control-Allow-Origin.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const location = `${AGENT_SKILLS_BASE_PATH}/${RENAMED_TO}/${path.map(encodeURIComponent).join("/")}`;
  return new Response(null, {
    status: 308,
    headers: { ...AGENT_SKILLS_HEADERS, Location: location },
  });
}
