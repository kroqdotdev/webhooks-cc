import type { Json } from "@/lib/supabase/database";

/**
 * Captured emails as the API and the dashboard see them.
 *
 * The receiver stores each email as a request with `kind = 'email'` and the
 * parsed message in `requests.email` (snake_case JSON, see
 * apps/receiver-rs/src/mail/parse.rs and handlers.rs; the authentication
 * results come from the MX host, apps/mx-rs/src/auth_check.rs). This module
 * turns that JSON into camelCase types and never trusts its shape: anything
 * missing or malformed becomes null or an empty list.
 */

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
  /** The Authentication-Results header the MX host wrote. */
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
  /**
   * The dashboard's own "Send test email" sample. Set by the receiver only
   * for that signed delivery, never from anything in the message.
   */
  test: boolean;
}

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

/** What a list row needs, without the message body. */
export interface EmailSummary {
  subject: string | null;
  from: EmailAddress | null;
  tag: string | null;
  attachmentCount: number;
}

type JsonObject = { [key: string]: Json | undefined };

function asObject(value: Json | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStrings(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asAddresses(value: Json | undefined): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  const out: EmailAddress[] = [];
  for (const item of value) {
    const entry = asObject(item);
    if (!entry) continue;
    const name = asString(entry.name);
    const address = asString(entry.address);
    if (name === null && address === null) continue;
    out.push({ name, address });
  }
  return out;
}

function asAttachments(value: Json | undefined): EmailAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: EmailAttachment[] = [];
  for (const item of value) {
    const entry = asObject(item);
    if (!entry) continue;
    out.push({
      filename: asString(entry.filename),
      contentType: asString(entry.content_type) ?? "application/octet-stream",
      size: asNumber(entry.size) ?? 0,
      contentId: asString(entry.content_id),
      inline: entry.inline === true,
    });
  }
  return out;
}

function asCheck(value: Json | undefined): EmailCheck | null {
  const entry = asObject(value);
  const result = entry ? asString(entry.result) : null;
  if (!entry || result === null) return null;
  return { result, domain: asString(entry.domain) };
}

function asAuth(value: Json | undefined): EmailAuth | null {
  const auth = asObject(value);
  if (!auth) return null;
  const dmarc = asObject(auth.dmarc);
  const dmarcCheck = asCheck(auth.dmarc);
  const iprev = asObject(auth.iprev);
  const iprevResult = iprev ? asString(iprev.result) : null;
  return {
    spf: asCheck(auth.spf),
    dkim: Array.isArray(auth.dkim)
      ? auth.dkim.flatMap((item) => {
          const check = asCheck(item);
          const entry = asObject(item);
          return check && entry ? [{ ...check, selector: asString(entry.selector) }] : [];
        })
      : [],
    dmarc:
      dmarc && dmarcCheck
        ? { ...dmarcCheck, policy: asString(dmarc.policy), reason: asString(dmarc.reason) }
        : null,
    iprev: iprev && iprevResult !== null ? { result: iprevResult, ptr: asString(iprev.ptr) } : null,
    authenticationResults: asString(auth.authentication_results),
    error: asString(auth.error),
  };
}

function asSmtp(value: Json | undefined): EmailSmtp | null {
  const smtp = asObject(value);
  if (!smtp) return null;
  const tls = asObject(smtp.tls);
  return {
    clientIp: asString(smtp.client_ip),
    clientRdns: asString(smtp.client_rdns),
    helo: asString(smtp.helo),
    tls: tls ? { version: asString(tls.version), cipher: asString(tls.cipher) } : null,
    envelopeFrom: asString(smtp.envelope_from),
    envelopeTo: asStrings(smtp.envelope_to),
    size: asNumber(smtp.size),
    test: smtp.test === true,
  };
}

/** The stored `requests.email` JSON as an `EmailCapture`, or null if it is not an object. */
export function toEmailCapture(value: Json | null | undefined): EmailCapture | null {
  const doc = asObject(value ?? undefined);
  if (!doc) return null;
  return {
    subject: asString(doc.subject),
    from: asAddresses(doc.from),
    to: asAddresses(doc.to),
    cc: asAddresses(doc.cc),
    replyTo: asAddresses(doc.reply_to),
    sender: asAddresses(doc.sender),
    date: asString(doc.date),
    messageId: asString(doc.message_id),
    inReplyTo: asStrings(doc.in_reply_to),
    tag: asString(doc.tag),
    text: asString(doc.text),
    html: asString(doc.html),
    textFromHtml: doc.text_from_html === true,
    attachments: asAttachments(doc.attachments),
    auth: asAuth(doc.auth),
    smtp: asSmtp(doc.smtp),
    parseError: doc.parse_error === true,
    truncated: {
      raw: doc.raw_truncated === true,
      text: doc.text_truncated === true,
      html: doc.html_truncated === true,
      headers: doc.headers_oversized === true,
      addresses: doc.addresses_truncated === true,
      attachments: doc.attachments_truncated === true,
    },
  };
}

export function toEmailSummary(capture: EmailCapture | null): EmailSummary | null {
  if (!capture) return null;
  return {
    subject: capture.subject,
    from: capture.from[0] ?? capture.sender[0] ?? null,
    tag: capture.tag,
    attachmentCount: capture.attachments.filter((attachment) => !attachment.inline).length,
  };
}
