import { buildJwks } from "@/lib/agent/assertion";

// The signing key is a runtime secret, absent when the image is built.
export const dynamic = "force-dynamic";

/**
 * Public keys that verify the identity assertions this server signs
 * (auth.md agent registration). The current key first, then a retired one
 * while its assertions can still be presented.
 */
export async function GET() {
  return Response.json(await buildJwks(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
