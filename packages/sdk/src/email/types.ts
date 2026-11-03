import type { ParsedEmail } from "./layouts";
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
  /**
   * The decoded contents, base64; only in deliveries from a destination that
   * sends attachments inline, up to a size per delivery.
   */
  content?: string;
  /**
   * A signed link that downloads the attachment while the email is kept;
   * in deliveries, for attachments not sent inline.
   */
  url?: string;
}

export interface EmailCheck {
  /** "pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "skipped" ... */
  result: string;
  domain: string | null;
}

export interface EmailAuth {
  spf: EmailCheck | null;
  dkim: (EmailCheck & { selector: string | null })[];
  dmarc:
    | (EmailCheck & {
        policy: string | null;
        reason: string | null;
        /** Whether SPF passed for a domain aligned with the From domain ("pass", "fail", "none" ...). */
        spf?: string | null;
        /** Whether a DKIM signature passed for a domain aligned with the From domain. */
        dkim?: string | null;
      })
    | null;
  /** Reverse DNS of the sending server, checked name by name. */
  iprev: { result: string; ptr: string | null } | null;
  /** The Authentication-Results header the mail server wrote. */
  authenticationResults: string | null;
  /** The ARC chain of a forwarded email; null for mail captured before ARC was checked. */
  arc?: EmailArc | null;
  /** What the sender's DNS said about its setup when the email arrived; null for older mail. */
  setup?: EmailSenderSetup | null;
  /** Set when the checks could not run ("unavailable", "timeout", "busy", "failed"). */
  error: string | null;
}

/**
 * The ARC chain (RFC 8617): each server that forwarded the email (a mailing
 * list, a forwarding rule) may seal what it saw, so a receiver can trust
 * SPF and DKIM results the forwarding broke.
 */
export interface EmailArc {
  /** "pass", "fail", "neutral", "none" (no chain) or "skipped" ... */
  result: string;
  /** How many servers sealed the chain. */
  sets: number;
  /** The domains that sealed it, first hop first. */
  sealers: string[];
  /** Why the chain was not checked, when `result` is "skipped". */
  reason: string | null;
}

/** The sender domain's SPF record as published. */
export interface EmailSpfRecord {
  domain: string | null;
  /** SPF records found; more than one makes SPF fail. */
  records: number;
  /** The first record's text, cut at 512 characters. */
  record: string | null;
  /** The `all` that applies ("-all", "~all", "?all", "+all"), following a redirect; null for none. */
  all: string | null;
  redirect: boolean;
  /** DNS lookups the record takes, includes followed; more than 10 make SPF fail. */
  lookups: number | null;
  /** The count stopped before the end: there are at least `lookups`. */
  lookupsCapped: boolean;
  /** The record (or one it includes) uses the deprecated `ptr` mechanism. */
  ptr: boolean;
  /** Included domains that publish no SPF record (at most 3): a permerror when reached. */
  missingIncludes: string[];
  /** Included or redirected domains that publish more than one SPF record (at most 3): also a permerror. */
  duplicateIncludes: string[];
  /** A nested lookup failed, so `lookups` is short by what that domain would add. */
  lookupsIncomplete: boolean;
  /** Set when the record could not be looked up. */
  error: string | null;
}

/** The DMARC record that applied to the From domain. */
export interface EmailDmarcRecord {
  /** "none", "quarantine" or "reject"; null when the record has no policy. */
  p: string | null;
  /** The policy for subdomains, when it is set. */
  sp: string | null;
  /** "relaxed" or "strict". */
  adkim: string;
  aspf: string;
  /** Where aggregate reports go (at most 3). */
  rua: string[];
  /** How many addresses get failure reports. */
  ruf: number;
  /** The record is in testing mode (`t=y`). */
  testing: boolean;
}

/** A DKIM signature's key as published. */
export interface EmailDkimKey {
  domain: string;
  selector: string;
  /** How the email was signed: "rsa-sha256", "rsa-sha1" or "ed25519-sha256". */
  algorithm: string;
  /** "rsa" or "ed25519"; null when no key was found. */
  key: string | null;
  /** The key's size in bits, when it could be read. */
  bits: number | null;
  /** The record publishes an empty key: the selector was retired. */
  revoked: boolean;
  /** Set when the key could not be looked up ("lookup failed"). */
  error: string | null;
}

/** What the sender's DNS said about its setup when the email arrived. */
export interface EmailSenderSetup {
  spf: EmailSpfRecord | null;
  dmarc: EmailDmarcRecord | null;
  dkim: EmailDkimKey[];
  /** A BIMI record (brand logo) for the From domain; null when the From domain was unknown. */
  bimi: {
    found: boolean;
    domain: string | null;
    logo: boolean;
    /** It names a mark certificate, which Gmail needs to show the logo. */
    authority: boolean;
    error: string | null;
  } | null;
  /** The name the sending server introduced itself with. */
  helo: {
    name: string;
    /** An address literal such as [192.0.2.1] instead of a name. */
    ipLiteral: boolean;
    fqdn: boolean;
    /** The name resolves to the sending server's address. */
    resolves: boolean;
    /** The name is the server's forward-confirmed reverse DNS name. */
    matchesPtr: boolean;
  } | null;
  /** Set when the lookups could not finish ("timeout", "too large"). */
  error: string | null;
}

/** One rspamd rule that fired, with its weight. */
export interface EmailSpamSymbol {
  name: string;
  score: number;
  /** What the rule matched, when rspamd says (at most 3). */
  options?: string[];
}

/**
 * rspamd's verdict on an email, recorded for you to inspect. It never
 * decides whether mail is accepted: every email that reaches an address is
 * captured.
 */
export interface EmailSpam {
  /** The score; higher looks more like spam. */
  score: number | null;
  /** The score at which rspamd would reject the message. */
  required: number | null;
  /**
   * What rspamd suggests: "no action", "greylist", "add header",
   * "rewrite subject", "soft reject" or "reject". Never applied.
   */
  action: string | null;
  /** The rules that weigh most, heaviest first (at most 20). */
  symbols: EmailSpamSymbol[];
  /** Set when there is no score: "timeout", "unavailable", "busy", "invalid" or "skipped". */
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
  /** rspamd's verdict; null for mail captured before spam scoring or while it was off. */
  spam?: EmailSpam | null;
  smtp: EmailSmtp | null;
  parseError: boolean;
  /**
   * The exact message and its attachments are kept in object storage: the
   * raw message and each attachment can be downloaded whatever their size,
   * even when `truncated.raw` says the copy in `body` was cut.
   */
  stored?: boolean;
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

/** One-time codes (in order of appearance, subject first) and links (best first) found in an email, at most 20 of each. */
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
  /**
   * The new text of a reply, without the quoted message and the signature;
   * null when the email quotes no earlier message.
   */
  replyText: string | null;
  /**
   * The endpoint's named fields (Settings, Receiving), by name: the text its
   * pattern found, or null. Left out when the endpoint has none.
   */
  fields?: Record<string, string | null>;
  /**
   * What the endpoint's layouts found: the layout that matched, its fields,
   * line items and parsed attachments. Present when the endpoint has layouts.
   */
  parsed?: ParsedEmail | null;
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
    /** Base64 contents, from a destination that sends attachments inline. */
    content?: string;
    /** A signed download link, for attachments not sent inline. */
    url?: string;
  }[];
  /** Sender check verdicts ("pass", "fail", ...), null when a check did not run. */
  auth: { spf: string | null; dkim: string | null; dmarc: string | null; tls: string | null };
  /** rspamd's score, threshold and suggested action (never applied); null when it was not scored. */
  spam?: { score: number; required: number; action: string } | null;
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
