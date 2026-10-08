import { isValidEmailTag } from "@webhooks-cc/sdk/email";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { publicEnv, serverEnv } from "@/lib/env";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { buildTestEmail, DELIVER_PATH, signMailRequest, testDeliveryBody } from "@/lib/test-email";

const SLUG_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;
const DELIVER_TIMEOUT_MS = 10_000;

/**
 * Delivers a sample email to one of the caller's endpoints through the
 * receiver's private mail API (see lib/test-email.ts). It is captured and
 * counted like any other email. With `tag`, it goes to `{slug}+{tag}@...`,
 * so a test can wait for its own sample.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitWithInfo(request, "send-test-email", 10);
  if (rateLimit.response) return rateLimit.response;

  const env = serverEnv();
  if (!env.MAIL_INGEST_URL) {
    return applyRateLimitHeaders(
      Response.json({ error: "Test emails are not available on this server" }, { status: 503 }),
      rateLimit
    );
  }

  let slug: unknown;
  let tag: unknown;
  try {
    ({ slug, tag } = (await request.json()) as { slug?: unknown; tag?: unknown });
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) {
    return Response.json({ error: "Invalid slug" }, { status: 400 });
  }
  if (tag !== undefined && (typeof tag !== "string" || !isValidEmailTag(tag, slug))) {
    return Response.json({ error: "Invalid tag" }, { status: 400 });
  }

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access) {
    return Response.json({ error: "Endpoint not found" }, { status: 404 });
  }

  const local = tag === undefined ? slug.toLowerCase() : `${slug.toLowerCase()}+${tag}`;
  const to = `${local}@${env.EMAIL_CAPTURE_DOMAIN}`;
  const now = new Date();
  const { raw } = buildTestEmail({ to, appUrl: publicEnv().NEXT_PUBLIC_APP_URL, now });
  const body = testDeliveryBody({ to, raw, now });
  const timestamp = Math.floor(now.getTime() / 1000);

  let status: string | undefined;
  let requestId: string | undefined;
  try {
    const upstream = await fetch(`${env.MAIL_INGEST_URL.replace(/\/$/, "")}${DELIVER_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mail-timestamp": String(timestamp),
        "x-mail-signature": signMailRequest(
          env.CAPTURE_SHARED_SECRET,
          timestamp,
          "POST",
          DELIVER_PATH,
          body
        ),
      },
      body,
      signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
    });
    if (upstream.ok) {
      const data = (await upstream.json()) as {
        results?: { status?: string; request_id?: string }[];
      };
      status = data.results?.[0]?.status;
      requestId = data.results?.[0]?.request_id;
    } else {
      console.error("[send-test-email] receiver answered", upstream.status);
    }
  } catch (error) {
    console.error("[send-test-email] delivery failed:", error);
  }

  const reply = (payload: Record<string, unknown>, init?: ResponseInit) =>
    applyRateLimitHeaders(Response.json(payload, init), rateLimit);

  switch (status) {
    case "captured":
    case "duplicate":
      return reply({ status: "captured", requestId: requestId ?? null });
    case "over_quota":
      return reply(
        { error: "This endpoint's monthly requests are used up, so it cannot take the test email" },
        { status: 409 }
      );
    case "guest":
      return reply({ error: "Only endpoints on an account can receive email" }, { status: 400 });
    case "expired":
      return reply({ error: "This endpoint has expired" }, { status: 410 });
    default:
      return reply({ error: "The test email could not be delivered. Try again." }, { status: 502 });
  }
}
