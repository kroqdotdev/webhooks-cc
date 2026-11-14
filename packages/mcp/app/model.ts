/**
 * What the inspector shows, read from a tool's JSON: get_request's request
 * (an HTTP request, or an email in its compact form), or get_email's
 * email. Everything here is captured data from strangers: it is only ever
 * put on the page as text.
 */

type Rec = Record<string, unknown>;

export interface HttpView {
  kind: "http";
  id: string | null;
  endpointId: string | null;
  method: string;
  path: string;
  query: string;
  receivedAt: number | null;
  size: number | null;
  contentType: string | null;
  ip: string | null;
  headers: [string, string][];
  headersNote: string | null;
  body: string | null;
  bodyBinary: boolean;
  bodyTruncated: boolean;
  bodySize: number | null;
  answer: { status: number; rule: string | null } | null;
  live: { status: number | null; outcome: string | null; ms: number | null } | null;
  signature: { verified: boolean; provider: string | null; error: string | null } | null;
  provider: string | null;
  event: string | null;
  note: string | null;
  shortened: boolean;
}

export interface Address {
  name: string | null;
  address: string | null;
}

export interface Attachment {
  name: string | null;
  type: string | null;
  size: number | null;
  inline: boolean;
}

export interface EmailView {
  kind: "email";
  id: string | null;
  slug: string | null;
  /** From get_email: codes and links are there when the endpoint shows them. */
  full: boolean;
  subject: string | null;
  from: Address | null;
  to: Address[];
  cc: Address[];
  date: string | null;
  receivedAt: number | null;
  address: string | null;
  tag: string | null;
  codes: string[];
  links: { url: string; text: string | null }[];
  fields: [string, string | null][];
  text: string | null;
  textTruncated: boolean;
  htmlSize: number;
  attachments: Attachment[];
  attachmentsTotal: number | null;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  spam: { score: number | null; required: number | null; action: string | null } | null;
  test: boolean;
  size: number | null;
  note: string | null;
}

export type View = HttpView | EmailView;

/** One line of an endpoint's recent requests. */
export interface RecentItem {
  id: string;
  email: boolean;
  method: string;
  label: string;
  receivedAt: number | null;
}

const isRec = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Milliseconds from a number of milliseconds or an ISO string. */
export function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function address(value: unknown): Address | null {
  if (!isRec(value)) return null;
  return { name: str(value.name), address: str(value.address) };
}

function addresses(value: unknown): Address[] {
  return Array.isArray(value) ? value.map(address).filter((a): a is Address => a !== null) : [];
}

/** The slug of an endpoint from one of its capture addresses (slug+tag@domain). */
export function slugFromAddress(value: string | null): string | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  return value.slice(0, at).split("+")[0].toLowerCase() || null;
}

function queryString(data: Rec): string {
  const raw = str(data.queryRaw);
  if (raw) return raw.startsWith("?") ? raw : `?${raw}`;
  if (!isRec(data.queryParams)) return "";
  const parts = Object.entries(data.queryParams).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
  );
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function httpView(data: Rec): HttpView {
  const headers = isRec(data.headers)
    ? Object.entries(data.headers).map(([key, value]): [string, string] => [key, String(value)])
    : [];
  const status = num(data.responseStatus);
  const live = isRec(data.liveResponse) ? data.liveResponse : null;
  const verified = data.signatureVerified;
  return {
    kind: "http",
    id: str(data.id),
    endpointId: str(data.endpointId),
    method: (str(data.method) ?? "?").toUpperCase(),
    path: str(data.path) ?? "/",
    query: queryString(data),
    receivedAt: timeOf(data.receivedAt),
    size: num(data.size),
    contentType: str(data.contentType),
    ip: str(data.ip),
    headers,
    headersNote: str(data.headersOmitted),
    body: str(data.body),
    bodyBinary: typeof data.bodyRaw === "string" && data.bodyRaw.length > 0,
    bodyTruncated: data.bodyTruncated === true,
    bodySize: num(data.bodySize),
    answer: status === null ? null : { status, rule: str(data.responseRule) },
    live: live ? { status: num(live.status), outcome: str(live.outcome), ms: num(live.ms) } : null,
    signature:
      typeof verified === "boolean"
        ? {
            verified,
            provider: str(data.signingProvider),
            error: str(data.signatureError),
          }
        : null,
    provider: str(data.detectedProvider),
    event: str(data.detectedEvent),
    note: str(data.note),
    shortened: data.shortened === true,
  };
}

function attachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRec).map((item) => ({
    name: str(item.filename),
    type: str(item.contentType),
    size: num(item.size),
    inline: item.inline === true,
  }));
}

function fields(value: unknown): [string, string | null][] {
  if (!isRec(value)) return [];
  return Object.entries(value).map(([key, found]): [string, string | null] => [key, str(found)]);
}

function spam(value: unknown): EmailView["spam"] {
  if (!isRec(value)) return null;
  const view = {
    score: num(value.score),
    required: num(value.required),
    action: str(value.action),
  };
  return view.score === null && view.action === null ? null : view;
}

/** get_email's answer: the email.received JSON's data, trimmed to the output. */
function emailDetailView(data: Rec): EmailView {
  const auth = isRec(data.auth) ? data.auth : null;
  const codes = Array.isArray(data.codes)
    ? data.codes.filter((c): c is string => typeof c === "string")
    : [];
  const code = str(data.code);
  if (code && !codes.includes(code)) codes.unshift(code);
  const links = Array.isArray(data.links)
    ? data.links.filter(isRec).flatMap((link) => {
        const url = str(link.url);
        return url ? [{ url, text: str(link.text) }] : [];
      })
    : [];
  const link = str(data.link);
  if (link && !links.some((item) => item.url === link)) links.unshift({ url: link, text: null });
  const endpoint = isRec(data.endpoint) ? data.endpoint : null;
  return {
    kind: "email",
    id: str(data.id),
    slug: str(endpoint?.slug) ?? slugFromAddress(str(data.address)),
    full: true,
    subject: str(data.subject),
    from: address(data.from),
    to: addresses(data.to),
    cc: addresses(data.cc),
    date: str(data.date),
    receivedAt: timeOf(data.receivedAt),
    address: str(data.address),
    tag: str(data.tag),
    codes,
    links,
    fields: fields(data.fields),
    text: str(data.text),
    textTruncated: data.textTruncated === true,
    htmlSize: num(data.htmlSize) ?? 0,
    attachments: attachments(data.attachments),
    attachmentsTotal: num(data.attachmentsTotal),
    auth: auth ? { spf: str(auth.spf), dkim: str(auth.dkim), dmarc: str(auth.dmarc) } : null,
    spam: spam(data.spam),
    test: data.test === true,
    size: num(data.size),
    note: null,
  };
}

/** A check's verdict from the capture's own auth object. */
function checkResult(value: unknown): string | null {
  if (Array.isArray(value)) {
    const results = value.filter(isRec).map((check) => str(check.result));
    return results.includes("pass") ? "pass" : (results[0] ?? null);
  }
  return isRec(value) ? str(value.result) : null;
}

/** get_request's answer for an email: the request with its parsed message. */
function emailRequestView(data: Rec): EmailView {
  const email = isRec(data.email) ? data.email : {};
  const auth = isRec(email.auth) ? email.auth : null;
  const from = addresses(email.from);
  return {
    kind: "email",
    id: str(data.id),
    slug: slugFromAddress(str(data.path)),
    full: false,
    subject: str(email.subject),
    from: from[0] ?? null,
    to: addresses(email.to),
    cc: addresses(email.cc),
    date: str(email.date),
    receivedAt: timeOf(data.receivedAt),
    address: str(data.path),
    tag: str(email.tag),
    codes: [],
    links: [],
    fields: [],
    text: str(email.text),
    textTruncated: email.textTruncated === true,
    htmlSize: num(email.htmlSize) ?? 0,
    attachments: attachments(email.attachments),
    attachmentsTotal: num(email.attachmentsTotal),
    auth: auth
      ? { spf: checkResult(auth.spf), dkim: checkResult(auth.dkim), dmarc: checkResult(auth.dmarc) }
      : null,
    spam: spam(email.spam),
    test: isRec(email.smtp) && email.smtp.test === true,
    size: num(data.size),
    note: str(data.note),
  };
}

/** The view for a tool's JSON, or null when it is neither a request nor an email. */
export function viewOf(data: unknown): View | null {
  if (!isRec(data)) return null;
  if (isRec(data.endpoint) && typeof data.address === "string" && data.method === undefined) {
    return emailDetailView(data);
  }
  if (data.kind === "email") return emailRequestView(data);
  if (typeof data.method === "string" || typeof data.path === "string") return httpView(data);
  return null;
}

/** list_requests' answer as lines: an array, or { items } when the output cut it. */
export function recentOf(data: unknown): RecentItem[] {
  const list = Array.isArray(data)
    ? data
    : isRec(data) && Array.isArray(data.items)
      ? data.items
      : [];
  return list.filter(isRec).flatMap((item) => {
    const id = str(item.id);
    if (!id) return [];
    const email = item.kind === "email";
    const subject = isRec(item.email) ? str(item.email.subject) : null;
    return [
      {
        id,
        email,
        method: email ? "MAIL" : (str(item.method) ?? "?").toUpperCase(),
        label: email ? (subject ?? str(item.subject) ?? "(no subject)") : (str(item.path) ?? "/"),
        receivedAt: timeOf(item.receivedAt),
      },
    ];
  });
}

/** An endpoint's slug from list_endpoints' answer, by its id. */
export function slugForEndpoint(data: unknown, endpointId: string): string | null {
  const list = Array.isArray(data)
    ? data
    : isRec(data) && Array.isArray(data.items)
      ? data.items
      : [];
  for (const item of list) {
    if (isRec(item) && item.id === endpointId) return str(item.slug);
  }
  return null;
}
