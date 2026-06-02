import { buildAuthMd } from "@/lib/agent/metadata";

// Hosted auth.md discovery document describing the agent-registration protocol
// (anonymous, verified_email OTP, identity_assertion/ID-JAG) plus the in-app
// claim ceremony, error catalog, and revocation. The markdown is built by the
// pure buildAuthMd() helper, which sources hostnames from NEXT_PUBLIC_APP_URL.
export async function GET() {
  return new Response(buildAuthMd(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
