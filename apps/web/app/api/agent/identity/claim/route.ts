import { agentError } from "@/lib/agent/errors";

/**
 * POST /api/agent/identity/claim (auth.md Step 4a). The claim ceremony ships
 * in the next release; registrations made now keep their claim token and
 * can be claimed then, within their 24 hours.
 */
export async function POST() {
  return agentError(
    503,
    "temporarily_unavailable",
    "Claiming a registration is not available yet. Keep using the sandbox; your claim_token stays valid until the registration expires.",
    {},
    { "Retry-After": "3600" }
  );
}
