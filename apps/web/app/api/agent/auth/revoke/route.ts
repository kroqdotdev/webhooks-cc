import { endpointMoved } from "@/lib/agent/legacy";

/**
 * The auth.md v0.1 provider revocation (`logout+jwt`). No trusted identity
 * provider exists, so no credential was ever issued through it; v0.6 takes
 * provider events as Security Event Tokens at events_endpoint, which is
 * advertised once it exists.
 */
export async function POST() {
  return endpointMoved(
    "Provider revocation moved to Security Event Tokens (auth.md v0.6). Read /auth.md."
  );
}
