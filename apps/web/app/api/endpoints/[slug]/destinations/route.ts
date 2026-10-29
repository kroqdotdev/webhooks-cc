import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  parseDestinationInput,
  sheetsProblem,
  templateProblem,
} from "@/lib/forwarding/destination-input";
import {
  forwardingUnavailable,
  jsonObject,
  ownedEndpoint,
} from "@/lib/forwarding/destination-routes";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import {
  createDestination,
  DestinationHeaderValueMissingError,
  getDestinationSummaries,
  listDestinations,
  TooManyDestinationsError,
} from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";

/**
 * Where the endpoint's captures go. GET lists the destinations in order
 * (with `?summary=true`, each with its deliveries of the last 24 hours and
 * what is waiting); POST adds one. Owner only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return Response.json({ error: "Endpoint not found" }, { status: 404 });
    const destinations = await listDestinations(endpoint.id);
    if (new URL(request.url).searchParams.get("summary") !== "true") {
      return Response.json(destinations);
    }
    const summaries = new Map(
      (await getDestinationSummaries(endpoint.id)).map((summary) => [
        summary.destinationId,
        summary,
      ])
    );
    return Response.json(
      destinations.map((destination) => {
        const summary = summaries.get(destination.id);
        return {
          ...destination,
          summary: {
            last24h: summary?.last24h ?? { delivered: 0, failed: 0, skipped: 0 },
            pending: summary?.pending ?? 0,
          },
        };
      })
    );
  } catch (error) {
    reportError("Failed to list destinations", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "destinations", 60);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const body = await jsonObject(request);
  if (body instanceof Response) return applyRateLimitHeaders(body, rateLimit);
  const parsed = parseDestinationInput(body, { creating: true });
  if (!parsed.ok) return reply({ error: parsed.error }, 400);
  const problem = templateProblem({
    format: parsed.changes.format ?? "auto",
    bodyTemplate: parsed.changes.bodyTemplate ?? null,
  });
  if (problem) return reply({ error: problem }, 400);
  const unavailable = forwardingUnavailable();
  if (unavailable) return applyRateLimitHeaders(unavailable, rateLimit);

  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);
    const sheets = await sheetsProblem(auth.userId, {
      format: parsed.changes.format ?? "auto",
      config: parsed.changes.config ?? null,
    });
    if (sheets) return reply({ error: sheets }, 400);
    const destination = await createDestination(endpoint.id, {
      ...parsed.changes,
      url: parsed.changes.url!,
    });
    await auditUserAction(request, auth.userId, {
      action: "endpoint.destination_created",
      status: 201,
      targetId: slug,
      metadata: { destinationId: destination.id },
    });
    return reply(destination, 201);
  } catch (error) {
    if (error instanceof TooManyDestinationsError) return reply({ error: error.message }, 409);
    if (error instanceof DestinationHeaderValueMissingError) {
      return reply({ error: error.message }, 400);
    }
    reportError("Failed to add a destination", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
