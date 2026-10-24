import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  describeOutgoing,
  pickRequest,
  prepareDelivery,
  type DestinationDraft,
} from "@/lib/forwarding/destination-delivery";
import { parseDestinationInput, templateProblem } from "@/lib/forwarding/destination-input";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { getDestination, getDestinationSecret } from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

/**
 * A dry run: what a destination would send for a captured request, without
 * sending anything. `destinationId` starts from a saved destination;
 * `destination` holds unsaved fields (on top of the saved ones, or on their
 * own, with a url); `requestId` picks the request (default: the newest of
 * the kind the destination takes, or a sample). Answers whether the filter
 * lets it through and the request it would send; header values the owner
 * stored stay masked.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "destination-preview", 120);
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
  if (
    body.destinationId !== undefined &&
    (typeof body.destinationId !== "string" || !isUuid(body.destinationId))
  ) {
    return reply({ error: "destinationId must be a destination id." }, 400);
  }
  const draft = body.destination ?? {};
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return reply({ error: "destination must be an object." }, 400);
  }

  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);
    const saved = body.destinationId
      ? await getDestination(endpoint.id, body.destinationId as string)
      : null;
    if (body.destinationId && !saved) return reply({ error: "Destination not found" }, 404);
    if (!saved && typeof (draft as Record<string, unknown>).url !== "string") {
      return reply({ error: "Give a destinationId, or a destination with a url." }, 400);
    }
    const parsed = parseDestinationInput(draft as Record<string, unknown>, {
      creating: !saved,
      current: saved ? { http: saved.http, email: saved.email } : undefined,
    });
    if (!parsed.ok) return reply({ error: parsed.error }, 400);
    const changes = parsed.changes;
    const destination: DestinationDraft = {
      url: changes.url ?? saved!.url,
      http: changes.http ?? saved?.http ?? true,
      email: changes.email ?? saved?.email ?? true,
      format: changes.format ?? saved?.format ?? "auto",
      filter: changes.filter !== undefined ? changes.filter : (saved?.filter ?? null),
      bodyTemplate:
        changes.bodyTemplate !== undefined ? changes.bodyTemplate : (saved?.bodyTemplate ?? null),
      messageTemplate:
        changes.messageTemplate !== undefined
          ? changes.messageTemplate
          : (saved?.messageTemplate ?? null),
      appendPath: changes.appendPath ?? saved?.appendPath ?? true,
      sentField: changes.sentField !== undefined ? changes.sentField : (saved?.sentField ?? null),
    };
    const problem = templateProblem(destination);
    if (problem) return reply({ error: problem }, 400);

    const picked = await pickRequest(endpoint, {
      requestId: (body.requestId as string | undefined) ?? null,
      destination,
    });
    if ("error" in picked) return reply({ error: picked.error }, picked.status);
    const secret = saved
      ? ((await getDestinationSecret(endpoint.id, saved.id)) ?? "")
      : "whsec_preview";
    // Stored header values stay masked; unsaved ones are shown as typed.
    const headers: [string, string][] = (changes.headers ?? saved?.headers ?? []).map((header) => [
      header.name,
      header.value ??
        saved?.headers.find((stored) => stored.name.toLowerCase() === header.name.toLowerCase())
          ?.value ??
        "",
    ]);
    const prepared = prepareDelivery(endpoint, destination, picked.request, secret, headers);
    const takesKind = picked.request.kind === "email" ? destination.email : destination.http;
    return reply({
      request: {
        id: picked.sample ? null : picked.request.id,
        kind: picked.request.kind,
        method: picked.request.method,
        path: picked.request.path,
        subject: picked.request.email?.subject ?? null,
        receivedAt: picked.request.receivedAt,
        sample: picked.sample,
      },
      takesKind,
      filterPasses: prepared.passes,
      format: prepared.format,
      delivery: describeOutgoing(prepared),
      error: "reason" in prepared.outgoing ? prepared.outgoing.reason : null,
    });
  } catch (error) {
    reportError("Destination preview failed", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
