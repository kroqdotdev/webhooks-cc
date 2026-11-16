import { createHmac } from "node:crypto";
import {
  buildEmailJson,
  inboundEmailPayload,
  inboundEmailPayloadBytes,
  INBOUND_EMAIL_FORMATS,
  isInboundEmailFormat,
} from "@webhooks-cc/sdk/email";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { jsonObject } from "@/lib/forwarding/destination-routes";
import { withAttachmentPayloads } from "@/lib/forwarding/attachments";
import { FORWARD_USER_AGENT } from "@/lib/forwarding/sign";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
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
 *
 * The body is text by default, so SendGrid and Mailgun forms leave binary
 * attachments out. With `bodyEncoding: "base64"` it is the exact bytes in
 * base64 (and the answer says `bodyEncoding: "base64"`), and those forms
 * carry every file with its real contents, as the providers post them.
 * Older clients never send it, so their answers stay as they were.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  // Per account, not per address: Zapier and Make send every customer's
  // calls from a few shared addresses.
  const rateLimit = await checkRateLimitByKeyWithInfo(`user:email-render:${auth.userId}`, 120);
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
  const bodyEncoding = body.bodyEncoding;
  if (bodyEncoding !== undefined && bodyEncoding !== null && bodyEncoding !== "base64") {
    return reply({ error: 'bodyEncoding must be "base64" when given.' }, 400);
  }
  const base64 = bodyEncoding === "base64";
  if (!isUuid(id)) return reply({ error: "not_found", message: "Request not found" }, 404);

  try {
    const captured = await getRequestByIdForUser(auth.userId, id);
    if (!captured) return reply({ error: "not_found", message: "Request not found" }, 404);
    if (captured.kind !== "email" || !captured.email) {
      return reply({ error: "Only a captured email can be rendered in a provider's shape." }, 400);
    }
    if (format === "json") {
      // With attachment links, as a destination's default sends them, so a
      // sample has every field a delivery has.
      const withLinks = await withAttachmentPayloads(captured, "links");
      const [withFields] = await withEmailExtracts([withLinks]);
      const { data: endpoint } = await createAdminClient()
        .from("endpoints")
        .select("slug, name")
        .eq("id", captured.endpointId)
        .maybeSingle();
      const json = buildEmailJson(
        { ...withLinks, email: withLinks.email! },
        { slug: endpoint?.slug ?? "", name: endpoint?.name ?? null },
        {
          includeExtracts: withFields.extracts !== null,
          fields: withFields.emailFields ?? null,
          parsed: captured.parsed ?? null,
        }
      );
      const text = JSON.stringify(json);
      return reply({
        format,
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": FORWARD_USER_AGENT },
        ...(base64
          ? { body: Buffer.from(text, "utf8").toString("base64"), bodyEncoding: "base64" }
          : { body: text }),
      });
    }
    // With the attachments' contents (up to the inline budget of a
    // delivery, the rest as links), so the shapes carry the files as the
    // providers post them.
    // A storage read that fails renders the email with links instead of
    // failing the whole answer.
    const withFiles = await withAttachmentPayloads(captured, "inline").catch((error) => {
      reportError("Could not read an email's attachments for a render", error);
      return withAttachmentPayloads(captured, "links").catch(() => captured);
    });
    const source = { ...withFiles, email: withFiles.email ?? captured.email };
    const options = {
      raw: captured.bodyRaw ? null : (captured.body ?? null),
      mailgunSigningKey: typeof key === "string" && key ? key : null,
      hmacSha256Hex: (secret: string, message: string) =>
        createHmac("sha256", secret).update(message).digest("hex"),
    };
    if (base64) {
      const payload = inboundEmailPayloadBytes(format, source, options);
      return reply({
        format,
        method: "POST",
        headers: { "content-type": payload.contentType, "user-agent": FORWARD_USER_AGENT },
        body: Buffer.from(payload.body).toString("base64"),
        bodyEncoding: "base64",
      });
    }
    const payload = inboundEmailPayload(format, source, options);
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
