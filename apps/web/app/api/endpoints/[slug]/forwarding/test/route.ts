import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { serverEnv } from "@/lib/env";
import { sendOptions } from "@/lib/forwarding/config";
import { resolveFormat } from "@/lib/forwarding/format";
import { sampleEmailSource, sampleHttpRequest } from "@/lib/forwarding/sample";
import { isDelivered, sendForward } from "@/lib/forwarding/send";
import { outgoingFor } from "@/lib/forwarding/worker";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { getEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import {
  getForwardOwnerHeaders,
  getForwardSecret,
  getNewestRequestId,
} from "@/lib/supabase/forwarding";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/**
 * Sends one delivery to the saved forwarding URL now, exactly as a real one
 * would go out, and reports what came back: the endpoint's newest request of
 * the chosen kind (`{ kind: "http" | "email" }`, by default whichever the
 * endpoint forwards), or a sample when it has none yet. Nothing is queued or
 * retried.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "forwarding-test", 10);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return reply({ error: "Endpoint not found" }, 404);

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
    const endpoint = await getEndpointBySlugForUser(auth.userId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);
    const secret = await getForwardSecret(auth.userId, slug);
    if (!endpoint.forwardUrl || !secret) {
      return reply({ error: "Save a forwarding URL first." }, 400);
    }
    const kind: "http" | "email" =
      (requested as "http" | "email" | undefined) ??
      (endpoint.forwardHttp || !endpoint.forwardEmail ? "http" : "email");

    const newestId = await getNewestRequestId(endpoint.id, kind);
    const [newest] = newestId ? await getRequestsByIds([newestId]) : [];
    let source: RequestRecord;
    if (newest) {
      source = newest;
    } else if (kind === "http") {
      source = sampleHttpRequest(endpoint.id);
    } else {
      const sample = sampleEmailSource(`${endpoint.slug}@${serverEnv().EMAIL_CAPTURE_DOMAIN}`);
      source = {
        id: sample.id,
        endpointId: endpoint.id,
        method: "EMAIL",
        path: sample.path,
        headers: sample.headers,
        queryParams: {},
        ip: "127.0.0.1",
        size: sample.size,
        receivedAt: sample.receivedAt,
        kind: "email",
        email: sample.email,
      };
    }

    const prepared = outgoingFor(source, {
      url: endpoint.forwardUrl,
      format: endpoint.forwardFormat === "auto" ? null : endpoint.forwardFormat,
      appendPath: endpoint.forwardAppendPath,
      slug: endpoint.slug,
      name: endpoint.name ?? null,
      showEmailExtracts: endpoint.showEmailExtracts,
      ownerHeaders: await getForwardOwnerHeaders(auth.userId, slug),
      attempt: 1,
      secret,
    });
    if ("reason" in prepared) return reply({ error: prepared.reason }, 400);
    const result = await sendForward(prepared.outgoing, sendOptions());
    return reply({
      ...result,
      delivered: isDelivered(result),
      sample: !newest,
      kind,
      format: resolveFormat(
        kind,
        endpoint.forwardFormat === "auto" ? null : endpoint.forwardFormat,
        endpoint.forwardUrl
      ),
      url: prepared.outgoing.url,
    });
  } catch (error) {
    console.error("Test delivery failed:", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
