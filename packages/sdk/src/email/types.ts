/**
 * Captured emails: every endpoint on an account also receives email at
 * `{slug}@mailhooks.cc` (and `{slug}+{tag}@mailhooks.cc`). An email is
 * stored as a request with `kind: "email"`, `method: "EMAIL"`, the recipient
 * address as `path`, the raw message as `body`, and the parsed message as
 * `email`. These types describe that parsed message and the JSON that
 * forwarding posts to your server (`email.received`).
 *
 * This module imports nothing, so `@webhooks-cc/sdk/email` stays small
 * enough for a browser bundle.
 */

/** "http" for webhooks, "email" for captured emails. */
export type RequestKind = "http" | "email";

export interface EmailAddress {
  name: string | null;
  address: string | null;
}

export interface EmailAttachment {
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface EmailCheck {
  /** "pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "skipped" ... */
  result: string;
  domain: string | null;
}

export interface EmailAuth {
  spf: EmailCheck | null;
  dkim: (EmailCheck & { selector: string | null })[];
  dmarc: (EmailCheck & { policy: string | null; reason: string | null }) | null;
  /** Reverse DNS of the sending server, checked name by name. */
  iprev: { result: string; ptr: string | null } | null;
  /** The Authentication-Results header the mail server wrote. */
  authenticationResults: string | null;
  /** Set when the checks could not run ("unavailable", "timeout", "busy", "failed"). */
  error: string | null;
}

export interface EmailSmtp {
  clientIp: string | null;
  clientRdns: string | null;
  helo: string | null;
  tls: { version: string | null; cipher: string | null } | null;
  envelopeFrom: string | null;
  envelopeTo: string[];
  /** Size of the whole message as received, in bytes. */
  size: number | null;
  /** The dashboard's (or `emails.sendTest()`'s) sample, not real mail. */
  test: boolean;
}

/** A captured email, parsed. The `email` field of a request with `kind: "email"`. */
export interface EmailCapture {
  subject: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  sender: EmailAddress[];
  date: string | null;
  messageId: string | null;
  inReplyTo: string[];
  /** The `+tag` of the address it was sent to, if any. */
  tag: string | null;
  text: string | null;
  html: string | null;
  /** The text part was missing and `text` was derived from the HTML. */
  textFromHtml: boolean;
  attachments: EmailAttachment[];
  auth: EmailAuth | null;
  smtp: EmailSmtp | null;
  parseError: boolean;
  truncated: {
    raw: boolean;
    text: boolean;
    html: boolean;
    headers: boolean;
    addresses: boolean;
    attachments: boolean;
  };
}

/** A link found in an email. */
export interface ExtractedLink {
  url: string;
  /** The link text, when the link came from HTML. */
  label: string | null;
  /** Looks like the thing the email asks you to click (confirm, verify, reset, sign in). */
  action: boolean;
}

/** One-time codes and links found in an email, best first. */
export interface EmailExtracts {
  codes: string[];
  links: ExtractedLink[];
}

/** The `type` of every forwarded email. */
export const EMAIL_RECEIVED = "email.received";

export interface EmailReceivedLink {
  url: string;
  /** The link's text, when it came from the HTML. */
  text: string | null;
}

/** The `data` of an `email.received` event. */
export interface EmailReceivedData {
  /** The request id; also the webhook-id of every forwarded copy (`msg_` + id without dashes). */
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
  /** One-time codes found in the email. Left out when the endpoint turned that off. */
  codes?: string[];
  /** Links found in the email. Left out when the endpoint turned that off. */
  links?: EmailReceivedLink[];
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
  /** A sample (Send test email, or a test delivery while no email had arrived), not real mail. */
  test: boolean;
}

/**
 * The JSON forwarding posts to your server for every captured email, and
 * what each email's JSON tab in the dashboard shows.
 */
export interface EmailReceivedEvent {
  type: typeof EMAIL_RECEIVED;
  /** When the email arrived; the same on every forwarded copy. */
  timestamp: string;
  data: EmailReceivedData;
}

/** What `buildEmailJson()` needs from a captured email request. */
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
