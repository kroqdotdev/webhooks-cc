import { buildAuthMd } from "@/lib/agent/metadata";
import { hasTrustedProviders } from "@/lib/agent/trusted-providers";

// Whether an ID-JAG issuer is trusted is runtime configuration.
export const dynamic = "force-dynamic";

/** Hosted auth.md: how an agent registers, uses the sandbox and gets tokens. */
export async function GET() {
  return new Response(buildAuthMd({ idJagEnabled: hasTrustedProviders() }), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
