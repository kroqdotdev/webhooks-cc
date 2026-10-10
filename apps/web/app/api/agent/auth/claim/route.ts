import { endpointMoved } from "@/lib/agent/legacy";

/**
 * The auth.md v0.1 claim poll. v0.6 agents poll /api/oauth2/token with the
 * claim grant instead; see /auth.md.
 */
export async function POST() {
  return endpointMoved(
    "The v0.1 claim poll was replaced by the claim grant at /api/oauth2/token (auth.md v0.6). Read /auth.md."
  );
}
