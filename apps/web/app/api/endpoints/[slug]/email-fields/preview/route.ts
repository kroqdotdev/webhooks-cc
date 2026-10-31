import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { emailFieldsProblems, emailFieldValues, storedEmailFields } from "@/lib/email-fields";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { getNewestRetainedRequestId, getRetainedRequestsByIds } from "@/lib/supabase/requests";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

/**
 * A dry run of named email fields: what `emailFields` (the saved ones when
 * left out) find in a captured email (`requestId`, or the endpoint's newest
 * email). Nothing is saved. Owner only, like the fields themselves.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  // Each call runs up to 20 patterns over an email: a lower limit than other previews.
  const rateLimit = await checkRateLimitWithInfo(request, "email-fields-preview", 30);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const body = await jsonObject(request);
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
    const draft = body.emailFields !== undefined;
    const problems = draft ? emailFieldsProblems(body.emailFields) : [];
    // A field with a problem is left out, so the others still show what they
    // find; problems name fields by their place in the list as sent. A
    // problem with the whole list (not a list, too many, too large) leaves
    // nothing to run.
    const listProblem = problems.some((problem) => !/^field \d+:/.test(problem));
    const broken = new Set(
      problems.map((problem) => Number(/^field (\d+):/.exec(problem)?.[1] ?? 0) - 1)
    );
    const fields = !draft
      ? endpoint.emailFields
      : listProblem || !Array.isArray(body.emailFields)
        ? []
        : storedEmailFields(
            (body.emailFields as unknown[]).filter((_, index) => !broken.has(index))
          );

    const id =
      (body.requestId as string | undefined) ??
      (await getNewestRetainedRequestId(endpoint.id, "email"));
    const [email] = id ? await getRetainedRequestsByIds(endpoint.id, [id]) : [];
    if (email && (email.endpointId !== endpoint.id || email.kind !== "email")) {
      return reply({ error: "That email is not on this endpoint." }, 404);
    }
    return reply({
      problems,
      request: email
        ? { id: email.id, subject: email.email?.subject ?? null, receivedAt: email.receivedAt }
        : null,
      values: email ? (emailFieldValues(email, fields, { cache: !draft }) ?? {}) : null,
    });
  } catch (error) {
    reportError("Failed to preview email fields", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
