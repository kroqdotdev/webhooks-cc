import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { layoutsProblems, storedLayouts } from "@/lib/parsing/layouts";
import { accountOf, parseEmail } from "@/lib/parsing/worker";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { getNewestRetainedRequestId, getRetainedRequestsByIds } from "@/lib/supabase/requests";
import type { Json } from "@/lib/supabase/database";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

/**
 * A dry run of layouts: which one a captured email (`requestId`, or the
 * endpoint's newest email) matches, and the fields and line items it finds,
 * with `layouts` (the saved ones when left out). Nothing is saved and no
 * pages are used: attachments show what an earlier parse stored, never a new
 * parse. Owner only, like the layouts themselves.
 */
const PREVIEW_BUDGET_MS = 5_000;

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  // Per account, not per address: each call runs the account's patterns
  // over an email of its own choosing.
  const rateLimit = await checkRateLimitByKeyWithInfo(`user:layouts-preview:${auth.userId}`, 20);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const body = await jsonObject(request, 600 * 1024);
  if (body instanceof Response) return applyRateLimitHeaders(body, rateLimit);
  if (
    body.requestId !== undefined &&
    (typeof body.requestId !== "string" || !isUuid(body.requestId))
  ) {
    return reply({ error: "requestId must be a request id." }, 400);
  }

  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);
    const draft = body.layouts !== undefined;
    const problems = draft ? layoutsProblems(body.layouts) : [];
    const layouts = draft
      ? problems.length > 0
        ? []
        : storedLayouts(body.layouts)
      : endpoint.layouts;

    const id =
      (body.requestId as string | undefined) ??
      (await getNewestRetainedRequestId(endpoint.id, "email"));
    const [email] = id ? await getRetainedRequestsByIds(endpoint.id, [id]) : [];
    if (email && (email.endpointId !== endpoint.id || email.kind !== "email")) {
      return reply({ error: "That email is not on this endpoint." }, 404);
    }
    const parsed =
      email && problems.length === 0
        ? (
            await parseEmail(
              email,
              layouts,
              endpoint.emailFields as unknown as Json,
              await accountOf(email.id, auth.userId),
              false,
              // A preview gets a few seconds; the worker gets more.
              Date.now() + PREVIEW_BUDGET_MS
            )
          ).result
        : null;
    return reply({
      problems,
      layoutsCap: endpoint.layoutsCap,
      request: email
        ? { id: email.id, subject: email.email?.subject ?? null, receivedAt: email.receivedAt }
        : null,
      parsed,
    });
  } catch (error) {
    reportError("Failed to preview layouts", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
