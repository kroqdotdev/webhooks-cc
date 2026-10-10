import { endpointMoved } from "@/lib/agent/legacy";

/**
 * The auth.md v0.1 claim confirmation (claim link or typed code). v0.1 keys
 * expired long before this route closed, so there is nothing left to claim.
 */
export async function POST() {
  return endpointMoved(
    "This claim link comes from an older agent. Ask the agent to update and connect again. Read /auth.md."
  );
}
