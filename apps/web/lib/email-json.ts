import type { EmailAddress, EmailCapture } from "@/lib/email-capture";
import { extractFromEmail } from "@/lib/email-extract";

/**
 * A captured email as JSON: what the dashboard's JSON tab shows and exactly
 * the body forwarding POSTs to the endpoint's URL (lib/forwarding). One
 * builder for both, so a handler written against the tab receives the same
 * thing. Documented at /docs/forwarding; change it in step with the docs.
 */

export const EMAIL_RECEIVED = "email.received";

export interface EmailJsonLink {
  url: string;
  /** The link's text, when it came from the HTML. */
  text: string | null;
}

export interface EmailJsonData {
  /** The request id; also the webhook-id of every forwarded copy. */
  id: string;
  endpoint: { slug: string; name: string | null };
  receivedAt: string;
  /** The address the email arrived at, tag included. */
  address: string;
  tag: string | null;
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  date: string | null;
  messageId: string | null;
  inReplyTo: string[];
  text: string | null;
  html: string | null;
  /** One-time codes and links found in the email, unless the endpoint turned that off. */
  codes?: string[];
  links?: EmailJsonLink[];
  attachments: {
    filename: string | null;
    contentType: string;
    size: number;
    contentId: string | null;
    inline: boolean;
  }[];
  /** Sender check verdicts ("pass", "fail", ...), null when a check did not run. */
  auth: { spf: string | null; dkim: string | null; dmarc: string | null; tls: string | null };
  headers: Record<string, string>;
  /** Size of the whole message as received, in bytes. */
  size: number;
  /** Text and HTML parts are kept up to 256 KB each. */
  truncated: { text: boolean; html: boolean };
  /** The dashboard's "Send test email" sample, not real mail. */
  test: boolean;
}

export interface EmailJson {
  type: typeof EMAIL_RECEIVED;
  /** When the email arrived; the same on every forwarded copy. */
  timestamp: string;
  data: EmailJsonData;
}

export interface EmailJsonSource {
  id: string;
  /** Milliseconds since the epoch. */
  receivedAt: number;
  /** For emails, the recipient address. */
  path: string;
  size: number;
  headers: Record<string, string>;
  email: EmailCapture;
}

/** The DKIM verdict across signatures: a pass wins, otherwise the first result. */
function dkimVerdict(email: EmailCapture): string | null {
  const results = email.auth?.dkim ?? [];
  if (results.some((check) => check.result === "pass")) return "pass";
  return results[0]?.result ?? null;
}

export function buildEmailJson(
  request: EmailJsonSource,
  endpoint: { slug: string; name: string | null | undefined },
  options: { includeExtracts: boolean }
): EmailJson {
  const { email } = request;
  const receivedAt = new Date(request.receivedAt).toISOString();
  const extracts = options.includeExtracts ? extractFromEmail(email) : null;
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
