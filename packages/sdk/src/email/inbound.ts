import { htmlToText } from "./extract";
import { parseReply } from "./reply";
import type { EmailAddress, EmailJsonSource } from "./types";

/**
 * A captured email in the shape an inbound mail provider posts it, so a
 * handler written for that provider can be tested against real mail:
 * Postmark's inbound JSON, SendGrid's Inbound Parse form, a Mailgun route's
 * form (signed when you give your Mailgun signing key) and CloudMailin's
 * JSON Normalized format.
 *
 * Attachment contents are never stored, so none of these carry attachment
 * files; the email's JSON lists them. The text and HTML are those webhooks.cc
 * kept (up to 256 KB each).
 */

export const INBOUND_EMAIL_FORMATS = ["postmark", "sendgrid", "mailgun", "cloudmailin"] as const;
export type InboundEmailFormat = (typeof INBOUND_EMAIL_FORMATS)[number];

/** What each format is called, for people. */
export const INBOUND_EMAIL_FORMAT_NAMES: Record<InboundEmailFormat, string> = {
  postmark: "Postmark inbound",
  sendgrid: "SendGrid Inbound Parse",
  mailgun: "Mailgun route",
  cloudmailin: "CloudMailin JSON",
};

export function isInboundEmailFormat(value: unknown): value is InboundEmailFormat {
  return typeof value === "string" && (INBOUND_EMAIL_FORMATS as readonly string[]).includes(value);
}

/** A rendered body and its content type. */
export interface InboundEmailPayload {
  contentType: string;
  body: string;
}

export interface InboundEmailOptions {
  /** The raw message (the request's body), for the exact header block; the stored headers otherwise. */
  raw?: string | null;
  /** Mailgun: your account's HTTP webhook signing key, to sign `signature` as Mailgun does. */
  mailgunSigningKey?: string | null;
  /** The time to sign with, in milliseconds (default: now). */
  now?: number;
  /** Mailgun's 50-character token and the multipart boundary; random by default (for tests). */
  token?: string;
  boundary?: string;
}

const MAX_HEADERS = 200;

// Names whose usual spelling title case does not give.
const HEADER_SPELLING: Record<string, string> = {
  "message-id": "Message-ID",
  "mime-version": "MIME-Version",
  "dkim-signature": "DKIM-Signature",
  "content-id": "Content-ID",
  "arc-seal": "ARC-Seal",
  "arc-message-signature": "ARC-Message-Signature",
  "arc-authentication-results": "ARC-Authentication-Results",
};

function titleCase(name: string): string {
  return (
    HEADER_SPELLING[name] ??
    name.replace(/(^|-)([a-z])/g, (_match, dash: string, ch: string) => dash + ch.toUpperCase())
  );
}

/**
 * The message's headers in order with their own spelling, from the raw
 * header block; from the stored map (lower case, repeats joined by line
 * breaks) when the raw message is not at hand.
 */
export function emailHeaderList(source: EmailJsonSource, raw?: string | null): [string, string][] {
  if (raw) {
    const end = raw.search(/\r?\n\r?\n/);
    const block = (end >= 0 ? raw.slice(0, end) : raw).slice(0, 256 * 1024);
    const out: [string, string][] = [];
    for (const line of block.split(/\r?\n/)) {
      if (out.length > 0 && (line.startsWith(" ") || line.startsWith("\t"))) {
        out[out.length - 1][1] += ` ${line.trim()}`;
        continue;
      }
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      if (out.length >= MAX_HEADERS) break;
      out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    if (out.length > 0) return out;
  }
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(source.headers)) {
    for (const one of value.split("\n")) {
      if (out.length >= MAX_HEADERS) return out;
      out.push([titleCase(name), one]);
    }
  }
  return out;
}

function formatAddress(address: EmailAddress): string {
  if (!address.address) return address.name ?? "";
  if (!address.name) return address.address;
  return `"${address.name.replace(/["\\]/g, "\\$&")}" <${address.address}>`;
}

function formatAddresses(addresses: EmailAddress[]): string {
  return addresses.map(formatAddress).filter(Boolean).join(", ");
}

/** Postmark's MailboxHash: the part of the local part after "+". */
function mailboxHash(address: string | null): string {
  const local = (address ?? "").split("@")[0] ?? "";
  const plus = local.indexOf("+");
  return plus >= 0 ? local.slice(plus + 1) : "";
}

function text(source: EmailJsonSource): string {
  const { email } = source;
  return email.text ?? (email.html ? htmlToText(email.html) : "");
}

/** The SPF, DKIM and spam results a provider would report, from what webhooks.cc recorded. */
function spamHeaders(source: EmailJsonSource): [string, string][] {
  const spam = source.email.spam;
  if (!spam || spam.score === null) return [];
  const flagged = spam.required !== null && spam.score >= spam.required;
  return [
    ["X-Spam-Status", flagged ? "Yes" : "No"],
    ["X-Spam-Score", String(spam.score)],
    ["X-Spam-Tests", spam.symbols.map((symbol) => symbol.name).join(",")],
  ];
}

function postmark(source: EmailJsonSource, raw?: string | null): InboundEmailPayload {
  const { email } = source;
  const reply = parseReply(text(source));
  const from = email.from[0] ?? { name: null, address: null };
  const full = (address: EmailAddress) => ({
    Email: address.address ?? "",
    Name: address.name ?? "",
    MailboxHash: mailboxHash(address.address),
  });
  const headers = emailHeaderList(source, raw).filter(
    ([name]) => !/^(from|to|cc|bcc|subject|date|reply-to)$/i.test(name)
  );
  const body = {
    FromName: from.name ?? "",
    MessageStream: "inbound",
    From: from.address ?? "",
    FromFull: full(from),
    To: source.headers.to ?? formatAddresses(email.to),
    ToFull: email.to.map(full),
    Cc: source.headers.cc ?? formatAddresses(email.cc),
    CcFull: email.cc.map(full),
    Bcc: "",
    BccFull: [],
    OriginalRecipient: source.path,
    Subject: email.subject ?? "",
    MessageID: source.id,
    ReplyTo: formatAddresses(email.replyTo),
    MailboxHash: email.tag ?? "",
    // The header as written (RFC 2822), as Postmark sends it; the parsed date is ISO.
    Date: source.headers.date ?? email.date ?? "",
    TextBody: email.text ?? "",
    HtmlBody: email.html ?? "",
    StrippedTextReply: reply.quoted ? reply.text : "",
    Tag: "",
    Headers: [...headers, ...spamHeaders(source)].map(([Name, Value]) => ({ Name, Value })),
    Attachments: [],
  };
  return { contentType: "application/json", body: JSON.stringify(body) };
}

function cloudmailin(source: EmailJsonSource, raw?: string | null): InboundEmailPayload {
  const { email } = source;
  const reply = parseReply(text(source));
  // No prototype: a sender's header named "constructor" or "__proto__" is just a key.
  const headers = Object.create(null) as Record<string, string | string[]>;
  for (const [name, value] of emailHeaderList(source, raw)) {
    const key = name.toLowerCase().replace(/-/g, "_");
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else headers[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  const smtp = email.smtp;
  const spf = email.auth?.spf;
  const body: Record<string, unknown> = {
    headers,
    envelope: {
      to: source.path,
      recipients: smtp?.envelopeTo.length ? smtp.envelopeTo : [source.path],
      from: smtp?.envelopeFrom ?? email.from[0]?.address ?? "",
      helo_domain: smtp?.helo ?? "",
      remote_ip: smtp?.clientIp ?? "",
      spf: { result: spf?.result ?? "none", domain: spf?.domain ?? "" },
      tls: Boolean(smtp?.tls?.version),
    },
    plain: text(source),
    ...(email.html ? { html: email.html } : {}),
    ...(reply.quoted && reply.text ? { reply_plain: reply.text } : {}),
    attachments: [],
  };
  return { contentType: "application/json", body: JSON.stringify(body) };
}

function randomString(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/** A multipart/form-data body of text fields. */
function multipart(fields: [string, string][], boundary: string): InboundEmailPayload {
  const parts = fields.map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: `${parts.join("")}--${boundary}--\r\n`,
  };
}

function sendgrid(source: EmailJsonSource, options: InboundEmailOptions): InboundEmailPayload {
  const { email } = source;
  const smtp = email.smtp;
  const headerBlock = emailHeaderList(source, options.raw)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  const dkim = (email.auth?.dkim ?? [])
    .map((check) => `@${check.domain ?? ""} : ${check.result}`)
    .join(", ");
  const spam = email.spam;
  const fields: [string, string][] = [
    ["headers", headerBlock],
    ["dkim", dkim ? `{${dkim}}` : "{}"],
    ["to", source.headers.to ?? formatAddresses(email.to)],
    ["from", source.headers.from ?? formatAddresses(email.from)],
    ["text", email.text ?? ""],
  ];
  if (email.html) fields.push(["html", email.html]);
  fields.push(["sender_ip", smtp?.clientIp ?? ""]);
  if (spam && spam.score !== null) {
    fields.push([
      "spam_report",
      `Scored by rspamd on webhooks.cc: ${spam.score} (required ${spam.required ?? "unknown"}).\n` +
        spam.symbols.map((symbol) => `${symbol.score} ${symbol.name}`).join("\n"),
    ]);
    fields.push(["spam_score", String(spam.score)]);
  }
  fields.push(
    [
      "envelope",
      JSON.stringify({
        to: smtp?.envelopeTo.length ? smtp.envelopeTo : [source.path],
        from: smtp?.envelopeFrom ?? email.from[0]?.address ?? "",
      }),
    ],
    ["attachments", "0"],
    [
      "charsets",
      JSON.stringify({
        to: "UTF-8",
        from: "UTF-8",
        subject: "UTF-8",
        text: "UTF-8",
        ...(email.html ? { html: "UTF-8" } : {}),
      }),
    ],
    ["SPF", email.auth?.spf?.result ?? "none"],
    ["subject", email.subject ?? ""]
  );
  return multipart(fields, options.boundary ?? `xYzZY${randomString(24)}`);
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

function mailgun(source: EmailJsonSource, options: InboundSyncOptions): InboundEmailPayload {
  const { email } = source;
  const reply = parseReply(text(source));
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000));
  const token = options.token ?? randomString(50);
  let signature = "";
  if (options.mailgunSigningKey) {
    if (!options.hmacSha256Hex) {
      throw new Error("inboundEmailPayload: signing a Mailgun form needs hmacSha256Hex");
    }
    signature = options.hmacSha256Hex(options.mailgunSigningKey, timestamp + token);
  }
  const params = new URLSearchParams();
  params.set("recipient", source.path);
  params.set("sender", email.smtp?.envelopeFrom ?? email.from[0]?.address ?? "");
  params.set("from", source.headers.from ?? formatAddresses(email.from));
  params.set("subject", email.subject ?? "");
  params.set("body-plain", text(source));
  if (email.html) params.set("body-html", email.html);
  params.set("stripped-text", reply.text);
  if (reply.signature) params.set("stripped-signature", reply.signature);
  params.set("message-headers", JSON.stringify(emailHeaderList(source, options.raw)));
  params.set("timestamp", timestamp);
  params.set("token", token);
  params.set("signature", signature);
  return { contentType: "application/x-www-form-urlencoded", body: params.toString() };
}

/** For `inboundEmailPayload()`: a synchronous HMAC-SHA256, hex, to sign a Mailgun form with. */
export interface InboundSyncOptions extends InboundEmailOptions {
  hmacSha256Hex?: (key: string, message: string) => string;
}

/**
 * The email in `format`'s shape, built synchronously; a Mailgun form with a
 * signing key needs `hmacSha256Hex` (Node's createHmac, say).
 */
export function inboundEmailPayload(
  format: InboundEmailFormat,
  source: EmailJsonSource,
  options: InboundSyncOptions = {}
): InboundEmailPayload {
  switch (format) {
    case "postmark":
      return postmark(source, options.raw);
    case "cloudmailin":
      return cloudmailin(source, options.raw);
    case "sendgrid":
      return sendgrid(source, options);
    case "mailgun":
      return mailgun(source, options);
  }
}

/** The email in `format`'s shape, a Mailgun form signed with Web Crypto. */
export async function renderInboundEmail(
  format: InboundEmailFormat,
  source: EmailJsonSource,
  options: InboundEmailOptions = {}
): Promise<InboundEmailPayload> {
  if (format !== "mailgun" || !options.mailgunSigningKey) {
    return inboundEmailPayload(format, source, options);
  }
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000));
  const token = options.token ?? randomString(50);
  const signature = await hmacSha256Hex(options.mailgunSigningKey, timestamp + token);
  return inboundEmailPayload(format, source, {
    ...options,
    now: Number(timestamp) * 1000,
    token,
    hmacSha256Hex: () => signature,
  });
}
