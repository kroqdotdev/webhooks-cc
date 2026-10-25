import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { pickRequest, prepareDelivery, sendPrepared } from "@/lib/forwarding/destination-delivery";
import { ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import {
  getDestinationHeaders,
  getDestinationMailgunKey,
  getDestinationSecret,
  listDestinations,
  primaryDestination,
} from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";

/**
 * Sends one delivery to the primary destination (what the endpoint's old
 * forwardUrl field stands for) now, exactly as a real one would go out, and
 * reports what came back: the endpoint's newest request of the chosen kind
 * (`{ kind: "http" | "email" }`, by default whichever the destination takes),
 * or a sample when it has none yet. Nothing is queued or retried. Each
 * destination has a test of its own at /destinations/{id}/test.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "forwarding-test", 10);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  let requested: unknown;
  try {
    const text = await request.text();
    requested = text ? (JSON.parse(text) as { kind?: unknown }).kind : undefined;
  } catch {
    return reply({ error: "Send JSON, or no body." }, 400);
  }
  if (requested !== undefined && requested !== "http" && requested !== "email") {
    return reply({ error: 'kind must be "http" or "email".' }, 400);
  }

  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);
    const destination = primaryDestination(await listDestinations(endpoint.id));
    if (!destination) return reply({ error: "Save a forwarding URL first." }, 400);
    const picked = await pickRequest(endpoint, {
      kind: (requested as "http" | "email" | undefined) ?? null,
      destination,
    });
    if ("error" in picked) return reply({ error: picked.error }, picked.status);
    const prepared = prepareDelivery(
      endpoint,
      destination,
      picked.request,
      (await getDestinationSecret(endpoint.id, destination.id)) ?? "",
      await getDestinationHeaders(endpoint.id, destination.id),
      await getDestinationMailgunKey(endpoint.id, destination.id)
    );
    const sent = await sendPrepared(prepared);
    if (!sent.sent) return reply({ error: sent.reason }, 400);
    return reply({
      ...sent.result,
      sample: picked.sample,
      kind: picked.request.kind,
      format: prepared.format,
      target: prepared.facts.target,
      // What was sent, for the result sentence.
      request: {
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
