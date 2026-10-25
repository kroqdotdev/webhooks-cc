import { createHmac } from "node:crypto";
import {
  buildEmailJson,
  inboundEmailPayload,
  INBOUND_EMAIL_FORMATS,
  isInboundEmailFormat,
} from "@webhooks-cc/sdk/email";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { jsonObject } from "@/lib/forwarding/destination-routes";
import { FORWARD_USER_AGENT } from "@/lib/forwarding/sign";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { getRequestByIdForUser, withEmailExtracts } from "@/lib/supabase/requests";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

/**
 * A captured email in the shape an inbound mail provider posts it
 * (`{ "format": "postmark" | "sendgrid" | "mailgun" | "cloudmailin" }`,
 * with `mailgunSigningKey` to sign a Mailgun form), or as webhooks.cc's own
 * `email.received` JSON (`"json"`, unsigned, with the endpoint's fields):
 * the method, headers and body to send to a handler. The CLI's tunnel and
 * the SDKs in other languages use it, so the shapes are built in one place
 * (packages/sdk/src/email/inbound.ts). Anyone who can read the email may.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "email-render", 120);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(
      Response.json(body, { status, headers: { "cache-control": "no-store" } }),
      rateLimit
    );

  const body = await jsonObject(request);
  if (body instanceof Response) return applyRateLimitHeaders(body, rateLimit);
  const format = body.format;
  if (format !== "json" && !isInboundEmailFormat(format)) {
    return reply(
      { error: `format must be one of json, ${INBOUND_EMAIL_FORMATS.join(", ")}.` },
      400
    );
  }
  const key = body.mailgunSigningKey;
  if (key !== undefined && key !== null && (typeof key !== "string" || key.length > 200)) {
    return reply({ error: "mailgunSigningKey is text of at most 200 characters." }, 400);
  }
  if (!isUuid(id)) return reply({ error: "not_found" }, 404);

  try {
    const captured = await getRequestByIdForUser(auth.userId, id);
    if (!captured) return reply({ error: "not_found" }, 404);
    if (captured.kind !== "email" || !captured.email) {
      return reply({ error: "Only a captured email can be rendered in a provider's shape." }, 400);
    }
    if (format === "json") {
      const [withFields] = await withEmailExtracts([captured]);
      const { data: endpoint } = await createAdminClient()
        .from("endpoints")
        .select("slug, name")
        .eq("id", captured.endpointId)
        .maybeSingle();
      const json = buildEmailJson(
        { ...captured, email: captured.email },
        { slug: endpoint?.slug ?? "", name: endpoint?.name ?? null },
        { includeExtracts: withFields.extracts !== null, fields: withFields.emailFields ?? null }
      );
      return reply({
        format,
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": FORWARD_USER_AGENT },
        body: JSON.stringify(json),
      });
    }
    const payload = inboundEmailPayload(
      format,
      { ...captured, email: captured.email },
      {
        raw: captured.bodyRaw ? null : (captured.body ?? null),
        mailgunSigningKey: typeof key === "string" && key ? key : null,
        hmacSha256Hex: (secret, message) =>
          createHmac("sha256", secret).update(message).digest("hex"),
      }
    );
    return reply({
      format,
      method: "POST",
      headers: { "content-type": payload.contentType, "user-agent": FORWARD_USER_AGENT },
      body: payload.body,
    });
  } catch (error) {
    reportError("Failed to render an email", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
