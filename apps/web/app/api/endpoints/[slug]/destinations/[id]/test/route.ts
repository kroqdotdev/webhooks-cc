import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { pickRequest, prepareDelivery, sendPrepared } from "@/lib/forwarding/destination-delivery";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import {
  getDestination,
  getDestinationHeaders,
  getDestinationMailgunKey,
  getDestinationSecret,
} from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * Sends one delivery to a saved destination now, exactly as a real one would
 * go out, and reports what came back: `requestId`, or the newest request of
 * `kind` (by default the kind the destination takes), or a sample. The
 * filter is reported, not applied, so a test always sends. Nothing is queued.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug, id } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "forwarding-test", 10);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const body = await jsonObject(request);
  if (body instanceof Response) return applyRateLimitHeaders(body, rateLimit);
  if (body.kind !== undefined && body.kind !== "http" && body.kind !== "email") {
    return reply({ error: 'kind must be "http" or "email".' }, 400);
  }
  if (
    body.requestId !== undefined &&
    (typeof body.requestId !== "string" || !isUuid(body.requestId))
  ) {
    return reply({ error: "requestId must be a request id." }, 400);
  }
  if (!isUuid(id)) return reply({ error: "Destination not found" }, 404);

  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    const destination = endpoint ? await getDestination(endpoint.id, id) : null;
    if (!endpoint || !destination) return reply({ error: "Destination not found" }, 404);
    const picked = await pickRequest(endpoint, {
      requestId: (body.requestId as string | undefined) ?? null,
      kind: (body.kind as "http" | "email" | undefined) ?? null,
      destination,
    });
    if ("error" in picked) return reply({ error: picked.error }, picked.status);
    const secret = (await getDestinationSecret(endpoint.id, id)) ?? "";
    const prepared = prepareDelivery(
      endpoint,
      destination,
      picked.request,
      secret,
      await getDestinationHeaders(endpoint.id, id),
      await getDestinationMailgunKey(endpoint.id, id)
    );
    const sent = await sendPrepared(prepared);
    if (!sent.sent) return reply({ error: sent.reason }, 400);
    return reply({
      ...sent.result,
      sample: picked.sample,
      kind: picked.request.kind,
      format: prepared.format,
      target: prepared.facts.target,
      filterPasses: prepared.passes,
      request: {
        id: picked.sample ? null : picked.request.id,
        method: picked.request.method,
        path: picked.request.path,
        subject: picked.request.email?.subject ?? null,
        receivedAt: picked.request.receivedAt,
      },
      sender: prepared.facts.sent,
    });
  } catch (error) {
    reportError("Test delivery failed", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
