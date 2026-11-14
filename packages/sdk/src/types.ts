import type { Condition } from "./rules";
import type { EmailCapture, RequestKind } from "./email/types";
import type { EmailField } from "./email/fields";
import type { Layout, ParsedEmail } from "./email/layouts";
import type { InboundEmailFormat } from "./email/inbound";

/**
 * A webhook endpoint that captures incoming HTTP requests.
 * Create endpoints via the dashboard or SDK to receive webhooks.
 */
/** Team sharing metadata for an endpoint. */
export interface TeamShare {
  /** Team identifier */
  teamId: string;
  /** Team display name */
  teamName: string;
}

/**
 * Which site's dashboard lists an endpoint: webhooks.cc, mailhooks.cc or both.
 * Only the listing; every endpoint keeps its HTTP URL and email address.
 */
export type EndpointSite = "webhooks" | "mailhooks" | "both";

export interface Endpoint {
  /** Unique identifier for this endpoint */
  id: string;
  /** URL-safe identifier used in webhook URLs (/w/{slug}) */
  slug: string;
  /** Display name for the endpoint */
  name?: string;
  /** Full URL where webhooks should be sent (undefined if server is misconfigured) */
  url?: string;
  /** URL to POST a JSON summary to after each captured request (e.g. Slack/Discord webhook) */
  notificationUrl?: string;
  /** Ordered conditional response rules (first match wins, then falls back to default mock) */
  responseRules?: ResponseRule[];
  /** Whether the endpoint auto-expires and may be cleaned up automatically */
  isEphemeral?: boolean;
  /** Unix timestamp (ms) when the endpoint expires, if ephemeral */
  expiresAt?: number;
  /** Unix timestamp (ms) when the endpoint was created */
  createdAt: number;
  /** Teams this endpoint is shared with (present when you own it) */
  sharedWith?: TeamShare[];
  /** Oldest share among your teams (present when shared with you) */
  fromTeam?: TeamShare;
  /** Every subscribed team of yours this endpoint is shared with (present when shared with you) */
  fromTeams?: TeamShare[];
  /** Signing provider for automatic signature verification (e.g., "stripe", "github") */
  signingProvider?: string | null;
  /** Whether a signing secret is configured (the secret itself is never returned) */
  hasSigningSecret?: boolean;
  /** Custom header name for generic-hmac provider */
  signingHeader?: string | null;
  /** Address the endpoint receives email at; null for guest endpoints, which get none */
  emailAddress?: string | null;
  /** Whether codes and links are picked out of emails (dashboard and forwarded JSON) */
  showEmailExtracts?: boolean;
  /** Which site's dashboard lists it; both addresses capture either way */
  site?: EndpointSite;
  /** Whether you marked it as one of your favourites (your own choice; present on list and get) */
  favorite?: boolean;
  /** Named fields picked out of every email (owner only): `fields` in its JSON */
  emailFields?: EmailField[];
  /** Days requests are kept; null keeps them as long as the plan does (owner only) */
  retentionDays?: number | null;
  /** The longest retention this endpoint may have: its plan's (owner only) */
  retentionCapDays?: number;
  /** Requests are deleted once every delivery is settled (owner only) */
  deleteAfterDelivery?: boolean;
  /** How the endpoint reads its emails; the first that matches applies (owner only) */
  layouts?: Layout[];
  /** Layouts the plan uses; later ones are kept but not used (owner only) */
  layoutsCap?: number;
  /** Whether forwarding is on: the kinds below go to `forwardUrl` */
  forwardEnabled?: boolean;
  /** Where captured requests are forwarded (only returned to the endpoint's owner) */
  forwardUrl?: string | null;
  /** Whether a forwarding secret exists (read it with `forwarding.secret()`) */
  hasForwardSecret?: boolean;
  /** Whether HTTP requests are forwarded */
  forwardHttp?: boolean;
  /** Whether emails are forwarded */
  forwardEmail?: boolean;
  /** How deliveries go out; "auto" picks from the URL */
  forwardFormat?: ForwardFormatSetting;
  /** Your own headers, with masked values (only returned to the endpoint's owner) */
  forwardHeaders?: { name: string; value: string }[];
  /** Whether the path after the slug is added to the URL for relayed requests */
  forwardAppendPath?: boolean;
  /** How long failed deliveries are retried, in seconds */
  forwardRetrySeconds?: ForwardRetrySeconds;
  /** One delivery at a time, in capture order */
  forwardKeepOrder?: boolean;
  /** The JSON body field holding the sender's own timestamp */
  forwardSentField?: string | null;
}

/**
 * How forwarded deliveries go out: "as_received" relays HTTP requests with
 * their method, headers and exact body (emails as signed JSON), "json" sends
 * a signed `request.received` or `email.received` envelope, "chat" posts a
 * Slack or Discord message, and "auto" picks chat for Slack and Discord
 * webhook URLs and "as_received" otherwise.
 */
export type ForwardFormatSetting = "auto" | "as_received" | "json" | "chat";

/** How long failed deliveries are retried: never, one hour or one day. */
export type ForwardRetrySeconds = 0 | 3600 | 86400;

/** One of your own headers for forwarded deliveries; a null value keeps the stored one. */
export interface ForwardHeaderInput {
  name: string;
  value: string | null;
}

/**
 * A single condition within a response rule or a forwarding filter. See
 * `CONDITION_FIELDS` for the operators each field takes; response rules can
 * read the HTTP request only (method, path, header, query, body,
 * body_contains, body_path, content_type, size).
 */
export type ResponseRuleCondition = Condition;

/** A conditional response rule: when conditions match, return this response. */
export interface ResponseRule {
  /** Stable identifier for UI drag-reorder */
  id?: string;
  /** Human-readable rule name */
  name?: string;
  /** Whether this rule is active (default: true) */
  enabled?: boolean;
  /** How to combine conditions: "and" (all match) or "or" (any match). Default: "and" */
  logic?: "and" | "or";
  /** Conditions to evaluate against the incoming request */
  conditions: ResponseRuleCondition[];
  /** Response to return when conditions match */
  response: MockResponse;
}

/** Options for `endpoints.previewResponse`. */
export interface PreviewResponseOptions {
  /** A captured request on the endpoint; default the newest HTTP request (a sample when none). */
  requestId?: string;
  /** Try an unsaved default response (null: none). Left out, the saved one applies. */
  mockResponse?: MockResponse | null;
  /** Try unsaved rules (null: none). Left out, the saved ones apply. */
  responseRules?: ResponseRule[] | null;
}

/** What `endpoints.previewResponse` reports. */
export interface ResponsePreview {
  /** The rule that answers (its position from 0), or null when the default response does. */
  rule: { index: number; name: string | null } | null;
  /** The response with placeholders filled in; null means the receiver's plain 200 OK. */
  response: { status: number; headers: Record<string, string>; body: string; delay: number } | null;
  /** Placeholders the request has no field for; they are sent as written. */
  unknownPlaceholders: string[];
  /** True for an email: emails get a standard mail-server reply, never a mock response. */
  email: boolean;
  /** The request the preview ran against. */
  request: {
    id: string | null;
    method: string;
    path: string;
    receivedAt: number;
    /** No request was captured yet, so a sample was used. */
    sample: boolean;
  };
}

/** Mock response returned by the receiver instead of the default 200 OK. */
export interface MockResponse {
  /** HTTP status code (100-599) */
  status: number;
  /**
   * Response body. `{{ ... }}` placeholders are filled in from the request:
   * `{{ json.id }}`, `{{ headers.user-agent }}`, `{{ uuid }}`. See
   * https://webhooks.cc/docs/mock-responses#placeholders.
   */
  body: string;
  /** Response headers; values can hold placeholders too. */
  headers: Record<string, string>;
  /** Response delay in milliseconds (0-30000). The receiver caps at 30s. */
  delay?: number;
}

/**
 * A captured webhook request with full HTTP details.
 * Stored when a webhook arrives at an endpoint.
 */
export interface Request {
  /** Unique identifier for this request */
  id: string;
  /** Endpoint that received this request */
  endpointId: string;
  /** HTTP method (GET, POST, PUT, etc.) */
  method: string;
  /** Request path after the endpoint slug */
  path: string;
  /** HTTP headers from the original request */
  headers: Record<string, string>;
  /** Request body, if present */
  body?: string;
  /** Base64-encoded raw bytes, present only for non-UTF-8 payloads */
  bodyRaw?: string;
  /** URL query parameters */
  queryParams: Record<string, string>;
  /** Content-Type header value, if present */
  contentType?: string;
  /** Client IP address */
  ip: string;
  /** Request body size in bytes */
  size: number;
  /** Unix timestamp (ms) when the request arrived */
  receivedAt: number;
  /** Signature verification result: true=valid, false=invalid, null/undefined=not configured */
  signatureVerified?: boolean | null;
  /** Structured JSON error when signatureVerified is false */
  signatureError?: string | null;
  /** Provider that verified (or attempted to verify) the signature */
  signingProvider?: string | null;
  /** "email" for a captured email, "http" for everything else */
  kind?: RequestKind;
  /** The parsed message, for a captured email */
  email?: EmailCapture | null;
  /** What the endpoint's layouts found, once the parse is done (emails on endpoints with layouts) */
  parsed?: ParsedEmail | null;
  /**
   * What the local app answered, for a request captured while `whk tunnel
   * --live` ran: the sender got this answer instead of the mock response.
   */
  liveResponse?: LiveResponse | null;
}

/** The answer a local app gave a request relayed through `whk tunnel --live`. */
export interface LiveResponse {
  /** The HTTP status the sender got: the app's, or the stand-in's (see `outcome`). */
  status: number | null;
  /** The response headers. */
  headers: Record<string, string>;
  /** The start of the body (up to 64 KB). */
  body: string;
  /** True when the body was longer than what is kept. */
  bodyTruncated: boolean;
  /** "utf8" for text, "base64" for bytes that are not UTF-8. */
  bodyEncoding: "utf8" | "base64";
  /** How long the app took, in milliseconds. */
  ms: number | null;
  /**
   * "answered" when the app answered; otherwise what the sender got instead:
   * "offline" (502, whk tunnel --live not connected), "timeout" (504),
   * "unreachable" (502, nothing on the local port), "busy" (503) or
   * "refused": the app's answer was not passed back as it was. 400 when
   * the path left the endpoint; 502 when the answer was refused (a
   * download, a script or another type an API does not answer with, or a
   * stated size over 1 MB); or the app's own status when the answer
   * streamed past 1 MB and was cut off, so the sender got a broken stream.
   */
  outcome?: "answered" | "offline" | "timeout" | "unreachable" | "busy" | "refused";
}

/** A `whk share` preview or a `whk tunnel --live` session (GET /api/shares). */
export interface TunnelShare {
  id: string;
  /** "share": a preview at a name; "live": an endpoint's captures relayed to a local app. */
  kind: "share" | "live";
  /** The preview's name, or null for a live session. */
  name: string | null;
  /** The preview's link, or the capture URL for a live session. */
  url: string | null;
  /** The endpoint, for a live session. */
  endpointSlug: string | null;
  /** What it runs on: "laptop, macOS". */
  client: string;
  startedAt: string;
  /** Null while it runs. */
  endedAt: string | null;
  /** Why it ended, in words. */
  endReason: string | null;
  /** When the plan's session time runs out, or null without a limit. */
  expiresAt: string | null;
  /**
   * Bytes visitors moved through a preview, both ways (downloads and uploads,
   * WebSockets included). Live tunnels count captures instead.
   */
  bytes: number;
  requests: number;
  /** Whether visitors need a password. */
  password: boolean;
  /** False for a teammate's share under a team name. */
  mine: boolean;
  /** Who started it, for a teammate's share. */
  startedBy: { id: string; email: string } | null;
  /** Whether visitors see the notice page before the preview. */
  notice?: boolean;
}

/** This month's shared data (UTC month). */
export interface TunnelUsage {
  /** "2026-11". */
  month: string;
  bytes: number;
  limitBytes: number;
  /** True once the month's data is used: previews pause until `resetsAt`. */
  over: boolean;
  resetsAt: string;
  /** Why previews are paused and until when, when `over`. */
  message?: string | null;
}

/** What the account's plan allows for sharing. */
export interface TunnelLimits {
  plan: string;
  /** The plan's name for people: "Pro", "Team Business". */
  label?: string;
  /** Previews at once. */
  shares: number;
  reservedNames: number;
  /** Minutes a preview may run, or null without a limit. */
  sessionMinutes: number | null;
  /** Data a month, in GB. */
  dataGb: number;
  passwords: boolean;
  /** Whether visitors see a short notice before the page. */
  notice: boolean;
}

/** Reserved names against the plan, for GET /api/shares. */
export interface TunnelNamesSummary {
  /** One's own names the plan allows. */
  limit: number;
  /** One's own names reserved. */
  used: number;
  /** Names one may share under now, own and teams'. */
  usable: number;
}

export interface TunnelShareList {
  shares: TunnelShare[];
  usage: TunnelUsage;
  limits: TunnelLimits;
  /** Reserved names standing (newer servers). */
  names?: TunnelNamesSummary;
  /** True when sharing is suspended on this account. */
  suspended?: boolean;
  /** What to do next, as whk commands an agent can run. */
  hints?: string[];
}

/** What `client.shares.stop()` reports (POST /api/shares/{id}/stop). */
export interface TunnelStopResult {
  ok: boolean;
  /** False when it had already ended. */
  stopped: boolean;
  /** False when the edge could not be told at once; it ends at the next sync. */
  edgeReached: boolean;
}

/** One visitor request to a preview, from the edge's memory (no addresses). */
export interface TunnelVisit {
  method: string;
  path: string;
  status: number;
  ms: number;
  bytes: number;
  at: string;
  country: string | null;
  device: "phone" | "tablet" | "computer" | "bot" | "unknown";
  /** 1 for the first visitor seen, 2 for the next. */
  visitor: number;
}

export interface TunnelVisits {
  /** False when the edge could not be asked just now. */
  available: boolean;
  /** Newest first. */
  requests: TunnelVisit[];
}

/** A reserved preview name (GET /api/tunnel-names). */
export interface TunnelName {
  name: string;
  /** The preview link it gives. */
  url: string | null;
  /** The team it belongs to, when reserved inside one. */
  team: { id: string; name: string } | null;
  reservedBy: { id: string; email: string } | null;
  /** False for a teammate's name. */
  mine: boolean;
  /** Whether it has a password of its own. */
  password: boolean;
  /** Whether a preview runs under it now. */
  live: boolean;
  /**
   * False when the plan no longer covers it (past the plan's count after a
   * downgrade, or a team whose subscription ended): it is kept, but nothing
   * can be shared under it until the plan grows or another name is
   * released. Missing from older servers, which means usable.
   */
  usable?: boolean;
  createdAt: string;
}

/** A team's own count of names: team names count against the team. */
export interface TunnelTeamNameCount {
  id: string;
  name: string;
  /** False while the team has no subscription: its names wait, unusable. */
  active?: boolean;
  /** Names the team may keep (its plan's names per seat). */
  limit: number;
  /** Names it keeps. */
  used: number;
}

export interface TunnelNameList {
  names: TunnelName[];
  /** Your own names the plan allows. */
  limit: number;
  /** Your own names. */
  used: number;
  /** The plan your sharing limits come from ("pro", "team_business"). */
  plan?: string;
  /** Each of your teams' counts, when the server gives them. */
  teams?: TunnelTeamNameCount[];
}

/**
 * A captured email: a request with `kind: "email"`. `method` is "EMAIL",
 * `path` the recipient address, `body` the raw message and `email` the
 * parsed one.
 */
export interface EmailRequest extends Request {
  kind: "email";
  email: EmailCapture;
  /**
   * The endpoint's named fields (Settings, Receiving): what each pattern
   * found, or null; null when the endpoint has none. `emails.get()` returns
   * them; lists leave them out.
   */
  emailFields?: Record<string, string | null> | null;
  /** The new text of a reply, without the quoted message and signature (`emails.get()`). */
  replyText?: string | null;
}

/**
 * A retained request returned from ClickHouse-backed search.
 * The id is synthetic and is not compatible with requests.get()/replay().
 */
export interface SearchResult {
  /** Synthetic identifier derived from retained request contents */
  id: string;
  /** Endpoint slug that received this request */
  slug: string;
  /** HTTP method (GET, POST, PUT, etc.) */
  method: string;
  /** Request path after the endpoint slug */
  path: string;
  /** HTTP headers from the original request */
  headers: Record<string, string>;
  /** Request body, if present */
  body?: string;
  /** URL query parameters */
  queryParams: Record<string, string>;
  /** Content-Type header value, if present */
  contentType?: string;
  /** Client IP address */
  ip: string;
  /** Request body size in bytes */
  size: number;
  /** Unix timestamp (ms) when the request arrived */
  receivedAt: number;
  /** "email" for a captured email, "http" for everything else */
  kind?: RequestKind;
  /** The parsed message, for a captured email */
  email?: EmailCapture | null;
}

/** User-level request usage and quota information. */
export interface UsageInfo {
  /** Requests consumed in the current billing window */
  used: number;
  /** Total request quota for the current billing window */
  limit: number;
  /** Remaining requests before quota is exhausted */
  remaining: number;
  /** Current subscription plan */
  plan: "free" | "pro" | "business";
  /** End of the current billing window, if active */
  periodEnd: number | null;
  /** Attachment pages parsed by layouts this page window; null when it could not be read. */
  parsedPages?: ParsedPagesUsage | null;
  /** What visitors downloaded from `whk share` previews this UTC month; null where sharing is not offered. */
  previewData?: PreviewDataUsage | null;
  /** AI assists over the rolling 30 days on endpoints no team pays for; null where they are not offered. */
  aiAssists?: AiAssistsUsage | null;
}

/** Parsed attachment pages in the account's page window. */
export interface ParsedPagesUsage {
  used: number;
  /** The window's pages: the plan's plus monthly page blocks. */
  limit: number;
  /** One-time pages left, used once `limit` is gone. */
  creditPages: number;
  /** Page overage this window, while `active`. */
  overage: { active: boolean; used: number; max: number };
  /** When the window ends (ISO 8601); null until a monthly window's first parse. */
  resetsAt: string | null;
}

/** Preview data (`whk share`) this UTC month. */
export interface PreviewDataUsage {
  bytes: number;
  limitBytes: number;
  /** True once the month's data is used: previews pause until `resetsAt`. */
  over: boolean;
  /** ISO 8601. */
  resetsAt: string;
}

/** AI assists counted over a rolling 30 days. */
export interface AiAssistsUsage {
  used: number;
  allowed: number;
  /** When the next counted assist stops counting (ISO 8601); null when none is counted. */
  nextAt: string | null;
}

/**
 * Options for listing endpoints.
 */
export interface ListEndpointsOptions {
  /**
   * Keep only endpoints tied to this team: those shared with you from it
   * (`fromTeams`, `fromTeam`) and those you own and shared with it
   * (`sharedWith`). A team id (exact) or a team name (case-insensitive),
   * resolved against `teams.list()`; a name that matches several teams
   * throws, so pass the id in that case.
   */
  team?: string;
}

/**
 * A team you own or belong to. Seats are both the member cap and the
 * pooled request quota (seats x 100,000 a month on Teams, x 250,000 on
 * Team Business).
 */
export interface Team {
  /** Team identifier */
  id: string;
  /** Team display name */
  name: string;
  /** User id of the owner */
  createdBy: string;
  /** Unix timestamp (ms) when the team was created */
  createdAt: number;
  /** Current member count, owner included */
  memberCount: number;
  /** Your role on this team */
  role: "owner" | "member";
  /** True while the team has no subscription; a suspended team shares nothing */
  suspended: boolean;
  /** Subscription state, or null when unsubscribed */
  subscriptionStatus: "active" | "canceled" | "past_due" | null;
  /** Purchased seats */
  seats: number;
  /** Requests consumed from the pooled quota in the current period */
  requestsUsed: number;
  /** Pooled request quota for the current period */
  requestLimit: number;
  /** End of the current billing period (ms), or null when unsubscribed */
  periodEnd: number | null;
  /** True when the subscription ends at the current period end */
  cancelAtPeriodEnd: boolean;
  /** Requests monthly blocks add to requestLimit this period */
  blockRequests?: number;
  /** True on Team Business: Business's limits per seat */
  business?: boolean;
  /** The subscription's interval; null when unsubscribed */
  billingInterval?: "month" | "year" | null;
  /** A plan change waiting for the renewal, or null */
  pendingPlan?: "team" | "team_business" | null;
  pendingInterval?: "month" | "year" | null;
  /** When the subscription renews (ms): the year's end on annual billing; null when unsubscribed */
  billingPeriodEnd?: number | null;
  /** Seat count a scheduled reduction applies at the next renewal; null when none */
  pendingSeats?: number | null;
}

/** A member of a team. */
export interface TeamMember {
  /** Membership row id */
  id: string;
  /** User id */
  userId: string;
  /** Member email */
  email: string;
  /** Display name, if set */
  name: string | null;
  /** Avatar URL, if set */
  image: string | null;
  /** Role on the team */
  role: "owner" | "member";
  /** Unix timestamp (ms) when the member joined */
  joinedAt: number;
}

/** A pending team invite. */
export interface TeamInvite {
  /** Invite id */
  id: string;
  /** Team the invite is for */
  teamId: string;
  /** Team display name */
  teamName: string;
  /** User id of the inviter */
  invitedBy: string;
  /** Email of the inviter */
  inviterEmail: string;
  /** Email the invite was sent to */
  invitedEmail: string;
  /** Invite state */
  status: "pending" | "accepted" | "declined";
  /** Unix timestamp (ms) when the invite was created */
  createdAt: number;
  /**
   * Set by `teams.invite()` when the invite row was created but the email
   * could not be sent. The invitee still finds the invite in-app after
   * signing up with that address; tell them another way.
   */
  warning?: string;
}

/** Members of a team plus the invites that have not been answered yet. */
export interface TeamMembers {
  members: TeamMember[];
  pendingInvites: TeamInvite[];
}

/**
 * Options for creating a new endpoint.
 */
export interface CreateEndpointOptions {
  /** Display name for the endpoint */
  name?: string;
  /** Whether the endpoint should auto-expire */
  ephemeral?: boolean;
  /** Relative expiry duration like "12h" or "7d"; implies ephemeral */
  expiresIn?: number | string;
  /** Optional mock response to configure at creation time */
  mockResponse?: MockResponse;
  /** URL to POST a JSON summary to after each captured request */
  notificationUrl?: string;
  /** Ordered conditional response rules */
  responseRules?: ResponseRule[];
  /** Which site's dashboard lists it; "both" when left out */
  site?: EndpointSite;
}

/**
 * Options for updating an existing endpoint.
 */
export interface UpdateEndpointOptions {
  /** New display name */
  name?: string;
  /** Mock response config, or null to clear */
  mockResponse?: MockResponse | null;
  /** Notification webhook URL, or null to clear */
  notificationUrl?: string | null;
  /** Ordered conditional response rules, or null to clear */
  responseRules?: ResponseRule[] | null;
  /** Signing provider for automatic verification, or null to disable */
  signingProvider?: string | null;
  /** Plaintext signing secret (encrypted server-side, never returned) */
  signingSecret?: string | null;
  /** Custom header name for generic-hmac provider */
  signingHeader?: string | null;
  /** Pick codes and links out of emails (owner only) */
  showEmailExtracts?: boolean;
  /** Which site's dashboard lists it (owner only) */
  site?: EndpointSite;
  /** Named fields to pick out of every email, at most 20, or null for none (owner only) */
  emailFields?: EmailField[] | null;
  /** Keep requests this many days (1 up to the plan's), or null for the plan's (owner only) */
  retentionDays?: number | null;
  /** Delete each request once every delivery is settled (owner only) */
  deleteAfterDelivery?: boolean;
  /**
   * How the endpoint reads its emails, at most 50 (the plan uses the first
   * `layoutsCap`), or null for none (owner only). Emails on an endpoint with
   * layouts are parsed before their deliveries go.
   */
  layouts?: Layout[] | null;
  /** Forward captured requests to `forwardUrl` (owner only; needs a URL) */
  forwardEnabled?: boolean;
  /** Where to forward, or null to remove it once forwarding is off (owner only) */
  forwardUrl?: string | null;
  /** Forward HTTP requests (owner only) */
  forwardHttp?: boolean;
  /** Forward emails (owner only) */
  forwardEmail?: boolean;
  /** Delivery format (owner only) */
  forwardFormat?: ForwardFormatSetting;
  /** The whole list of your headers, at most 10; a null value keeps the stored one (owner only) */
  forwardHeaders?: ForwardHeaderInput[];
  /** Add the path after the slug to the URL for relayed requests (owner only) */
  forwardAppendPath?: boolean;
  /** Retry failed deliveries for 0, 3600 or 86400 seconds (owner only) */
  forwardRetrySeconds?: ForwardRetrySeconds;
  /** One delivery at a time, in capture order (owner only) */
  forwardKeepOrder?: boolean;
  /** JSON body field with the sender's timestamp, such as "publishedAt", or null (owner only) */
  forwardSentField?: string | null;
}

/**
 * Options for sending a test webhook to an endpoint.
 */
export interface SendOptions {
  /** HTTP method (default: "POST") */
  method?: string;
  /** HTTP headers to include */
  headers?: Record<string, string>;
  /** Request body (will be JSON-serialized if not a string) */
  body?: unknown;
}

export type TemplateProvider =
  | "stripe"
  | "github"
  | "shopify"
  | "twilio"
  | "slack"
  | "paddle"
  | "linear"
  | "sendgrid"
  | "clerk"
  | "discord"
  | "vercel"
  | "gitlab"
  | "typeform"
  | "standard-webhooks"
  | "meta"
  | "lemonsqueezy"
  | "coinbase-commerce"
  | "razorpay"
  | "cal"
  | "intercom"
  | "telegram"
  | "square"
  | "hubspot"
  | "mailgun"
  | "calendly"
  | "mux"
  | "sentry"
  | "bitbucket"
  | "docusign"
  | "adyen"
  | "paypal"
  | "plaid"
  | "resend"
  | "workos";

/** Static metadata describing a supported template provider. */
export interface TemplateProviderInfo {
  /** Provider identifier used by sendTemplate()/sendTo() */
  provider: TemplateProvider;
  /** Supported provider-specific template presets */
  templates: readonly string[];
  /** Default template preset used when template is omitted */
  defaultTemplate?: string;
  /** Whether this provider requires a shared secret for signing */
  secretRequired: boolean;
  /** Header that carries the provider signature */
  signatureHeader?: string;
  /** Signature algorithm used for request signing */
  signatureAlgorithm?: string;
}

/** Structured provider detection result for a captured or retained request. */
export interface DetectedWebhookInfo {
  /** Best-effort identified provider */
  provider: TemplateProvider;
  /** Best-effort extracted event/topic name, when available */
  event: string | null;
  /** Whether detection came from headers or body inspection */
  via: "header" | "body";
  /** Header name or body path that matched, when known */
  matchedOn?: string;
}

/**
 * Options for sending a provider template webhook with signed headers.
 */
export interface SendTemplateOptions {
  /** Provider template to use */
  provider: TemplateProvider;
  /** Provider-specific template preset (uses provider default if omitted) */
  template?: string;
  /**
   * Shared secret used for provider signature generation. Required for signed
   * providers; omit for providers whose templates are unsigned (those with
   * `secretRequired: false`, e.g. sendgrid, discord, plaid).
   */
  secret?: string;
  /** Provider event/topic name (provider default used if omitted) */
  event?: string;
  /** HTTP method override (default: "POST") */
  method?: string;
  /** Additional headers merged after template headers */
  headers?: Record<string, string>;
  /** Body override; if omitted a provider-specific template body is generated */
  body?: unknown;
  /** Unix timestamp (seconds) override for deterministic signatures in tests */
  timestamp?: number;
  /**
   * Message id override for providers that sign one (`standard-webhooks`,
   * `clerk`, `resend`); random when omitted. With `timestamp`, makes their
   * signatures deterministic in tests.
   */
  messageId?: string;
}

/**
 * Options for listing captured requests.
 */
export interface ListRequestsOptions {
  /** Maximum number of requests to return */
  limit?: number;
  /** Only return requests received after this timestamp (ms) */
  since?: number;
  /** Only HTTP requests or only emails */
  kind?: RequestKind;
}

/** Cursor-based paginated result. */
export interface PaginatedResult<T> {
  /** Page items for this fetch */
  items: T[];
  /** Cursor to pass to the next page fetch */
  cursor?: string;
  /** Whether another page is available */
  hasMore: boolean;
}

/** Options for cursor-based request pagination. */
export interface ListPaginatedRequestsOptions {
  /** Maximum number of requests to return */
  limit?: number;
  /** Opaque cursor from a previous page */
  cursor?: string;
  /** Only HTTP requests or only emails */
  kind?: RequestKind;
}

/**
 * Options for clearing captured requests from an endpoint.
 */
export interface ClearRequestsOptions {
  /** Only delete requests received before this timestamp (ms) or relative duration */
  before?: number | string;
}

/**
 * Filters for retained request search/count.
 * String timestamps may be absolute milliseconds ("1700000000000") or relative durations ("1h", "7d").
 */
export interface SearchFilters {
  /** Restrict results to a single endpoint slug */
  slug?: string;
  /** Restrict results to a specific HTTP method */
  method?: string;
  /** Only HTTP requests or only emails */
  kind?: RequestKind;
  /** Free-text substring search across path, body, and headers */
  q?: string;
  /** Lower bound for receivedAt (absolute ms or relative duration) */
  from?: number | string;
  /** Upper bound for receivedAt (absolute ms or relative duration) */
  to?: number | string;
  /** Maximum number of results to return */
  limit?: number;
  /** Result offset for pagination */
  offset?: number;
  /** Result ordering by receivedAt */
  order?: "asc" | "desc";
}

/**
 * Options for waitFor() polling behavior.
 */
export interface WaitForOptions {
  /** Maximum time to wait (ms or duration string like "30s", "5m") (default: 30000) */
  timeout?: number | string;
  /** Interval between polls (ms or duration string) (default: 500, min: 10, max: 60000) */
  pollInterval?: number | string;
  /** Filter function to match specific requests */
  match?: (request: Request) => boolean;
  /**
   * Only consider requests received after this timestamp (ms). Defaults to
   * five minutes before the call, so a request that arrived just before
   * waiting started is still found.
   */
  since?: number;
}

/** Options for waitForAll() multi-request collection. */
export interface WaitForAllOptions extends WaitForOptions {
  /** Number of matching requests to collect before returning */
  count: number;
}

/**
 * Options for `requests.subscribe()`.
 *
 * The server caps every SSE connection at 30 minutes: it sends an `event: timeout`
 * frame and closes. With `reconnect: true` the client follows that rotation
 * transparently (immediately, without consuming a reconnect attempt) and resumes
 * from the last received request. Without it, the iterator completes at the first
 * rotation, after at most 30 minutes.
 */
export interface SubscribeOptions {
  /** AbortSignal to cancel the subscription */
  signal?: AbortSignal;
  /** Maximum time to stream (ms or duration string like "30m") */
  timeout?: number | string;
  /**
   * Reconnect automatically. Follows the server's scheduled 30-minute rotation
   * immediately, and recovers from unexpected stream ends, transient errors, and
   * idle timeouts with exponential backoff. Resumes from the last received request
   * timestamp and deduplicates replayed events.
   */
  reconnect?: boolean;
  /**
   * Maximum recovery reconnect attempts before giving up (default: 5).
   * Scheduled rotations are not counted.
   */
  maxReconnectAttempts?: number;
  /** Base backoff delay between recovery reconnects (default: 1000 ms) */
  reconnectBackoffMs?: number | string;
  /**
   * Idle watchdog: how long to wait for any data (the server sends a keepalive
   * every 30 s) before treating the connection as dead. Accepts ms or a duration
   * string like "2m". Default: "90s" (three keepalive intervals). `0` disables it.
   *
   * With `reconnect: true` an idle connection is dropped and reconnected (counts
   * as a reconnect attempt, with backoff). Without it, the iterator throws
   * `TimeoutError`.
   */
  idleTimeout?: number | string;
  /**
   * Callback invoked before each recovery reconnect attempt. Not called for the
   * server's scheduled rotations.
   */
  onReconnect?: (attempt: number) => void;
}

/** Info passed to the onRequest hook before a request is sent. */
export interface RequestHookInfo {
  method: string;
  url: string;
}

/** Info passed to the onResponse hook after a successful response. */
export interface ResponseHookInfo {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

/** Info passed to the onError hook when a request fails. */
export interface ErrorHookInfo {
  method: string;
  url: string;
  error: Error;
  durationMs: number;
}

/**
 * Lifecycle hooks for observability and telemetry integration.
 * All hooks are optional and are called synchronously (fire-and-forget).
 */
export interface ClientHooks {
  onRequest?: (info: RequestHookInfo) => void;
  onResponse?: (info: ResponseHookInfo) => void;
  onError?: (info: ErrorHookInfo) => void;
}

/**
 * Retry configuration for transient API failures. Off by default.
 *
 * Network errors, timeouts and the statuses in `retryOn` are retried for
 * GET, HEAD, OPTIONS, PUT and DELETE, whose repeat is harmless. Other calls
 * (creating an endpoint, sending a test email) are retried only after a 429,
 * which the API sends before doing anything: one that timed out or failed
 * with a 5xx may have gone through.
 */
export interface RetryOptions {
  /** Total attempts including the initial request */
  maxAttempts?: number;
  /** Base backoff delay in milliseconds */
  backoffMs?: number;
  /** HTTP status codes that should be retried (default 429, 500, 502, 503, 504) */
  retryOn?: number[];
}

/**
 * Configuration options for the WebhooksCC client.
 */
export interface ClientOptions {
  /** API key for authentication (format: whcc_...). Or give `getAccessToken`. */
  apiKey?: string;
  /**
   * Supplies the bearer instead of a fixed `apiKey`, for tokens that expire
   * (an agent's access token). Called before each request; with
   * `forceRefresh` after a 401, once, before the request is retried.
   */
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string>;
  /** Base URL for the API (default: https://webhooks.cc) */
  baseUrl?: string;
  /** Base URL for sending webhooks (default: https://go.webhooks.cc) */
  webhookUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Retry policy for transient API failures */
  retry?: RetryOptions;
  /** Lifecycle hooks for observability */
  hooks?: ClientHooks;
  /** Domain endpoints receive email on, for `emails.address()` (default: mailhooks.cc) */
  emailDomain?: string;
  /** The fetch every request goes through (default: the global fetch), for proxies and tests. */
  fetch?: typeof globalThis.fetch;
  /**
   * Your own product token, like `my-tool/1.2`, sent before the SDK's
   * (`webhooks-cc-sdk/<version>`) in the User-Agent of API calls. Browsers
   * keep their own User-Agent.
   */
  userAgent?: string;
}

/** Description of a single SDK operation. */
export interface OperationDescription {
  description: string;
  params: Record<string, string>;
}

/**
 * Options for sending a webhook directly to an arbitrary URL.
 * Supports optional provider signing (Standard Webhooks, Stripe, etc.).
 */
export interface SendToOptions {
  /** Provider template for signing (optional). When set, secret is required. */
  provider?: TemplateProvider;
  /** Provider-specific template preset (e.g. "checkout.session.completed" for Stripe) */
  template?: string;
  /** Secret for provider signature generation (required when provider is set) */
  secret?: string;
  /** Event name for provider headers */
  event?: string;
  /** HTTP method (default: "POST") */
  method?: string;
  /** HTTP headers to include */
  headers?: Record<string, string>;
  /** Request body (will be JSON-serialized if not a string) */
  body?: unknown;
  /** Unix timestamp (seconds) override for deterministic signatures in tests */
  timestamp?: number;
  /**
   * Message id override for providers that sign one (`standard-webhooks`,
   * `clerk`, `resend`); random when omitted.
   */
  messageId?: string;
}

/** Result returned by verifySignature(). */
export interface SignatureVerificationResult {
  /** Whether the computed signature matched the provided signature header(s) */
  valid: boolean;
}

/** Providers supported by verifySignature(). */
export type VerifyProvider = TemplateProvider;

/**
 * Options for verifying a captured webhook signature.
 * For Twilio, `url` is required because the signature covers the full webhook URL.
 * Square and HubSpot also require `url`; HubSpot additionally requires `method`.
 */
export type VerifySignatureOptions =
  | {
      /** Provider whose signature format should be verified */
      provider: Exclude<VerifyProvider, "discord">;
      /** Shared secret used by the provider when signing the webhook */
      secret: string;
      /** Full signed URL (required for Twilio, Square, and HubSpot verification) */
      url?: string;
      /** HTTP method covered by the signature (required for HubSpot v3) */
      method?: string;
      /** Optional certificate fetcher for PayPal self-verification tests/custom transports */
      fetchCertificate?: (url: string) => Promise<string>;
    }
  | {
      /** Discord interaction verification */
      provider: "discord";
      /** Discord application public key (hex) */
      publicKey: string;
    };

/** Value type returned when parsing form-encoded request bodies. */
export type FormBodyValue = string | string[];

/** Parsed application/x-www-form-urlencoded body. */
export type ParsedFormBody = Record<string, FormBodyValue>;

/** Result from parseBody() based on content-type detection. */
export type ParsedBody = unknown | ParsedFormBody | string | undefined;

/** Options for bulk request export. */
export interface ExportRequestsOptions {
  /** Output format */
  format: "har" | "curl";
  /** Maximum number of requests to export */
  limit?: number;
  /** Only include requests received after this timestamp (ms) */
  since?: number;
}

/** HAR header entry. */
export interface HarHeader {
  name: string;
  value: string;
}

/** HAR query parameter entry. */
export interface HarQueryParam {
  name: string;
  value: string;
}

/** HAR request body metadata. */
export interface HarPostData {
  mimeType: string;
  text: string;
}

/** HAR request object. */
export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarQueryParam[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData;
}

/** HAR response object. */
export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  cookies: [];
  content: {
    size: number;
    mimeType: string;
    text?: string;
  };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

/** HAR entry for a captured request. */
export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
}

/** HAR export archive. */
export interface HarExport {
  log: {
    version: "1.2";
    creator: {
      name: string;
      version: string;
    };
    entries: HarEntry[];
  };
}

/** cURL export output. */
export type CurlExport = string[];

/** Union returned by requests.export(). */
export type RequestsExport = HarExport | CurlExport;

/** Self-describing schema returned by client.describe(). */
export interface SDKDescription {
  version: string;
  /** How an agent self-registers for a credential (auth.md on-ramp). */
  registration?: OperationDescription;
  endpoints: Record<string, OperationDescription>;
  templates: Record<string, OperationDescription>;
  usage: OperationDescription;
  sendTo: OperationDescription;
  buildRequest: OperationDescription;
  flow: OperationDescription;
  requests: Record<string, OperationDescription>;
  emails: Record<string, OperationDescription>;
  forwarding: Record<string, OperationDescription>;
  destinations: Record<string, OperationDescription>;
  alerts: Record<string, OperationDescription>;
  teams: Record<string, OperationDescription>;
  /** What the account pays for (reads only). */
  billing: Record<string, OperationDescription>;
  /** The account's API keys; creating one asks the owner first (an approval). */
  apiKeys: Record<string, OperationDescription>;
  /** Approvals asked for by this key or agent. */
  approvals: Record<string, OperationDescription>;
  /** Public previews of local ports (`whk share`) and live tunnels. */
  shares: Record<string, OperationDescription>;
  /** Reserved preview names. */
  names: Record<string, OperationDescription>;
}

/** Which emails to match. Strings match exactly (subject: contains; addresses: case-insensitive). */
export interface EmailCriteria {
  /** The address's `+tag`, exactly (tags are case-sensitive). `null` matches untagged mail only. */
  tag?: string | null;
  /** Subject: a substring, or a RegExp */
  subject?: string | RegExp;
  /** Any From address: the address (case-insensitive), or a RegExp tested against "Name <address>" */
  from?: string | RegExp;
  /** Any To or Cc address: the address (case-insensitive), or a RegExp */
  to?: string | RegExp;
}

/** Options for `emails.list()`. */
export interface ListEmailsOptions extends EmailCriteria {
  /** Maximum number of emails to fetch before filtering (default: 50) */
  limit?: number;
  /** Only emails received after this timestamp (ms) */
  since?: number;
}

/** Options for `emails.waitFor()`. */
export interface WaitForEmailOptions extends EmailCriteria {
  /** Maximum time to wait (ms or duration string like "60s") (default: 60000) */
  timeout?: number | string;
  /** Interval between polls (default: 1000) */
  pollInterval?: number | string;
  /** Only emails received after this timestamp (ms) (default: five minutes ago) */
  since?: number;
  /** Extra filter on top of the criteria */
  match?: (email: EmailRequest) => boolean;
}

/** Options for `emails.waitForAll()`. */
export interface WaitForEmailsOptions extends WaitForEmailOptions {
  /** Number of matching emails to collect */
  count: number;
}

/** Options for `emails.sendTest()`. */
export interface SendTestEmailOptions {
  /** Deliver to `{slug}+{tag}@...` instead of the plain address */
  tag?: string;
}

/** Result of `emails.sendTest()`. */
export interface SendTestEmailResult {
  status: "captured";
  /** ID of the captured email (null when the server could not tell) */
  requestId: string | null;
}

/** Options for `forwarding.configure()`. Only the fields you pass change. */
export interface ConfigureForwardingOptions {
  /** https URL on a public host name, or null to remove it (forwarding must be off) */
  url?: string | null;
  /** Turn forwarding on or off. Turning it on needs a URL, sent now or saved before. */
  enabled?: boolean;
  /** Forward HTTP requests */
  http?: boolean;
  /** Forward emails */
  email?: boolean;
  /** "auto" (default), "as_received", "json" or "chat" */
  format?: ForwardFormatSetting;
  /**
   * Your own headers, sent with every relayed and signed JSON delivery (not
   * chat), at most 10. Replaces the whole list; a null value keeps the value
   * stored under that name.
   */
  headers?: ForwardHeaderInput[];
  /** Add the path after the slug to the URL for relayed requests (default: true) */
  appendPath?: boolean;
  /** Retry failed deliveries for 86400 (default), 3600 or 0 seconds */
  retrySeconds?: ForwardRetrySeconds;
  /** One delivery at a time, in capture order (default: false) */
  keepOrder?: boolean;
  /**
   * A JSON body field with the sender's own timestamp, such as "publishedAt"
   * or "data.publishedAt"; null clears it. Deliveries then record it, and chat
   * messages say how long after it each request arrived.
   */
  sentField?: string | null;
}

/** The sender's own timestamp, as read from a request. */
export interface SenderTime {
  /** Milliseconds since the epoch */
  at: number;
  /** Where it was read: the body field, or a header such as "webhook-timestamp" */
  source: string;
  /** The timestamp has whole seconds only */
  wholeSeconds: boolean;
}

/** How a delivery went out. */
export type DeliveryFormat = "as_received" | "json" | "chat" | "template";

/** Result of `forwarding.test()`: one delivery of the newest request (or a sample) to the saved URL. */
export interface ForwardingTestResult {
  /** HTTP status the URL answered, or null when no answer arrived */
  status: number | null;
  durationMs: number;
  /** The start of the response body */
  excerpt: string | null;
  /** Why no answer arrived (timeout, refused connection, TLS problem) */
  error: string | null;
  /** True when the URL answered 2xx */
  delivered: boolean;
  /** Nothing of that kind had arrived yet, so a sample was sent */
  sample: boolean;
  /** Which kind was sent */
  kind?: "http" | "email";
  /** How it went out */
  format?: DeliveryFormat | null;
  /** The URL it went to, path appended */
  url?: string;
  /** Host and path, as the delivery log records it */
  target?: string | null;
  /** What was sent */
  request?: { method: string; path: string; subject: string | null; receivedAt: number };
  /** The sender's own timestamp, when the request had one */
  sender?: SenderTime | null;
}

/** One try of a delivery. */
export interface DeliveryAttempt {
  /** When the try ended */
  attemptedAt: number;
  status: number | null;
  durationMs: number;
  error: string | null;
  responseExcerpt: string | null;
}

/** One delivery of a captured request or email, with every try. */
/** The destination a delivery went to, as the log names it. */
export interface DeliveryDestinationRef {
  id: string;
  /** Its name, or null to name it by host */
  name: string | null;
  /** Its URL (scheme and host only for team members) */
  url: string;
}

export interface ForwardingDelivery {
  id: string;
  requestId: string;
  kind?: "http" | "email";
  /** "skipped": the destination's filter turned the request down */
  status: "pending" | "succeeded" | "failed" | "skipped";
  /** Null for deliveries from before destinations, or once the destination is removed */
  destination?: DeliveryDestinationRef | null;
  attempts: number;
  createdAt: number;
  finishedAt: number | null;
  /** When the next try is due, for pending deliveries */
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  /** How it went out */
  format?: DeliveryFormat | null;
  /** Host and path it went to (the host only for chat webhooks and for team members) */
  target?: string | null;
  /** The sender's own timestamp and where it was read, when the request had one */
  senderAt?: number | null;
  senderSource?: string | null;
  attemptLog: DeliveryAttempt[];
}

/** A row of an endpoint's delivery log, as `forwarding.deliveries()` lists it. */
export interface DeliveryLogEntry {
  id: string;
  requestId: string;
  kind?: "http" | "email";
  status: ForwardingDelivery["status"];
  destination?: DeliveryDestinationRef | null;
  attempts: number;
  createdAt: number;
  finishedAt?: number | null;
  nextAttemptAt?: number | null;
  lastStatus: number | null;
  lastError: string | null;
  /** The destination's time on the latest try */
  lastDurationMs?: number | null;
  format?: DeliveryFormat | null;
  /** The email's subject (emails) */
  subject: string | null;
  /** The request's method and path (HTTP requests) */
  method?: string | null;
  path?: string | null;
  /** When webhooks.cc received the request */
  receivedAt?: number | null;
  /** The sender's own timestamp, when the request had one */
  senderAt?: number | null;
  senderSource?: string | null;
  /** Pass as `before` to list the rows after this one */
  cursor?: string;
}

/** Options for `forwarding.deliveries()`. */
export interface ListDeliveriesOptions {
  /** 1 to 100 (default: 5) */
  limit?: number;
  /** "all" (default), "pending" (queued or retrying), "failed" or "skipped" (filtered out) */
  status?: "all" | "pending" | "failed" | "skipped";
  /** A row's `cursor`: list the rows after it */
  before?: string;
  /** Only one destination's deliveries */
  destinationId?: string;
}

/**
 * How a destination sends: "auto" picks from the URL (chat for Slack and
 * Discord, else as received for HTTP and signed JSON for email). The
 * inbound provider shapes ("postmark", "sendgrid", "mailgun",
 * "cloudmailin") apply to emails; HTTP requests to such a destination go as
 * received. "sheets" adds rows to a Google Sheet and "file_drop" (Business)
 * writes files to your SFTP, FTP or S3-compatible server.
 */
export type DestinationFormat =
  | "auto"
  | "as_received"
  | "json"
  | "chat"
  | "template"
  | "sheets"
  | "file_drop"
  | InboundEmailFormat;

/** How a destination's deliveries carry an email's stored attachments. */
export type DestinationAttachments = "links" | "inline" | "none";

/** A Google Sheets destination's settings (format "sheets"). */
export interface SheetsConfig {
  /** One of your connected Google accounts (connected in the dashboard) */
  connectionId: string;
  spreadsheetId: string;
  /** The tab rows go to */
  sheet: string;
  /** "email": a row per request; "line_items": a row per line item a layout found */
  rows: "email" | "line_items";
  /** Each column's header and its value, written with {{ placeholders }} */
  columns: { header: string; value: string }[];
}

/**
 * A file drop's settings (format "file_drop", Business): where the files go
 * and what each holds. The password, private key or secret key is sent
 * separately as `dropSecret` and never returned.
 */
export interface FileDropConfig {
  protocol: "sftp" | "ftp" | "ftps" | "s3";
  /** SFTP and FTP: the server, its port (22 or 21 by default) and the login */
  host?: string | null;
  port?: number | null;
  username?: string | null;
  /** The folder (relative to the login's home) or, for S3, the key prefix; "" for the root */
  folder: string;
  /** SFTP: the server's host key fingerprint, pinned on the first connection */
  hostKey?: string | null;
  /** FTPS and S3: a self-signed certificate's SHA-256 fingerprint to accept */
  tlsFingerprint?: string | null;
  /** S3: the storage endpoint, region, bucket and access key ID */
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  accessKeyId?: string | null;
  /** What each file holds: CSV or XML rows from `columns`, or JSON documents */
  file: "csv" | "json" | "xml";
  /** CSV and XML: a row per request, or a row per line item a layout found */
  rows: "email" | "line_items";
  /** CSV and XML: each column's header and its value, written with {{ placeholders }} */
  columns: { header: string; value: string }[];
  /** Put before each file's name */
  prefix?: string;
  /** One file per batch (what arrives during the destination's delaySeconds) instead of one per request */
  batch?: boolean;
}

/** The secret a file drop logs in with: one of these, as its protocol needs. */
export interface FileDropSecret {
  password?: string;
  privateKey?: string;
  secretAccessKey?: string;
}

/** Which captured requests a destination gets; null or no conditions: all of them. */
export interface DestinationFilter {
  logic?: "and" | "or";
  /** Response rule conditions plus kind, email (subject, from, to, text, tag), spam_score, email_auth and signature */
  conditions: Condition[];
}

/**
 * Where an endpoint's captures go. An endpoint has up to 10 destinations;
 * every capture is queued once for each one that is on and takes its kind,
 * and the destination's filter decides whether it is sent.
 */
export interface Destination {
  id: string;
  /** Place in the list (also the order captures are queued in) */
  position: number;
  name: string | null;
  enabled: boolean;
  url: string;
  /** Whether it has a signing secret (`destinations.secret()` reveals it) */
  hasSecret: boolean;
  /** For format "mailgun": whether a Mailgun signing key is saved (it is never returned) */
  hasMailgunSigningKey?: boolean;
  /** For format "file_drop": whether its password, key or secret key is saved (it is never returned) */
  hasDropSecret?: boolean;
  /** Takes HTTP requests */
  http: boolean;
  /** Takes emails */
  email: boolean;
  format: DestinationFormat;
  filter: DestinationFilter | null;
  /** For format "template": the JSON body, with {{ placeholders }} filled in per request */
  bodyTemplate: unknown;
  /** For format "chat": the message text with {{ placeholders }}; null sends the standard message */
  messageTemplate: string | null;
  /** Names and masked values */
  headers: { name: string; value: string }[];
  /** Append the captured path to the URL (as received) */
  appendPath: boolean;
  /** 0 (one try), 3600 or 86400 */
  retrySeconds: number;
  /** One delivery at a time, in capture order */
  keepOrder: boolean;
  /** A JSON body field with the sender's own timestamp */
  sentField: string | null;
  /** At most one delivery every N seconds (0: every capture); the rest are not sent */
  throttleSeconds: number;
  /** Seconds after the capture before the first try, like a callback */
  delaySeconds: number;
  /** Emails kept in storage: attachments as signed links (default), inline base64, or names only */
  attachments?: DestinationAttachments;
  /** For format "sheets": the spreadsheet and columns; for "file_drop": where files go and what they hold */
  config?: SheetsConfig | FileDropConfig | null;
  /** "forward": what the endpoint's forward* fields stand for; "notify": its notificationUrl */
  role: "forward" | "notify" | null;
  createdAt: number;
  updatedAt: number;
  /** With `list(slug, { summary: true })`: the last 24 hours and what is waiting */
  summary?: {
    last24h: { delivered: number; failed: number; skipped: number };
    pending: number;
  };
}

/** Fields to create or change a destination with; `url` is needed to create one. */
export interface DestinationInput {
  url?: string;
  name?: string | null;
  enabled?: boolean;
  http?: boolean;
  email?: boolean;
  format?: DestinationFormat;
  filter?: DestinationFilter | null;
  bodyTemplate?: unknown;
  messageTemplate?: string | null;
  /** For format "mailgun": your Mailgun HTTP webhook signing key, so `signature` verifies; null removes it */
  mailgunSigningKey?: string | null;
  /** The whole set; a null value keeps the stored value of that name */
  headers?: ForwardHeaderInput[];
  appendPath?: boolean;
  retrySeconds?: 0 | 3600 | 86400;
  keepOrder?: boolean;
  sentField?: string | null;
  /** 0 to 3600 */
  throttleSeconds?: number;
  /** 0 to 3600 */
  delaySeconds?: number;
  /** How emails' stored attachments travel */
  attachments?: DestinationAttachments;
  /**
   * For format "sheets": the spreadsheet and columns (the url becomes the
   * spreadsheet's); for "file_drop": where files go and what they hold (no url)
   */
  config?: SheetsConfig | FileDropConfig | null;
  /**
   * For format "file_drop": the password, private key or S3 secret key;
   * needed again whenever the drop's server or login changes
   */
  dropSecret?: FileDropSecret | null;
  /** Place in the list */
  position?: number;
}

/**
 * Fields to create a destination with: `url` is needed, except for a file
 * drop, whose address comes from its config.
 */
export type DestinationCreateInput =
  | (DestinationInput & { url: string })
  | (DestinationInput & { format: "file_drop"; config: FileDropConfig });

/** An endpoint's alert settings. */
export interface AlertSettings {
  enabled: boolean;
  /** Emails in a row that miss a required field before an alert opens; null is off */
  fieldFailures: number | null;
  /** Percent of the last 20 emails that missed a field; null is off */
  fieldFailureShare: number | null;
  /** Fields that must be found; null means every email field */
  requiredFields: string[] | null;
  /** Hours without an email before an alert opens; null is off */
  silenceHours: number | null;
  /** Open an alert when a delivery fails for good */
  destinationFailures: boolean;
  /** Email the endpoint's owner */
  notifyEmail: boolean;
  /** This endpoint's destinations that also get alerts (alert.opened / alert.resolved events) */
  notifyDestinationIds: string[];
}

/** One alert, open (resolvedAt null) or resolved. */
export interface AlertEvent {
  id: string;
  kind: "fields" | "silence" | "destination";
  /** The destination, for destination alerts */
  subject: string | null;
  openedAt: number;
  resolvedAt: number | null;
  details: Record<string, unknown>;
}

/** A stored attachment, downloaded. */
export interface AttachmentDownload {
  bytes: Uint8Array;
  filename: string | null;
  contentType: string;
}

/** Options for `destinations.preview()`. */
export interface PreviewDestinationOptions {
  /** A saved destination to start from */
  destinationId?: string;
  /** Unsaved fields, on top of the saved destination or on their own (then with a url) */
  destination?: DestinationInput;
  /** A captured request (default: the newest of the kind the destination takes, or a sample) */
  requestId?: string;
}

/** Result of `destinations.preview()`: what would be sent, without sending it. */
export interface DestinationPreview {
  request: {
    id: string | null;
    kind: "http" | "email";
    method: string;
    path: string;
    subject: string | null;
    receivedAt: number;
    sample: boolean;
  };
  /** Whether the destination takes this kind at all */
  takesKind: boolean;
  /** Whether its filter lets the request through */
  filterPasses: boolean;
  format: DeliveryFormat;
  /** The request it would send (stored header values stay masked), or null */
  delivery: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    bodyBase64: string | null;
  } | null;
  /** Why nothing would be sent (a template that cannot be filled in, a path that escapes) */
  error: string | null;
}

/** Result of `destinations.test()`. */
export interface DestinationTestResult extends ForwardingTestResult {
  /** Whether the destination's filter would have let it through (a test sends either way) */
  filterPasses: boolean;
  /** For a file drop: the test file written (`delivered` says whether it was) */
  file?: string;
  /** For an SFTP file drop: the server's host key, pinned on the drop by its first connection */
  hostKey?: string | null;
}

/** Result of `forwarding.summary()`. Each count stops at 100,000. */
export interface DeliverySummary {
  /** Among deliveries queued in the last 24 hours */
  last24h: { delivered: number; failed: number };
  /** Waiting now: queued or retrying */
  pending: number;
  /** Failed, among the deliveries still kept */
  failed: number;
  total: number;
}

/** @deprecated Use `ForwardingDelivery`. */
export type EmailDelivery = ForwardingDelivery;
/** @deprecated Use `DeliveryAttempt`. */
export type EmailDeliveryAttempt = DeliveryAttempt;
/** @deprecated Use `DeliveryLogEntry`. */
export type RecentEmailDelivery = DeliveryLogEntry;

/** The `type` of a captured HTTP request forwarded as signed JSON. */
export const REQUEST_RECEIVED = "request.received";

/**
 * A captured HTTP request as forwarding posts it in the "Signed JSON" format
 * (verify it with `verifyForwardedRequest()`): the same envelope as
 * `email.received`, signed with Standard Webhooks headers.
 */
export interface RequestReceivedEvent {
  type: typeof REQUEST_RECEIVED;
  /** When webhooks.cc received the request, the same on every copy */
  timestamp: string;
  data: {
    id: string;
    endpoint: { slug: string; name: string | null };
    receivedAt: string;
    method: string;
    path: string;
    /** The query string as sent, without the "?" */
    query: string | null;
    headers: Record<string, string>;
    contentType: string | null;
    ip: string;
    size: number;
    /** The body as text, or null when it is empty or not UTF-8 */
    body: string | null;
    /** The exact bytes in base64 when the body is not valid UTF-8 */
    bodyBase64: string | null;
  };
}

/** What `verifyRelayedRequest()` read from a request forwarded as received. */
export interface RelayedRequestInfo {
  /** The request's id in webhooks.cc, the same on every try and redelivery */
  requestId: string;
  /** When webhooks.cc received it, RFC 3339 UTC with milliseconds */
  receivedAt: string;
  /** The endpoint's slug */
  endpoint: string | null;
  /** Which try this is, from 1 */
  attempt: number | null;
}

/** Options for `emails.render()`: a provider's shape, or "json" for the `email.received` JSON. */
export interface RenderEmailOptions {
  format: InboundEmailFormat | "json";
  /** For "mailgun": the signing key to sign `signature` with */
  mailgunSigningKey?: string;
}

/** An email in an inbound provider's shape, as `emails.render()` returns it: post it to your handler. */
export interface RenderedEmail {
  format: InboundEmailFormat | "json";
  method: "POST";
  /** Content-Type and the rest a provider would send */
  headers: Record<string, string>;
  body: string;
}

/** Options for `endpoints.previewLayouts()`. */
export interface PreviewLayoutsOptions {
  /** Try these instead of the saved layouts */
  layouts?: Layout[];
  /** A captured email (default: the endpoint's newest) */
  requestId?: string;
}

/** What layouts find in a captured email; attachments show an earlier parse, never a new one. */
export interface LayoutsPreview {
  /** What is wrong with `layouts`, if given; empty when they are valid */
  problems: string[];
  layoutsCap: number;
  request: { id: string; subject: string | null; receivedAt: number } | null;
  parsed: ParsedEmail | null;
}

/** An API key of the account, as the API lists it (the key itself is never listed). */
export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

/** A new API key. `key` is shown once and never again. */
export interface CreatedApiKey {
  key: string;
  name: string;
  keyPrefix: string;
  expiresAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "completed" | "expired";

/**
 * Something only the account's owner may allow, asked for by an API key or
 * agent. Show the person `url` (the page shows `code` to compare) and wait.
 */
export interface Approval {
  id: string;
  status: ApprovalStatus;
  action: string;
  /** One sentence saying what the person is asked to allow. */
  summary: string;
  code: string;
  url: string;
  expiresAt: string;
}

/** An approval being waited on; `wait()` resolves with what it grants. */
export interface PendingApproval<T> extends Approval {
  wait(options?: WaitForApprovalOptions): Promise<T>;
}

export interface WaitForApprovalOptions {
  /** Give up after this many milliseconds (default: until the approval expires). */
  timeout?: number;
  /** Milliseconds between polls (default 2000, at least 1000). */
  pollInterval?: number;
  signal?: AbortSignal;
}

/** An agent connected to the account (claimed, or signed in through OAuth). */
export interface ConnectedAgent {
  id: string;
  clientName: string | null;
  kind: string;
  /** Milliseconds since the epoch. */
  connectedAt: number;
  lastUsedAt: number | null;
}

/**
 * A public link to a frozen copy of one request, at `/s/{token}`. Anyone who
 * has the link can read it until `expiresAt` (milliseconds since the epoch).
 */
export interface ShareLink {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  /** Headers left out of the copy. */
  redactedHeaders: string[];
}

/** A share link as the account lists them, with the request it copies. */
export interface AccountShareLink extends ShareLink {
  method: string;
  path: string;
  detectedProvider: string | null;
  detectedEvent: string | null;
  /** Null once the request is gone; the link still works. */
  requestId: string | null;
  endpointSlug: string | null;
}

/** A share link made through an approval. */
export interface CreatedShareLink {
  id: string;
  url: string;
  expiresAt: string;
  redactedHeaders: string[];
}

/** Mail to `localPart@domain` goes to the endpoint. */
export interface InboundDomainRoute {
  localPart: string;
  endpointId: string;
}

/** A custom domain that receives mail (Business, or Team Business). */
export interface InboundDomain {
  id: string;
  domain: string;
  status: "pending" | "verified" | "lapsed";
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  failedChecks: number;
  catchAllEndpointId: string | null;
  routes: InboundDomainRoute[];
  /** The DNS records to add. */
  records: { txt: { name: string; value: string }; mx: { name: string; value: string } };
  /** Receives mail now: verified and within what the plan allows. */
  active: boolean;
}

/** What a DNS check of a domain found. */
export interface DomainVerification {
  domain: InboundDomain;
  records: { txt: boolean; mx: boolean };
  /** Another account had the domain, and lost it to this one. */
  tookOver: boolean;
}

/** A domain removed through an approval. */
export interface RemovedDomain {
  removed: string;
  domainId: string;
}

/** A Google account connected for Google Sheets destinations. */
export interface GoogleConnection {
  id: string;
  email: string | null;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

export interface GoogleConnections {
  /** Google Sheets is set up on this server. */
  available: boolean;
  connections: GoogleConnection[];
}

/** A Google account connected through an approval. */
export interface ConnectedGoogleAccount {
  connectionId: string;
  email: string | null;
}

/** A spreadsheet the account's owner chose from Drive through an approval. */
export interface PickedSpreadsheet {
  connectionId: string;
  spreadsheetId: string;
  url: string;
  /** Its tabs, for choosing the one rows go to. */
  tabs: string[];
}

/** A new spreadsheet, or the header row written into an existing one. */
export interface SpreadsheetWrite {
  id: string;
  url?: string;
  /** For an existing spreadsheet: false when its first row held something else and was left as it was. */
  headerWritten?: boolean;
}

/** What AI setup is asked to do with the chosen emails. */
export type AiSetupAsk =
  | { kind: "field"; name: string; description: string }
  | { kind: "layout"; description?: string }
  | { kind: "repair"; field: EmailField };

export interface AiSetupStatus {
  /** AI setup is offered on this server. */
  offered: boolean;
  /** Assists the plan allows in a rolling 30 days, and how many were used. */
  allowed: number;
  used: number;
  /** When the oldest counted assist stops counting. */
  nextAt: string | null;
}

/** What AI setup proposed: nothing is saved until the fields or layout are applied. */
export interface AiSetupResult {
  /** Each proposed field, with the value it found in each email, in order. */
  fields: { field: EmailField; values: string[] }[];
  /** For a layout: a condition every email meets, to pick the layout. */
  match: Condition | null;
  layoutName: string | null;
  /** Proposals dropped because they did not compile or missed an email. */
  dropped: number;
  allowed: number;
  used: number;
}

/** An add-on's state for one account or team (extra requests, parsed pages or domains). */
export type CapacityResource = "requests" | "pages" | "domains";

/**
 * The add-ons of one account or team for one resource, as the API reads them
 * (`GET /api/billing/capacity`). Fields beyond these may appear.
 */
export interface CapacityState {
  /** False until the add-on products are configured. */
  offered: boolean;
  /** The account has a live plan that allows add-ons. */
  eligible: boolean;
  /** The plan is set to end; add-ons end with it. */
  planEnding: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  /** Monthly blocks: units this period and what the renewal brings; null when none */
  blocks?: {
    units: number;
    pendingUnits: number | null;
    cancelAtPeriodEnd: boolean;
    pastDue: boolean;
    periodEnd: string | null;
  } | null;
  /** One-time blocks left, in the resource's units */
  creditRequests?: number;
  /** Metered overage */
  overage?: {
    subscribed: boolean;
    active: boolean;
    cancelAtPeriodEnd: boolean;
    pastDue: boolean;
    maxRequests: number;
    usedRequests: number;
  };
  [field: string]: unknown;
}

/** What the account pays for (`GET /api/billing`). Changing it still takes a browser session. */
export interface BillingSummary {
  plan: "free" | "pro" | "business";
  /** The plan's subscription; null on Free. */
  subscription: {
    status: "active" | "canceled" | "past_due" | null;
    interval: "month" | "year" | null;
    /** When it renews, or ends with `cancelAtPeriodEnd`. */
    renewsAt: string | null;
    cancelAtPeriodEnd: boolean;
    pendingChange: { plan: string; interval: "month" | "year" | null } | null;
  } | null;
  quotaPeriod: { start: string | null; end: string | null };
  addons: Record<CapacityResource, CapacityState>;
  /** Every team the account belongs to, with its subscription and add-ons. */
  teams: (Team & { addons: Record<CapacityResource, CapacityState> })[];
}

/** The price of changing a team's plan (the team's owner only). */
export interface TeamPlanQuote {
  plan: "team" | "team_business";
  interval: "month" | "year";
  seats: number;
  /** "now" for an upgrade, charged at once; "renewal" for a downgrade. */
  applies: "now" | "renewal";
  creditCents: number;
  chargeCents: number;
  creditAppliedCents: number;
  dueNowCents: number;
  renewalCents: number;
  periodEnd: string;
}

/** The price of changing a team's seat count (the team's owner only). */
export interface TeamSeatQuote {
  currentSeats: number;
  newSeats: number;
  pendingSeats: number | null;
  /** A reduction waits for the renewal; nothing is charged now. */
  appliesAtRenewal: boolean;
  pricePerSeatCents: number;
  prorationCents: number;
  creditAppliedCents: number;
  dueNowCents: number;
  renewalCents: number;
  [field: string]: unknown;
}
