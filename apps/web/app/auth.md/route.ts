import { serverEnv } from "@/lib/env";
import { buildAuthMd } from "@/lib/agent/metadata";
import { hasTrustedProviders } from "@/lib/agent/trusted-providers";

// Whether an ID-JAG issuer is trusted is runtime configuration.
export const dynamic = "force-dynamic";

/** Hosted auth.md: how an agent registers, uses the sandbox and gets tokens. */
export async function GET() {
  const markdown = buildAuthMd({
    idJagEnabled: hasTrustedProviders(),
    idJagMaxAuthAgeSeconds: serverEnv().AGENT_IDJAG_MAX_AUTH_AGE_SECONDS,
  });
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
