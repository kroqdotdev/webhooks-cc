import type {
  EmailAddress,
  EmailArc,
  EmailAttachment,
  EmailAuth,
  EmailCapture,
  EmailCheck,
  EmailDkimKey,
  EmailDmarcRecord,
  EmailSenderSetup,
  EmailSmtp,
  EmailSpam,
  EmailSpfRecord,
} from "@webhooks-cc/sdk/email";
import type { Json } from "@/lib/supabase/database";

/**
 * Captured emails as the API and the dashboard see them.
 *
 * The receiver stores each email as a request with `kind = 'email'` and the
 * parsed message in `requests.email` (snake_case JSON, see
 * apps/receiver-rs/src/mail/parse.rs and handlers.rs; the authentication
 * results and the spam verdict come from the MX host, apps/mx-rs/src/auth_check.rs
 * and spam_check.rs). This module
 * turns that JSON into the SDK's camelCase types (@webhooks-cc/sdk/email, the
 * public shape of an email in the API) and never trusts its shape: anything
 * missing or malformed becomes null or an empty list.
 */

export type {
  EmailAddress,
  EmailAttachment,
  EmailCheck,
  EmailAuth,
  EmailSmtp,
  EmailSpam,
  EmailCapture,
} from "@webhooks-cc/sdk/email";

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
        ? {
            ...dmarcCheck,
            policy: asString(dmarc.policy),
            reason: asString(dmarc.reason),
            spf: asString(dmarc.spf),
            dkim: asString(dmarc.dkim),
          }
        : null,
    iprev: iprev && iprevResult !== null ? { result: iprevResult, ptr: asString(iprev.ptr) } : null,
    authenticationResults: asString(auth.authentication_results),
    arc: asArc(auth.arc),
    setup: asSetup(auth.setup),
    error: asString(auth.error),
  };
}

function asArc(value: Json | undefined): EmailArc | null {
  const arc = asObject(value);
  const result = arc ? asString(arc.result) : null;
  if (!arc || result === null) return null;
  return {
    result,
    sets: asNumber(arc.sets) ?? 0,
    sealers: asStrings(arc.sealers),
    reason: asString(arc.reason),
  };
}

function asSpfRecord(value: Json | undefined): EmailSpfRecord | null {
  const spf = asObject(value);
  if (!spf) return null;
  return {
    domain: asString(spf.domain),
    records: asNumber(spf.records) ?? 0,
    record: asString(spf.record),
    all: asString(spf.all),
    redirect: spf.redirect === true,
    lookups: asNumber(spf.lookups),
    lookupsCapped: spf.lookups_capped === true,
    ptr: spf.ptr === true,
    missingIncludes: asStrings(spf.missing_includes),
    duplicateIncludes: asStrings(spf.duplicate_includes),
    lookupsIncomplete: spf.lookups_incomplete === true,
    error: asString(spf.error),
  };
}

function asDmarcRecord(value: Json | undefined): EmailDmarcRecord | null {
  const dmarc = asObject(value);
  if (!dmarc) return null;
  return {
    p: asString(dmarc.p),
    sp: asString(dmarc.sp),
    adkim: asString(dmarc.adkim) ?? "relaxed",
    aspf: asString(dmarc.aspf) ?? "relaxed",
    rua: asStrings(dmarc.rua),
    ruf: asNumber(dmarc.ruf) ?? 0,
    testing: dmarc.testing === true,
  };
}

function asDkimKeys(value: Json | undefined): EmailDkimKey[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const key = asObject(item);
    const domain = key ? asString(key.domain) : null;
    const selector = key ? asString(key.selector) : null;
    if (!key || domain === null || selector === null) return [];
    return [
      {
        domain,
        selector,
        algorithm: asString(key.algorithm) ?? "rsa-sha256",
        key: asString(key.key),
        bits: asNumber(key.bits),
        revoked: key.revoked === true,
        error: asString(key.error),
      },
    ];
  });
}

function asSetup(value: Json | undefined): EmailSenderSetup | null {
  const setup = asObject(value);
  if (!setup) return null;
  const bimi = asObject(setup.bimi);
  const helo = asObject(setup.helo);
  const heloName = helo ? asString(helo.name) : null;
  return {
    spf: asSpfRecord(setup.spf),
    dmarc: asDmarcRecord(setup.dmarc),
    dkim: asDkimKeys(setup.dkim),
    bimi: bimi
      ? {
          found: bimi.found === true,
          domain: asString(bimi.domain),
          logo: bimi.logo === true,
          authority: bimi.authority === true,
          error: asString(bimi.error),
        }
      : null,
    helo:
      helo && heloName !== null
        ? {
            name: heloName,
            ipLiteral: helo.ip_literal === true,
            fqdn: helo.fqdn === true,
            resolves: helo.resolves === true,
            matchesPtr: helo.matches_ptr === true,
          }
        : null,
    error: asString(setup.error),
  };
}

function asSpam(value: Json | undefined): EmailSpam | null {
  const spam = asObject(value);
  if (!spam) return null;
  const symbols = Array.isArray(spam.symbols) ? spam.symbols : [];
  return {
    score: asNumber(spam.score),
    required: asNumber(spam.required),
    action: asString(spam.action),
    symbols: symbols.flatMap((item) => {
      const symbol = asObject(item);
      const name = symbol ? asString(symbol.name) : null;
      const score = symbol ? asNumber(symbol.score) : null;
      if (!symbol || name === null || score === null) return [];
      const options = asStrings(symbol.options);
      return [options.length > 0 ? { name, score, options } : { name, score }];
    }),
    error: asString(spam.error),
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
    spam: asSpam(doc.spam),
    smtp: asSmtp(doc.smtp),
    parseError: doc.parse_error === true,
    stored: doc.raw_stored === true,
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

/**
 * Whether `address` is at the capture domain or one of its subdomains. Mail
 * to those addresses can be read through webhooks.cc itself, so it proves
 * nothing about who controls the address.
 */
export function isCaptureDomainAddress(address: string, captureDomain: string): boolean {
  const at = address.lastIndexOf("@");
  if (at === -1) return false;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  const capture = captureDomain.toLowerCase().replace(/\.+$/, "");
  return domain === capture || domain.endsWith(`.${capture}`);
}
