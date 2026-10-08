import { extractFromEmail } from "./extract";
import {
  EMAIL_RECEIVED,
  type EmailCapture,
  type EmailJsonSource,
  type EmailReceivedEvent,
} from "./types";

/**
 * A captured email as JSON: what the dashboard's JSON tab shows and exactly
 * the body forwarding posts to an endpoint's URL. The web app builds both
 * with this function, so a handler written against the tab receives the
 * same thing. Documented at https://webhooks.cc/docs/forwarding; change it
 * in step with the docs.
 */

/** The DKIM verdict across signatures: a pass wins, otherwise the first result. */
function dkimVerdict(email: EmailCapture): string | null {
  const results = email.auth?.dkim ?? [];
  if (results.some((check) => check.result === "pass")) return "pass";
  return results[0]?.result ?? null;
}

/**
 * Builds the `email.received` JSON for a captured email request.
 *
 * `includeExtracts` (default true) adds the one-time `codes` and `links`;
 * forwarding leaves them out when the endpoint turned off "Show codes and
 * links found in emails".
 */
export function buildEmailJson(
  request: EmailJsonSource,
  endpoint: { slug: string; name?: string | null },
  options: { includeExtracts?: boolean } = {}
): EmailReceivedEvent {
  const { email } = request;
  const receivedDate = new Date(request.receivedAt);
  if (!Number.isFinite(request.receivedAt) || Number.isNaN(receivedDate.getTime())) {
    throw new TypeError("buildEmailJson: receivedAt must be a valid millisecond timestamp");
  }
  const receivedAt = receivedDate.toISOString();
  const extracts = options.includeExtracts !== false ? extractFromEmail(email) : null;
  return {
    type: EMAIL_RECEIVED,
    timestamp: receivedAt,
    data: {
      id: request.id,
      endpoint: { slug: endpoint.slug, name: endpoint.name ?? null },
      receivedAt,
      address: request.path,
      tag: email.tag,
      subject: email.subject,
      from: email.from[0] ?? null,
      to: email.to,
      cc: email.cc,
      replyTo: email.replyTo,
      date: email.date,
      messageId: email.messageId,
      inReplyTo: email.inReplyTo,
      text: email.text,
      html: email.html,
      ...(extracts
        ? {
            codes: extracts.codes,
            links: extracts.links.map((link) => ({ url: link.url, text: link.label })),
          }
        : {}),
      attachments: email.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        contentId: attachment.contentId,
        inline: attachment.inline,
      })),
      auth: {
        spf: email.auth?.spf?.result ?? null,
        dkim: dkimVerdict(email),
        dmarc: email.auth?.dmarc?.result ?? null,
        tls: email.smtp?.tls?.version ?? null,
      },
      headers: request.headers,
      size: email.smtp?.size ?? request.size,
      truncated: { text: email.truncated.text, html: email.truncated.html },
      test: email.smtp?.test === true,
    },
  };
}
