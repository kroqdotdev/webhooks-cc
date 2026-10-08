import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { buildEmailJson } from "@webhooks-cc/sdk/email";
import { serverEnv } from "@/lib/env";
import { sendOptions } from "@/lib/forwarding/config";
import { sampleEmailSource } from "@/lib/forwarding/sample";
import { isDelivered, sendForward } from "@/lib/forwarding/send";
import { forwardHeaders } from "@/lib/forwarding/sign";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { getEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import { getForwardSecret, getNewestEmailRequestId } from "@/lib/supabase/forwarding";
import { getRequestsByIds } from "@/lib/supabase/requests";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/**
 * Sends one delivery to the saved forwarding URL now and reports what came
 * back: the endpoint's newest email, or a sample when it has none yet.
 * Nothing is queued or retried.
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

  try {
    const endpoint = await getEndpointBySlugForUser(auth.userId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);
    const secret = await getForwardSecret(auth.userId, slug);
    if (!endpoint.forwardUrl || !secret) {
      return reply({ error: "Save a forwarding URL first." }, 400);
    }

    const newestId = await getNewestEmailRequestId(endpoint.id);
    const [newest] = newestId ? await getRequestsByIds([newestId]) : [];
    const source = newest?.email
      ? { ...newest, email: newest.email }
      : sampleEmailSource(`${endpoint.slug}@${serverEnv().EMAIL_CAPTURE_DOMAIN}`);
    const body = JSON.stringify(
      buildEmailJson(
        source,
        { slug: endpoint.slug, name: endpoint.name ?? null },
        {
          includeExtracts: endpoint.showEmailExtracts,
        }
      )
    );
    const result = await sendForward(
      endpoint.forwardUrl,
      forwardHeaders(secret, source.id, body),
      body,
      sendOptions()
    );
    return reply({ ...result, delivered: isDelivered(result), sample: !newest?.email });
  } catch (error) {
    console.error("Test delivery failed:", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
