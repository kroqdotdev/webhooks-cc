import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { setFavoriteEndpoint } from "@/lib/supabase/endpoint-favorites";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

/**
 * PUT /api/endpoints/{slug}/favorite marks the endpoint as one of the
 * caller's favourites; DELETE unmarks it. Both are idempotent and answer
 * `{ favorite }`. Anyone who can open the endpoint may, team members
 * included: a favourite is the caller's own, never the endpoint's, so it is
 * not audited.
 */
async function setFavorite(request: Request, slug: string, favorite: boolean) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(`endpoint-favorite:${auth.userId}`, 60);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  try {
    const access = await resolveEndpointAccess(auth.userId, slug);
    if (!access) return reply({ error: "Endpoint not found" }, 404);
    await setFavoriteEndpoint(auth.userId, access.endpointId, favorite);
    return reply({ favorite });
  } catch (error) {
    reportError("Failed to change a favourite endpoint", error);
    return reply({ error: "Internal server error" }, 500);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return setFavorite(request, (await params).slug, true);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return setFavorite(request, (await params).slug, false);
}
