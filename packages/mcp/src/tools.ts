import { z } from "zod";
import {
  diffRequests,
  extractJsonField,
  parseDuration,
  MOCK_RESPONSE_DELAY_MAX,
  MOCK_RESPONSE_DELAY_MIN,
  MOCK_RESPONSE_STATUS_MAX,
  MOCK_RESPONSE_STATUS_MIN,
  MAX_CONDITION_VALUE_LEN,
  MAX_CONDITION_NAME_LEN,
  MAX_CONDITION_PATH_LEN,
  MAX_RULE_NAME_LEN,
  ApprovalDeniedError,
  ApprovalExpiredError,
  NotFoundError,
  RateLimitError,
  TEMPLATE_METADATA,
  TEMPLATE_PROVIDERS,
  TimeoutError,
  UnauthorizedError,
  VERIFY_PROVIDERS,
  verifySignature,
  WebhooksCC,
  WebhooksCCError,
  DEFAULT_EMAIL_DOMAIN,
  extractCode,
  extractLink,
  detectWebhookInfo,
  generateRequestSchema,
  PAYLOAD_SCHEMA_FORMATS,
  CONDITION_FIELDS,
  CONDITION_OPS,
  conditionIssues,
  type ConditionField,
  type EmailRequest,
  type Endpoint,
  type LiveShare,
  type TunnelShareList,
  type PayloadSchemaFormat,
  type Request,
  type VerifyProvider,
} from "@webhooks-cc/sdk";
import {
  capExtracts,
  capLists,
  trimParsed,
  compactRequest,
  cutEmailText,
  cutStringToFit,
  jsonSize,
  keepOnly,
  MAX_OUTPUT,
  omitHeaders,
  shrinkToFit,
  trimSpam,
  sliceText,
  TEXT_FLOOR,
} from "./compact";
import { TOOL_CATALOG, toolAnnotations, type ToolGroup } from "./catalog";
import { appToolMeta } from "./app";

const MAX_BODY_SIZE = MAX_OUTPUT;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const TIME_SEPARATOR = " — ";

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Only http and https URLs are supported" }
  );
const methodSchema = z.enum(HTTP_METHODS).default("POST").describe("HTTP method (default: POST)");
const kindSchema = z
  .enum(["http", "email"])
  .optional()
  .describe('Only HTTP requests ("http") or only captured emails ("email")');
/** With a tag, subject or sender filter, `list_emails` searches this many of the newest emails. */
const EMAIL_SCAN_LIMIT = 100;
const durationOrTimestampSchema = z.union([z.string(), z.number()]);
/**
 * A condition of a response rule ("response": the HTTP request) or a
 * forwarding filter ("filter": also kind, email parts, spam score, sender
 * checks and the signature check). Checked with the SDK's rule language, so
 * an agent learns what is wrong before the API is called.
 */
const CONDITION_FIELD_NAMES = Object.keys(CONDITION_FIELDS) as ConditionField[];
const CONDITION_OP_NAMES = CONDITION_OPS;

function conditionSchema(use: "response" | "filter") {
  const fields =
    use === "response"
      ? CONDITION_FIELD_NAMES.filter((field) => CONDITION_FIELDS[field].response)
      : CONDITION_FIELD_NAMES;
  return z
    .object({
      field: z
        .enum(fields as [ConditionField, ...ConditionField[]])
        .describe(
          use === "response"
            ? "What to read: method, path, header (name), query (name), body (text), body_path (path into a JSON or form body), content_type, size"
            : "What to read: method, path, header (name), query (name), body, body_path (path), content_type, size, kind (http or email), email (name: subject, from, to, text or tag), spam_score, email_auth (name: spf, dkim or dmarc), signature (verified, failed or missing)"
        ),
      op: z
        .enum(CONDITION_OP_NAMES)
        .describe(
          "eq, neq, contains, not_contains, starts_with, ends_with, matches (glob: * one path segment, ** any, ? one character), regex (RE2, searched anywhere; (?i) ignores case), exists, not_exists, gt, gte, lt, lte (numbers)"
        ),
      value: z
        .string()
        .max(MAX_CONDITION_VALUE_LEN)
        .optional()
        .describe(`What to compare with (not for exists and not_exists)`),
      name: z
        .string()
        .max(MAX_CONDITION_NAME_LEN)
        .optional()
        .describe("Header or query parameter name; the email part; spf, dkim or dmarc"),
      path: z
        .string()
        .max(MAX_CONDITION_PATH_LEN)
        .optional()
        .describe('Dot path for body_path, e.g. data.object.status or items.0.sku or a["odd.key"]'),
    })
    .superRefine((condition, ctx) => {
      for (const issue of conditionIssues(condition, { use })) {
        ctx.addIssue({ code: "custom", message: issue });
      }
    });
}

const ruleConditionSchema = conditionSchema("response");

const emailFieldSchema = z.object({
  name: z.string().describe("Letters, digits and _, starting with a letter: {{ fields.name }}"),
  from: z
    .enum(["subject", "text", "html", "from", "to", "header"])
    .describe("What it reads; html is the HTML as text"),
  header: z.string().optional().describe('The header name, for from "header"'),
  pattern: z
    .string()
    .describe("RE2 regular expression; the first group is the value (no lookarounds)"),
});

const layoutSchema = z.object({
  id: z.string().describe("Stable id: 1 to 40 letters, digits, - or _"),
  name: z.string().max(100),
  enabled: z.boolean().optional().describe("Off: kept but never matched (default on)"),
  match: z
    .object({
      logic: z.enum(["and", "or"]).optional(),
      conditions: z.array(conditionSchema("filter")).max(10),
    })
    .optional()
    .describe("When it applies, e.g. the sender or subject; no conditions: every email"),
  fields: z.array(emailFieldSchema).max(20).optional().describe("Named values, as emailFields"),
  lineItems: z
    .object({
      from: z.enum(["text", "html", "attachment"]),
      pattern: z
        .string()
        .optional()
        .describe(
          "text/html: RE2 with named groups found again and again, one row each, e.g. (?P<sku>[A-Z]+-\\d+)\\s+x(?P<qty>\\d+)"
        ),
      start: z.string().optional().describe("text/html: search only after this (RE2)"),
      end: z.string().optional().describe("text/html: and before this (RE2)"),
      attachment: z
        .string()
        .optional()
        .describe("attachment: file name with * and ? (default: the first spreadsheet or CSV)"),
      sheet: z.string().optional().describe("attachment: sheet name (default: the first)"),
      columns: z
        .array(z.object({ name: z.string(), column: z.string() }))
        .max(30)
        .optional()
        .describe("attachment: { name, column: header text or letter }; default: every column"),
    })
    .nullable()
    .optional()
    .describe("Rows such as an order's products"),
  parseAttachments: z
    .boolean()
    .optional()
    .describe("Parse CSV, XLSX, ODS, PDF text and text files into the JSON; uses parsed pages"),
});

const destinationFields = {
  name: z.string().max(100).nullable().optional().describe("A name for the list and the log"),
  enabled: z.boolean().optional().describe("Send to it (default true)"),
  http: z.boolean().optional().describe("Takes HTTP requests (default true)"),
  email: z.boolean().optional().describe("Takes emails (default true)"),
  filter: z
    .object({
      logic: z.enum(["and", "or"]).optional().describe("and (default): every condition; or: any"),
      conditions: z.array(conditionSchema("filter")).max(10),
    })
    .nullable()
    .optional()
    .describe(
      "Send only captures that match (null: everything it takes). Conditions like response rules plus kind, email (name: subject, from, to, text, tag), spam_score, email_auth (name: spf, dkim, dmarc) and signature (verified, failed, missing)"
    ),
  format: z
    .enum([
      "auto",
      "as_received",
      "json",
      "template",
      "chat",
      "postmark",
      "sendgrid",
      "mailgun",
      "cloudmailin",
    ])
    .optional()
    .describe(
      "auto (pick from the URL), as_received (relay HTTP requests unchanged; emails as signed JSON), json (signed JSON envelope), template (your bodyTemplate, signed like json), chat (Slack or Discord message), or an inbound mail provider's shape for emails (postmark, sendgrid, mailgun, cloudmailin; HTTP requests then go as received), to test the inbound handler you wrote for that provider"
    ),
  mailgunSigningKey: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe(
      "For format mailgun: your Mailgun HTTP webhook signing key, so the form's signature verifies; null removes it. Write-only."
    ),
  bodyTemplate: z
    .unknown()
    .optional()
    .describe(
      'For format template: any JSON value whose strings hold {{ placeholders }}, e.g. {"event": "{{ json.type }}", "amount": "{{ json.data.amount }}", "code": "{{ codes.0 }}"}. A string that is only a placeholder keeps the value\'s type; a missing field becomes null. HTTP requests read method, path, query.x, headers.x, body, json.path, id, receivedAt, signature; emails read the email.received fields (subject, from.address, to, text, codes, links, auth, spam, tag)'
    ),
  messageTemplate: z
    .string()
    .max(4000)
    .nullable()
    .optional()
    .describe(
      "For format chat: the message text with {{ placeholders }}; null sends the standard message"
    ),
  headers: z
    .array(
      z.object({
        name: z.string().describe("Header name, e.g. Authorization"),
        value: z.string().nullable().describe("Value, or null to keep the stored one"),
      })
    )
    .max(10)
    .optional()
    .describe("Your own headers for every delivery (not chat). Replaces the whole list"),
  appendPath: z.boolean().optional().describe("Append the captured path to the URL (as_received)"),
  retrySeconds: z
    .union([z.literal(0), z.literal(3600), z.literal(86400)])
    .optional()
    .describe("Retry failed deliveries for 86400 (default), 3600 or 0 seconds"),
  keepOrder: z.boolean().optional().describe("One delivery at a time, in capture order"),
  sentField: z
    .string()
    .max(128)
    .nullable()
    .optional()
    .describe("JSON body field with the sender's own timestamp"),
  throttleSeconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional()
    .describe(
      "At most one delivery every N seconds; the rest are not sent (1 makes a heads-up channel)"
    ),
  delaySeconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional()
    .describe("Wait this long after the capture before sending, like a callback"),
};

const responseRuleSchema = z.object({
  name: z
    .string()
    .max(MAX_RULE_NAME_LEN)
    .optional()
    .describe(`Human-readable rule name (max ${MAX_RULE_NAME_LEN} chars)`),
  enabled: z.boolean().optional().default(true).describe("Whether this rule is active"),
  logic: z
    .enum(["and", "or"])
    .optional()
    .default("and")
    .describe('How to combine conditions: "and" (all match) or "or" (any match)'),
  conditions: z.array(ruleConditionSchema).min(1).max(10).describe("Conditions to evaluate (1-10)"),
  response: z.lazy(() => mockResponseSchema).describe("Response when conditions match"),
});

const responseRulesSchema = z
  .array(responseRuleSchema)
  .max(50)
  .describe("Ordered conditional response rules (first match wins, max 50)");

const mockResponseSchema = z.object({
  status: z
    .number()
    .int()
    .min(MOCK_RESPONSE_STATUS_MIN)
    .max(MOCK_RESPONSE_STATUS_MAX)
    .describe(`HTTP status code (${MOCK_RESPONSE_STATUS_MIN}-${MOCK_RESPONSE_STATUS_MAX})`),
  body: z
    .string()
    .default("")
    .describe(
      'Response body (default: empty). {{ placeholders }} are filled in from the request: {{ json.id }} (a JSON or form body field), {{ body }}, {{ headers.user-agent }}, {{ query.page }}, {{ method }}, {{ path }}, {{ id }}, {{ uuid }}, {{ now }}; filters: | default: "x", | json, | lower, | upper, | truncate: 80'
    ),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe("Response headers (default: none); values may use {{ placeholders }} too"),
  delay: z
    .number()
    .int()
    .min(MOCK_RESPONSE_DELAY_MIN)
    .max(MOCK_RESPONSE_DELAY_MAX)
    .optional()
    .describe(
      `Response delay in milliseconds (${MOCK_RESPONSE_DELAY_MIN}-${MOCK_RESPONSE_DELAY_MAX}, default: none)`
    ),
});

// Argument shapes the sandbox tools share with the full ones (sandbox-tools.ts),
// so a tool keeps its arguments when the server swaps to the full set.

/** Which site's dashboard lists an endpoint; listing only, both addresses capture either way. */
const endpointSiteSchema = z
  .enum(["webhooks", "mailhooks", "both"])
  .describe(
    "Which site's dashboard lists the endpoint: webhooks (webhooks.cc), mailhooks (mailhooks.cc) or both (the default when creating). Only the listing: its HTTP URL and email address work either way. Owner only to change."
  );

export const createEndpointShape = {
  name: z.string().optional().describe("Display name for the endpoint"),
  ephemeral: z.boolean().optional().describe("Create a temporary endpoint that auto-expires"),
  expiresIn: durationOrTimestampSchema
    .optional()
    .describe('Auto-expire after this duration, for example "12h"'),
  mockResponse: mockResponseSchema
    .optional()
    .describe("Optional mock response to return when the endpoint receives a request"),
  responseRules: responseRulesSchema
    .optional()
    .describe(
      "Conditional response rules. Each rule has conditions and a response. First matching rule wins."
    ),
  notificationUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "URL to POST a JSON summary to after each captured request (e.g. Slack/Discord webhook)"
    ),
  site: endpointSiteSchema.optional(),
  signingProvider: z
    .string()
    .optional()
    .describe(
      "Signing provider for automatic signature verification (e.g. stripe, github, shopify)"
    ),
  signingSecret: z
    .string()
    .optional()
    .describe(
      "Signing secret (encrypted server-side, never returned). Required when signingProvider is set."
    ),
  signingHeader: z
    .string()
    .optional()
    .describe("Custom signature header name. Only used with generic-hmac provider."),
};

export const listEndpointsShape = {
  team: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Team id or name (case-insensitive). Keeps endpoints shared with you from that team and endpoints you own that are shared with it."
    ),
};

export const getEndpointShape = { slug: z.string().describe("The endpoint slug") };

export const deleteEndpointShape = { slug: z.string().describe("The endpoint slug to delete") };

export const listRequestsShape = {
  endpointSlug: z.string().describe("The endpoint slug"),
  limit: z.number().int().min(1).max(100).default(25).describe("Max requests to return"),
  since: z.number().optional().describe("Only return requests after this timestamp in ms"),
  kind: kindSchema,
};

export const getRequestShape = { requestId: z.string().describe("The request ID") };

export const waitForRequestShape = {
  endpointSlug: z.string().describe("The endpoint slug to monitor"),
  timeout: durationOrTimestampSchema.default("30s").describe('How long to wait, for example "30s"'),
  pollInterval: durationOrTimestampSchema
    .optional()
    .describe('Interval between polls, for example "500ms" or "1s"'),
};

export const payloadSchemaShape = {
  endpointSlug: z.string().describe("The endpoint slug"),
  format: z
    .enum(PAYLOAD_SCHEMA_FORMATS as [PayloadSchemaFormat, ...PayloadSchemaFormat[]])
    .default("typescript")
    .describe(
      'Output: "typescript" interfaces, "zod" schemas, "pydantic" models, or "json-schema"'
    ),
  name: z
    .string()
    .max(100)
    .optional()
    .describe("Root type name (default: from the detected event, else WebhookPayload)"),
  event: z
    .string()
    .optional()
    .describe(
      'Only requests whose detected provider event matches, e.g. "invoice.paid" or "push". One event per schema gives the tightest types.'
    ),
  method: z.string().optional().describe("Only requests with this HTTP method"),
  path: z.string().optional().describe("Only requests with this path"),
  requestIds: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe("Use exactly these requests instead of the latest ones"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("How many of the latest requests to read before filtering"),
};

type PayloadSchemaArgs = {
  format: PayloadSchemaFormat;
  name?: string;
  event?: string;
  method?: string;
  path?: string;
};

function eventName(event: string): string {
  const words = event
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  if (!name) return "WebhookPayload";
  return /^[0-9]/.test(name) ? `Webhook${name}Event` : `${name}Event`;
}

/**
 * generate_payload_schema for the full and the sandbox tools: filter the
 * requests, learn one schema from their bodies, and say what it was built
 * from, warning when several events were mixed.
 */
export function payloadSchemaResult(requests: Request[], args: PayloadSchemaArgs): ToolResult {
  const method = args.method?.toUpperCase();
  const matching = requests.filter(
    (request) =>
      request.kind !== "email" &&
      (!method || request.method.toUpperCase() === method) &&
      (!args.path || request.path === args.path) &&
      (!args.event || detectWebhookInfo(request)?.event === args.event)
  );
  if (matching.length === 0) {
    throw new Error(
      `None of the ${requests.length} requests read matched. Capture a request first, or loosen event, method or path.`
    );
  }
  const events = [
    ...new Set(
      matching.map((request) => detectWebhookInfo(request)?.event).filter((e): e is string => !!e)
    ),
  ];
  const name = args.name ?? (events.length === 1 ? eventName(events[0]) : undefined);
  const result = generateRequestSchema(matching, { format: args.format, name });
  if (result.samples === 0) {
    throw new Error(
      `None of the ${matching.length} matching requests has a JSON or form body to learn from.`
    );
  }
  const output = {
    format: result.format,
    name: result.name,
    samples: result.samples,
    skipped: result.skipped,
    ...(events.length > 0 ? { events } : {}),
    ...(events.length > 1
      ? {
          warning: `The samples mix ${events.length} events, so fields of one event show up as optional. Pass event for one schema per event.`,
        }
      : {}),
    code: result.code,
  };
  // Measured as sent: escaping quotes and newlines makes the JSON longer than
  // the code, and a schema cut to fit would be useless.
  const size = JSON.stringify(output, null, 2).length;
  if (size > MAX_OUTPUT) {
    throw new Error(
      `The schema is ${result.code.length} characters, more than this tool can return. Narrow it with event or requestIds, or call generateRequestSchema() from @webhooks-cc/sdk in code.`
    );
  }
  return jsonContent(output);
}

type TextContent = { type: "text"; text: string };
export type ToolResult = {
  content: TextContent[];
  isError?: boolean;
  /**
   * An approval the person opens: a server whose client can open a URL for
   * the person (URL elicitation) asks it to, and the retried call finishes
   * the approval (toolTarget). Never sent as is: the adapters turn it into
   * an input request or drop it.
   */
  approval?: PendingApprovalAsk;
};

/** What a tool asked the account's owner to approve. */
export interface PendingApprovalAsk {
  id: string;
  summary: string;
  url: string;
  code: string;
  expiresAt: string;
}

/** What a server adapter knows about the call in progress. */
export interface ToolCall {
  /** The client can open a URL for the person (URL-mode elicitation). */
  urlElicitation: boolean;
  /** State a retried call carries back (an approval id). From the client: untrusted. */
  requestState?: string;
  /** How the client answered the URL request: accept, decline or cancel. */
  urlAnswer?: string;
}

/** Create a text content response for MCP tools. */
/** A new API key as a tool answer: the key is shown once, so say so. */
function keyText(key: { key?: string; name?: string; expiresAt?: string }): string {
  return [
    `Approved. The API key ${key.name ? `"${key.name}" ` : ""}is: ${key.key ?? "(not returned)"}`,
    `It is shown only this once: store it now (for example as a CI secret), never in code.`,
    key.expiresAt ? `It works until ${key.expiresAt}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** What an approved action handed back, for the agent to tell the person. */
function approvalResultText(result: Record<string, unknown>): string {
  if (typeof result.key === "string") return keyText(result);
  if (result.executed === false) {
    return `${String(result.reason ?? "Nothing was changed.")} Ask again for a new quote if the person still wants it.`;
  }
  if (result.executed === true) {
    const change = typeof result.change === "string" ? ` ${result.change}` : "";
    if (result.applied === "checkout") {
      return `Approved.${change} The person was sent to a Polar checkout; it takes effect once they pay there${typeof result.checkoutUrl === "string" ? ` (${result.checkoutUrl})` : ""}. Check get_billing afterwards.`;
    }
    const lost =
      typeof result.seatReductionLost === "number"
        ? ` The scheduled reduction to ${result.seatReductionLost} seats was dropped; set the seats again if they still want it.`
        : "";
    return `Approved and done.${change} ${result.applied === "renewal" ? "It takes effect at the renewal." : "It took effect at once."}${lost}`;
  }
  if (typeof result.spreadsheetId === "string") {
    const tabs = Array.isArray(result.tabs) ? result.tabs.join(", ") : "";
    return `Approved. The chosen spreadsheet is ${String(result.spreadsheetId)} (${String(result.url)}), on connection ${String(result.connectionId)}${tabs ? `; its tabs: ${tabs}` : ""}. Use them in a Sheets destination's config.`;
  }
  if (Array.isArray(result.fields)) {
    return `Approved. AI setup proposed (nothing is saved until you apply it):\n${JSON.stringify(result, null, 2)}`;
  }
  if (typeof result.connectionId === "string") {
    return `Approved. The Google account ${result.email ? `${String(result.email)} ` : ""}is connected as ${result.connectionId}.`;
  }
  if (typeof result.url === "string") {
    return `Approved. The share link is ${result.url} (anyone with it can read the copy until ${String(result.expiresAt)}).`;
  }
  if (typeof result.invitedEmail === "string") {
    const team = typeof result.teamName === "string" ? ` to "${result.teamName}"` : "";
    const warning =
      typeof result.warning === "string"
        ? ` ${result.warning} Tell them to sign up with that address and accept from their Teams page.`
        : " They get an email; accepting claims one of the team's seats.";
    return `Approved. Invited ${result.invitedEmail}${team} (invite ${String(result.id)}).${warning}`;
  }
  if (typeof result.deleted === "string" && typeof result.teamId === "string") {
    return `Approved. The team ${result.deleted ? `"${result.deleted}" ` : ""}was deleted; its subscription has ended.`;
  }
  if (typeof result.removed === "string") {
    return `Approved. The domain ${result.removed} was removed; mail to it is refused now.`;
  }
  if ("name" in result) {
    return result.name === null
      ? "Approved. The account's display name was cleared."
      : `Approved. The account's display name is now "${String(result.name)}".`;
  }
  return `Approved and done: ${JSON.stringify(result)}`;
}

/** Waits for an approval's answer and says what it granted or did. */
async function waitForApprovalText(client: WebhooksCC, id: string, ms: number): Promise<string> {
  try {
    const result = await client.approvals.wait<Record<string, unknown>>(id, { timeout: ms });
    return approvalResultText(result);
  } catch (error) {
    if (error instanceof ApprovalDeniedError) {
      return "The person refused it on the approval page. Do not ask again unless they tell you to.";
    }
    if (error instanceof ApprovalExpiredError) {
      return "The approval expired. Ask again if the person still wants it.";
    }
    if (error instanceof TimeoutError) {
      return `Not answered yet. Remind the person of the link if needed, and call wait_for_approval with id ${id} again.`;
    }
    throw error;
  }
}

/** An approval id as it comes back from a client: untrusted, so only its shape is taken. */
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The tools that ask the account's owner to approve: the only ones a retry finishes. */
const APPROVAL_TOOLS = new Set([
  "create_api_key",
  "create_share_link",
  "remove_domain",
  "rename_account",
  "delete_team",
  "invite_to_team",
  "connect_google",
  "pick_spreadsheet",
  "ai_setup",
  "change_plan",
  "set_seats",
  "change_addons",
  "cancel_subscription",
  "resume_subscription",
]);
/** How long a retried call waits for the person, within the hosted server's cap. */
const APPROVAL_RETRY_WAIT_MS = 45_000;

/**
 * The answer for an action the account's owner must approve first: the
 * text for clients that cannot open a link, and the approval for those that
 * can (toolTarget).
 */
function approvalAsk(pending: PendingApprovalAsk): ToolResult {
  const { id, summary, url, code, expiresAt } = pending;
  return {
    ...textContent(approvalAskText(pending)),
    approval: { id, summary, url, code, expiresAt },
  };
}

function approvalAskText(pending: PendingApprovalAsk): string {
  return [
    `Asked for approval: ${pending.summary}`,
    `Show the person this link: ${pending.url}`,
    `The page shows the code ${pending.code}; ask them to approve only if it matches.`,
    `Then call wait_for_approval with id ${pending.id}. The request expires at ${pending.expiresAt}.`,
  ].join("\n");
}

export function textContent(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function serializeJson(value: unknown, limit = MAX_BODY_SIZE): string {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= limit) {
    return full;
  }

  if (Array.isArray(value)) {
    let low = 0;
    let high = value.length;
    let best = JSON.stringify(
      { items: [], truncated: true, total: value.length, returned: 0 },
      null,
      2
    );

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = JSON.stringify(
        {
          items: value.slice(0, mid),
          truncated: true,
          total: value.length,
          returned: mid,
        },
        null,
        2
      );

      if (candidate.length <= limit) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return best;
  }

  return full.slice(0, limit) + `\n... [truncated, ${full.length} chars total]`;
}

/**
 * `value` with the array `value[key]` cut to as many leading items as fit
 * the output, the way serializeJson cuts a top-level array, so an object
 * wrapping a list stays valid JSON.
 */
function fitArrayField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const items = value[key];
  if (!Array.isArray(items) || jsonSize(value) <= MAX_BODY_SIZE) return value;
  const cut = (count: number) => ({
    ...value,
    [key]: items.slice(0, count),
    truncated: true,
    returned: count,
  });
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonSize(cut(mid)) <= MAX_BODY_SIZE) low = mid;
    else high = mid - 1;
  }
  return cut(low);
}

/** Epoch milliseconds as ISO 8601, or null. */
function isoTime(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** What a search that did not read everything tells the agent. */
function searchStoppedNote(
  searchedUntil: string | null,
  order: "asc" | "desc",
  hasCursor: boolean
): string {
  const [direction, rest] = order === "asc" ? ["forward", "newer"] : ["back", "older"];
  const reached = searchedUntil
    ? `Searched ${direction} to ${searchedUntil}; ${rest} requests were not searched yet.`
    : `The search stopped before it read everything; ${rest} requests were not searched yet.`;
  return hasCursor ? `${reached} Call search_requests again with cursor to continue.` : reached;
}

// Tool output has a size limit, so no tool can promise a large request whole.
const FULL_REQUEST_HINT =
  "The full request is available from the API (GET /api/requests/{id}), the SDKs (requests.get(id)) or the CLI (whk requests get <id>).";

const SEARCH_SHORTENED_NOTE = `Some requests were shortened to fit the output (bodyTruncated with bodySize, or shortened: true for a summary); get_request with the id returns as much of one request as fits. ${FULL_REQUEST_HINT}`;

const REQUEST_SHORTENED_NOTE = `This request was cut to fit the output: its body (bodyTruncated, with bodySize), or everything but a summary (shortened: true). ${FULL_REQUEST_HINT}`;

/** A string cut to `max` characters, for a summary. */
function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? sliceText(value, max) : undefined;
}

/** The size of one request as an item of the `requests` list in the output. */
function listedSize(request: unknown): number {
  // Its lines indented two levels, plus the comma and line break after it.
  return jsonSize([[request]]) - 8;
}

/**
 * The requests of one search page, shortened so the list takes at most
 * `room` characters: every request stays listed, because the page's cursor
 * continues after all of them. Each gets an equal share; one that is larger
 * loses the end of its body, then everything but a summary, and a page that
 * cannot hold the summaries lists ids and times.
 */
function fitSearchRequests(requests: unknown[], room: number): unknown[] {
  const share = Math.floor(room / Math.max(1, requests.length));
  const fitted = requests.map((request) =>
    shortenRequest(request as JsonRecord, share, listedSize)
  );
  if (fitted.every((request) => listedSize(request) <= share)) return fitted;
  return requests.map((request) => {
    const { id, receivedAt } = request as JsonRecord;
    return { id, receivedAt, shortened: true };
  });
}

type JsonRecord = Record<string, unknown>;

/**
 * `request` in at most `share` characters as `sizeOf` measures it: as it is
 * when it fits, else with the end of its body cut, else as a summary. A
 * `note` on it is kept.
 */
function shortenRequest(
  request: JsonRecord,
  share: number,
  sizeOf: (value: unknown) => number
): JsonRecord {
  if (sizeOf(request) <= share) return request;
  if (typeof request.body === "string") {
    const body = request.body;
    // Escaping can make a body longer in JSON than it is, so cut until it fits.
    let keep = body.length - (sizeOf(request) - share) - 96;
    while (keep > 0) {
      const cut = {
        ...request,
        body: sliceText(body, keep),
        bodyTruncated: true,
        bodySize: body.length,
      };
      if (sizeOf(cut) <= share) return cut;
      keep = Math.floor(keep / 2);
    }
  }
  const email = request.email as JsonRecord | null | undefined;
  const summary: JsonRecord = {
    id: request.id,
    slug: clip(request.slug, 64),
    // What the inspector reads to find the endpoint's recent requests.
    endpointSlug: clip(request.endpointSlug, 64),
    endpointId: clip(request.endpointId, 64),
    method: clip(request.method, 16),
    path: clip(request.path, 200),
    contentType: clip(request.contentType, 100),
    size: request.size,
    receivedAt: request.receivedAt,
    kind: request.kind,
    ...(email ? { subject: clip(email.subject, 200) } : {}),
    shortened: true,
    ...(typeof request.note === "string" ? { note: request.note } : {}),
  };
  return summary;
}

/**
 * One request as a tool's whole output: always valid JSON, so a request
 * larger than the output is cut the way a search page's requests are and
 * says where the whole of it can be had.
 */
function requestContent(request: Parameters<typeof compactRequest>[0]): ToolResult {
  const compact = compactRequest(request) as unknown as JsonRecord;
  if (jsonSize(compact) <= MAX_BODY_SIZE) return jsonContent(compact);
  return jsonContent(
    shortenRequest({ ...compact, note: REQUEST_SHORTENED_NOTE }, MAX_BODY_SIZE, jsonSize)
  );
}

export function jsonContent(value: unknown): ToolResult {
  return textContent(serializeJson(value));
}

/** Read response body with size limit to avoid unbounded memory usage. */
async function readBodyTruncated(response: Response, limit = MAX_BODY_SIZE): Promise<string> {
  const text = await response.text();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated, ${text.length} chars total]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitHint(message: string): { message: string; hint: string | null } {
  const separatorIndex = message.indexOf(TIME_SEPARATOR);
  if (separatorIndex === -1) {
    return { message, hint: null };
  }

  return {
    message: message.slice(0, separatorIndex),
    hint: message.slice(separatorIndex + TIME_SEPARATOR.length) || null,
  };
}

function serializeError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const { message, hint } = splitHint(rawMessage);

  const payload: {
    error: true;
    code:
      | "unauthorized"
      | "not_found"
      | "rate_limited"
      | "timeout"
      | "validation_error"
      | "server_error";
    message: string;
    hint: string | null;
    retryAfter: number | null;
  } = {
    error: true,
    code: "validation_error",
    message,
    hint,
    retryAfter: null,
  };

  if (error instanceof UnauthorizedError) {
    payload.code = "unauthorized";
  } else if (error instanceof NotFoundError) {
    payload.code = "not_found";
  } else if (error instanceof RateLimitError) {
    payload.code = "rate_limited";
    payload.retryAfter = error.retryAfter ?? null;
  } else if (error instanceof TimeoutError) {
    payload.code = "timeout";
  } else if (error instanceof WebhooksCCError) {
    payload.code = error.statusCode >= 500 ? "server_error" : "validation_error";
  }

  if (error instanceof WebhooksCCError && payload.hint === null) {
    if (error.code === "invalid_cursor") {
      payload.hint =
        "The cursor is not one this search returned, or the order changed since. Pass a cursor exactly as a result gave it, or search again without one.";
    } else if (error.code === "search_busy") {
      payload.hint =
        "The account's other searches are still running. Wait retryAfter seconds, then call again with the same inputs.";
    }
  }

  return JSON.stringify(payload, null, 2);
}

/** Wrap a tool handler with error handling that returns structured MCP errors. */
export function withErrorHandling<T>(
  handler: (args: T) => Promise<ToolResult>
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      return { ...textContent(serializeError(error)), isError: true };
    }
  };
}

function filterRequestsByMethod(requests: Request[], method?: string): Request[] {
  if (!method) {
    return requests;
  }

  const target = method.toUpperCase();
  return requests.filter((request) => request.method.toUpperCase() === target);
}

async function waitForMultipleRequests(
  client: WebhooksCC,
  endpointSlug: string,
  options: {
    count: number;
    timeout?: number | string;
    pollInterval?: number | string;
    method?: string;
  }
): Promise<{ requests: Request[]; complete: boolean; timedOut: boolean; expectedCount: number }> {
  const timeoutMs =
    typeof options.timeout === "number"
      ? options.timeout
      : options.timeout
        ? Number.isNaN(Number(options.timeout))
          ? parseDurationLike(options.timeout)
          : Number(options.timeout)
        : 30_000;
  const pollIntervalMs =
    typeof options.pollInterval === "number"
      ? options.pollInterval
      : options.pollInterval
        ? Number.isNaN(Number(options.pollInterval))
          ? parseDurationLike(options.pollInterval)
          : Number(options.pollInterval)
        : 500;

  const startedAt = Date.now();
  let since = startedAt;
  const seenIds = new Set<string>();
  const requests: Request[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const checkTime = Date.now();
    const page = await client.requests.list(endpointSlug, {
      since,
      limit: Math.max(100, options.count * 5),
    });
    since = checkTime;

    const filtered = filterRequestsByMethod(page, options.method)
      .slice()
      .sort((left, right) => left.receivedAt - right.receivedAt);

    for (const request of filtered) {
      if (seenIds.has(request.id)) {
        continue;
      }

      seenIds.add(request.id);
      requests.push(request);

      if (requests.length >= options.count) {
        return {
          requests,
          complete: true,
          timedOut: false,
          expectedCount: options.count,
        };
      }
    }

    // Never sleep past the deadline.
    await sleep(
      Math.min(Math.max(10, pollIntervalMs), Math.max(0, timeoutMs - (Date.now() - startedAt)))
    );
  }

  return {
    requests,
    complete: requests.length >= options.count,
    timedOut: true,
    expectedCount: options.count,
  };
}

function parseDurationLike(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Duration value cannot be empty");
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  const match = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration: "${value}"`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return amount * multiplier;
}

function ensureVerifyArgs(args: {
  provider: VerifyProvider;
  secret?: string;
  publicKey?: string;
  url?: string;
  method?: string;
}):
  | { provider: "discord"; publicKey: string }
  | {
      provider: Exclude<VerifyProvider, "discord">;
      secret: string;
      url?: string;
      method?: string;
    } {
  if (args.provider === "discord") {
    const publicKey = args.publicKey?.trim();
    if (!publicKey) {
      throw new Error('verify_signature for provider "discord" requires publicKey');
    }

    return {
      provider: "discord",
      publicKey,
    };
  }

  const secret = args.secret?.trim();
  if (!secret) {
    throw new Error(`verify_signature for provider "${args.provider}" requires secret`);
  }

  return {
    provider: args.provider,
    secret,
    ...(args.url ? { url: args.url } : {}),
    ...(args.method ? { method: args.method } : {}),
  };
}

async function summarizeResponse(response: Response): Promise<{
  status: number;
  statusText: string;
  body: string;
}> {
  return {
    status: response.status,
    statusText: response.statusText,
    body: await readBodyTruncated(response),
  };
}

interface EmailEndpointView {
  endpoint: { slug: string; name: string | null };
  /** Whether codes and links may be shown for the endpoint's emails (its owner can turn that off). */
  includeExtracts: boolean;
}

async function emailEndpointView(client: WebhooksCC, slug: string): Promise<EmailEndpointView> {
  return endpointViewOf(await client.endpoints.get(slug));
}

function endpointViewOf(
  endpoint: Pick<Endpoint, "slug" | "name" | "showEmailExtracts">
): EmailEndpointView {
  return {
    endpoint: { slug: endpoint.slug, name: endpoint.name ?? null },
    includeExtracts: endpoint.showEmailExtracts !== false,
  };
}

/**
 * The endpoint an email is at, with what `get_email` needs to know of it.
 * An email read by id names its endpoint's slug, and so does a capture
 * address ({slug}[+tag]@mailhooks.cc). Mail to a custom inbound domain is
 * stored under the recipient's own address, so without the slug (an older
 * server) its endpoint is found by id among the account's endpoints, whose
 * list already says all that is needed.
 */
async function emailEndpointViewFor(
  client: WebhooksCC,
  email: EmailRequest
): Promise<EmailEndpointView> {
  if (email.endpointSlug) return emailEndpointView(client, email.endpointSlug);
  const at = email.path.lastIndexOf("@");
  if (at > 0 && email.path.slice(at + 1).toLowerCase() === DEFAULT_EMAIL_DOMAIN) {
    return emailEndpointView(client, email.path.slice(0, at).split("+")[0].toLowerCase());
  }
  const endpoint = (await client.endpoints.list()).find(
    (candidate) => candidate.id === email.endpointId
  );
  if (!endpoint) {
    throw new NotFoundError(`The endpoint of email ${email.id} was not found`);
  }
  return endpointViewOf(endpoint);
}

/** A main link in `list_emails` longer than this is left out, so one email cannot fill the list. */
const MAX_SUMMARY_LINK = 8_000;

/** `link`, or null and a note with its length when it is longer than `max`. */
function boundedLink(link: string | null | undefined, max: number) {
  if (link == null || link.length <= max) return { link: link ?? null };
  return {
    link: null,
    linkOmitted: `The main link is ${link.length} characters long, too long for the output`,
  };
}

/** Longest subject and sender kept in a `list_emails` line, so one email cannot fill the list. */
const MAX_SUMMARY_FIELD = 1_000;

/** One line per email for list output. */
function summarizeEmail(email: EmailRequest, includeExtracts: boolean) {
  const from = email.email.from[0];
  const sender = from ? (from.name ? `${from.name} <${from.address ?? ""}>` : from.address) : null;
  const subject = email.email.subject;
  return {
    id: email.id,
    receivedAt: new Date(email.receivedAt).toISOString(),
    address: email.path,
    tag: email.email.tag,
    subject: subject === null ? null : sliceText(subject, MAX_SUMMARY_FIELD),
    from: sender == null ? null : sliceText(sender, MAX_SUMMARY_FIELD),
    ...(includeExtracts
      ? { code: extractCode(email), ...boundedLink(extractLink(email), MAX_SUMMARY_LINK) }
      : {}),
    attachments: email.email.attachments.length,
  };
}

/** Fields of an email detail kept when it has to shrink to its essentials. */
const ESSENTIAL_DETAIL_FIELDS = [
  "code",
  "link",
  "id",
  "endpoint",
  "receivedAt",
  "address",
  "tag",
  "subject",
  "from",
  "fields",
  "parsed",
  "replyText",
  "size",
  "test",
  "spam",
  "text",
  "textTruncated",
  "htmlSize",
  "html",
  "htmlTruncated",
];

/**
 * An email as `get_email` and `wait_for_email` return it: the forwarding
 * JSON's data, trimmed to the output budget so it stays valid JSON. The code
 * and link come first and the text is cut at MAX_EMAIL_TEXT. If that is
 * still too big, the headers go first, then extra codes and links, then the
 * extra entries of the address and attachment lists; then the HTML (when
 * asked for) is cut and the text is cut down to TEXT_FLOOR characters; then
 * only the essentials stay, a main link too long to use is left out, and the
 * text gets what room is left; and at last the subject is cut, so it always
 * fits.
 */
/** A rendered email for the output budget: its body cut to fit, and said so. */
function shrinkRendered(rendered: Record<string, unknown>, max: number): Record<string, unknown> {
  const body = typeof rendered.body === "string" ? rendered.body : "";
  if (body.length <= max - 1024) return rendered;
  return { ...rendered, body: body.slice(0, max - 1024), bodyTruncated: true };
}

function emailDetail(
  client: WebhooksCC,
  email: EmailRequest,
  view: EmailEndpointView,
  includeHtml: boolean
) {
  const { data } = client.emails.toJson(email, {
    endpoint: view.endpoint,
    includeExtracts: view.includeExtracts,
  });
  const { html, text: fullText, ...rest } = data;
  const { text, cut } = cutEmailText(fullText ?? null);
  const restoreText = () => {
    detail.text = text;
    if (cut) detail.textTruncated = true;
    else delete detail.textTruncated;
  };
  const detail: Record<string, unknown> = {
    ...(view.includeExtracts ? { code: extractCode(email), link: extractLink(email) } : {}),
    ...rest,
    text,
    ...(cut ? { textTruncated: true } : {}),
    htmlSize: html?.length ?? 0,
    ...(includeHtml && html !== null ? { html } : {}),
  };
  shrinkToFit(detail, MAX_BODY_SIZE, [
    () => trimParsed(detail),
    () => omitHeaders(detail),
    () => trimSpam(detail),
    () => capExtracts(detail),
    () => capLists(detail),
    () => cutStringToFit(detail, detail, "html", "htmlTruncated", MAX_BODY_SIZE),
    () => cutStringToFit(detail, detail, "text", "textTruncated", MAX_BODY_SIZE, TEXT_FLOOR),
    // Down to the essentials (and without a main link too long to use) there
    // may be room for more of the text again.
    () => {
      keepOnly(detail, ESSENTIAL_DETAIL_FIELDS);
      if (view.includeExtracts) {
        Object.assign(detail, boundedLink(detail.link as string | null, MAX_BODY_SIZE / 2));
      }
      restoreText();
      cutStringToFit(detail, detail, "text", "textTruncated", MAX_BODY_SIZE);
    },
    () => cutStringToFit(detail, detail, "subject", "subjectTruncated", MAX_BODY_SIZE),
  ]);
  return detail;
}

/** Register all webhook tools on an MCP server instance. */
/**
 * What registerTools needs from a server: the stdio server's McpServer has
 * it, and the hosted server at webhooks.cc/mcp adapts its own to it, so both
 * serve the same tools.
 */
export interface ToolServer {
  tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>, call?: ToolCall) => Promise<ToolResult>,
    /** MCP tool annotations (catalog.ts), set by registerTools for every tool. */
    annotations?: ToolAnnotationsHint,
    /** The tool's _meta (the request inspector, app.ts), for the adapter to pass on. */
    meta?: Record<string, unknown>
  ): RegisteredToolHandle;
}

/** MCP tool annotations as registerTools passes them on. */
export type ToolAnnotationsHint = ReturnType<typeof toolAnnotations>;

/** A registered tool, removable when the tool set is swapped. */
export interface RegisteredToolHandle {
  remove(): void;
}

export interface RegisterToolsOptions {
  /**
   * The hosted server (webhooks.cc/mcp): leave out the tools that send to a
   * URL the caller names, which would run from webhooks.cc's network and
   * could never reach the caller's machine anyway, refuse targetUrl on the
   * others, and cap waits below the proxy's timeout.
   */
  remote?: boolean;
  /**
   * The tool groups to register (catalog.ts). Default: every group, as before
   * groups existed; the servers choose (WHK_MCP_TOOLS, ?tools=, the client).
   */
  groups?: ReadonlySet<ToolGroup>;
  /** Register only the tools that change nothing (readOnlyHint). */
  readOnly?: boolean;
}

/**
 * Tools that only make sense next to the caller: they post to a URL of the
 * caller's choosing, or (share_port) run the whk CLI on the caller's machine.
 */
export const LOCAL_ONLY_TOOLS = new Set(["send_to", "replay_request", "share_port"]);
/** Tools whose optional targetUrl posts somewhere of the caller's choosing. */
const TARGET_URL_TOOLS = new Set(["render_email", "test_webhook_flow"]);
/** Longest wait on the hosted server; Cloudflare ends a request after 100 seconds. */
export const REMOTE_MAX_WAIT_MS = 50_000;
/** Shortest poll interval on the hosted server: each poll is an API request. */
export const REMOTE_MIN_POLL_MS = 1_000;

/** A duration argument in milliseconds, read as the SDK reads it; null when it is not one. */
function durationMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  try {
    const ms = parseDuration(value);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * The server registerTools writes to: records every tool for removal and,
 * for the hosted server, applies the remote restrictions.
 */
function toolTarget(
  target: ToolServer,
  client: WebhooksCC,
  options: RegisterToolsOptions,
  handles: RegisteredToolHandle[]
): ToolServer {
  const remote = options.remote === true;
  return {
    tool(name, description, shape, inner) {
      // An approval the client opened for the person comes back as a retry
      // carrying its id: finish it rather than ask again. Otherwise a new
      // approval is asked of a client that can open links as a URL request.
      const handler: typeof inner = async (args, call) => {
        if (call?.requestState !== undefined && APPROVAL_TOOLS.has(name)) {
          const id = call.requestState;
          if (!APPROVAL_ID.test(id)) {
            return {
              ...textContent("That approval is not one this server asked for."),
              isError: true,
            };
          }
          if (call.urlAnswer === "decline" || call.urlAnswer === "cancel") {
            return textContent(
              `The person closed the approval link. It works until it expires: if they still want this, show them the link again and call wait_for_approval with id ${id}.`
            );
          }
          return withErrorHandling(async () =>
            textContent(await waitForApprovalText(client, id, APPROVAL_RETRY_WAIT_MS))
          )(undefined);
        }
        const result = await inner(args, call);
        if (!result.approval) return result;
        if (call?.urlElicitation) return result;
        const plain = { ...result };
        delete plain.approval;
        return plain;
      };
      if (remote && LOCAL_ONLY_TOOLS.has(name)) return { remove() {} };
      const entry = TOOL_CATALOG[name];
      if (!entry) throw new Error(`${name} has no entry in catalog.ts`);
      if (options.groups && !options.groups.has(entry.group)) return { remove() {} };
      if (options.readOnly && entry.readOnly !== true) return { remove() {} };
      const wrapped: typeof handler = remote
        ? async (args, call) => {
            const input = args as Record<string, unknown>;
            if (TARGET_URL_TOOLS.has(name) && input.targetUrl !== undefined) {
              return {
                ...textContent(
                  "targetUrl needs the local MCP server (npx -y @webhooks-cc/mcp): the hosted server cannot reach your machine. Leave it out here."
                ),
                isError: true,
              };
            }
            // Waits poll the API: bound how long and how often, and poll no
            // faster than once a second even when the caller leaves it out.
            const bounded = { ...input };
            if ("pollInterval" in shape && input.pollInterval === undefined) {
              bounded.pollInterval = REMOTE_MIN_POLL_MS;
            }
            for (const [key, bound] of [
              ["timeout", (ms: number) => Math.min(ms, REMOTE_MAX_WAIT_MS)],
              [
                "pollInterval",
                (ms: number) => Math.min(Math.max(ms, REMOTE_MIN_POLL_MS), REMOTE_MAX_WAIT_MS),
              ],
            ] as const) {
              if (bounded[key] === undefined) continue;
              const ms = durationMs(bounded[key]);
              if (ms === null) {
                return {
                  ...textContent(`${key} must be a duration such as "30s" or milliseconds.`),
                  isError: true,
                };
              }
              bounded[key] = bound(ms);
            }
            return handler(bounded as unknown as typeof args, call);
          }
        : handler;
      const handle = target.tool(
        name,
        description,
        shape,
        wrapped,
        toolAnnotations(name),
        appToolMeta(name)
      );
      handles.push(handle);
      return handle;
    },
  };
}

/** What share_port tells the agent about a running share. */
function shareSummary(live: LiveShare): Record<string, unknown> {
  const notes: string[] = [];
  if (live.notice) {
    notes.push(
      "The first time each browser opens the link, it sees a short notice from webhooks.cc and clicks Open the preview (Free, and paid accounts in their first 7 days)."
    );
  }
  if (live.password) notes.push("Visitors need the password.");
  if (live.expiresAt) {
    notes.push(
      `The plan stops this share at ${live.expiresAt}; reconnecting does not extend it, and starting it again gives a new link.`
    );
  }
  notes.push("It runs until stop_share or the end of this MCP server.");
  return {
    url: live.url,
    name: live.name,
    port: live.port,
    expiresAt: live.expiresAt,
    notice: live.notice,
    password: live.password,
    notes: notes.join(" "),
  };
}

/**
 * How the hosted server (no share_port: it cannot run whk on the person's
 * computer) says to start a preview.
 */
const REMOTE_SHARE =
  "`whk share <port>` on the person's computer (or the local MCP server, npx -y @webhooks-cc/mcp, which has share_port)";

/**
 * What an agent can do about the account's sharing limits, from a share
 * list: the next step when slots or data run out, so it never has to send
 * the person to the dashboard. `remote` for the hosted server, which has no
 * share_port.
 */
export function shareHints(list: TunnelShareList, remote = false): string[] {
  const start = remote ? REMOTE_SHARE : "share_port";
  const hints: string[] = [];
  const limits = list.limits;
  const usage = list.usage;
  // Only your own previews take your slots: a teammate's under a team name
  // counts against theirs.
  const previews = list.shares.filter((s) => s.kind !== "live" && !s.endedAt && s.mine !== false);
  if (usage?.over) {
    hints.push(
      `This month's shared data is used up, so previews are paused until ${usage.resetsAt}. A larger plan (Pro 25 GB, Business 150 GB) raises it; the person upgrades on webhooks.cc.`
    );
  }
  if (limits && previews.length >= limits.shares) {
    hints.push(
      `All ${limits.shares} of the plan's preview slots are in use: stop one with stop_share (its id is in shares) before ${start}.`
    );
  }
  if (limits && limits.sessionMinutes) {
    hints.push(
      `Previews on this plan stop after ${limits.sessionMinutes} minutes; ${start} again gives a new link.`
    );
  }
  if (limits && !limits.passwords) {
    hints.push("Passwords and reserved names come with Pro and Business.");
  }
  return hints;
}

/**
 * A server hint in this server's words: the whk commands it names become
 * the tools that do the same, so an agent does not reach for a CLI. On the
 * hosted server (`remote`) `whk share` stays a command for the person's
 * computer, since that server has no share_port.
 */
export function toolWords(hint: string, remote = false): string {
  const words = hint
    .replace(/whk shares stop(?: <[^>]*>)?/g, "stop_share")
    .replace(/whk shares (?:ls|list)/g, "list_shares")
    .replace(/whk shares log(?: <[^>]*>)?/g, "share_requests")
    .replace(/whk names reserve(?: <[^>]*>)?(?: --team <[^>]*>)?/g, "reserve_name")
    .replace(/whk names release(?: <[^>]*>)?/g, "release_name")
    .replace(/whk names password(?: <[^>]*>)? --clear/g, "clear_name_password")
    .replace(/whk names password(?: <[^>]*>)?/g, "set_name_password")
    .replace(/whk names ls/g, "list_names");
  if (remote) return words;
  return words
    .replace(/whk share <port> --password/g, "share_port with a password")
    .replace(/whk share <port>/g, "share_port");
}

/**
 * A share list with hints for an agent, for list_shares and share_port: the
 * server's own (in tool words) and this server's, without repeats, so
 * nothing the server says (a suspension, a pause) is lost.
 */
export function withShareHints(list: TunnelShareList, remote = false): Record<string, unknown> {
  const server = (list.hints ?? []).map((h) => toolWords(h, remote));
  const ours = shareHints(list, remote);
  if (list.suspended && !server.some((h) => /suspended/i.test(h))) {
    ours.unshift(
      `Sharing is suspended on this account: ${remote ? "new previews are" : "share_port is"} refused. The person can write to support@webhooks.cc.`
    );
  }
  const hints = [...new Set([...server, ...ours])];
  return hints.length > 0 ? { ...list, hints } : { ...list };
}

/**
 * Registers the webhooks.cc tools for an account client. Returns their
 * handles, so a caller can swap the tool set later.
 */
export function registerTools(
  target: ToolServer,
  client: WebhooksCC,
  options: RegisterToolsOptions = {}
): RegisteredToolHandle[] {
  const handles: RegisteredToolHandle[] = [];
  const remote = options.remote === true;
  const server = toolTarget(target, client, options, handles);
  // How the tool descriptions say to start a preview: the hosted server has
  // no share_port (it cannot run whk on the person's computer).
  const shareWith = remote ? REMOTE_SHARE : "share_port";

  server.tool(
    "create_endpoint",
    "Create a webhook endpoint. Returns the endpoint slug, URL, and metadata.",
    createEndpointShape,
    withErrorHandling(
      async ({
        name,
        ephemeral,
        expiresIn,
        mockResponse,
        responseRules,
        notificationUrl,
        site,
        signingProvider,
        signingSecret,
        signingHeader,
      }) => {
        // Validate signing fields before creating endpoint
        if (signingProvider) {
          if (signingProvider !== "discord" && !signingSecret) {
            throw new Error(`signingSecret is required for provider "${signingProvider}"`);
          }
          if (signingProvider === "generic-hmac" && !signingHeader) {
            throw new Error("signingHeader is required for generic-hmac provider");
          }
        }
        if (signingSecret && !signingProvider) {
          throw new Error("signingProvider is required when signingSecret is set");
        }

        const endpoint = await client.endpoints.create({
          name,
          ephemeral,
          expiresIn,
          mockResponse,
          responseRules,
          notificationUrl,
          site,
        });
        // Configure signing after creation (create doesn't support signing fields yet)
        if (signingProvider && signingSecret) {
          try {
            await client.endpoints.update(endpoint.slug, {
              signingProvider,
              signingSecret,
              signingHeader,
            });
          } catch (err) {
            return jsonContent({
              ...endpoint,
              warning: `Endpoint created but signing configuration failed: ${err instanceof Error ? err.message : String(err)}. Update endpoint "${endpoint.slug}" to add signing.`,
            });
          }
        }
        return jsonContent(endpoint);
      }
    )
  );

  server.tool(
    "list_endpoints",
    "List webhook endpoints: those you own (with sharedWith) and those shared with you through teams (with fromTeam). Optionally keep only one team's endpoints.",
    listEndpointsShape,
    withErrorHandling(async ({ team }) => {
      const endpoints = await client.endpoints.list({ team });
      return jsonContent(endpoints);
    })
  );

  server.tool(
    "list_teams",
    "List the teams you own or belong to, with role, seats, pooled request usage (requestsUsed/requestLimit), period end, and whether the team is suspended for lack of a subscription.",
    {},
    withErrorHandling(async () => {
      const teams = await client.teams.list();
      return jsonContent(
        teams.map((team) => ({
          ...team,
          periodEnd: team.periodEnd ? new Date(team.periodEnd).toISOString() : null,
        }))
      );
    })
  );

  server.tool(
    "list_team_members",
    "List a team's members and pending invites. Any member of the team may call this.",
    { teamId: z.string().min(1).describe("Team id (from list_teams)") },
    withErrorHandling(async ({ teamId }) => {
      const result = await client.teams.members(teamId);
      return jsonContent(result);
    })
  );

  server.tool(
    "share_endpoint",
    "Share an endpoint you own with a team so its members can inspect, stream, and edit it. The team needs an active subscription; the endpoint's requests then bill the team's pooled quota.",
    {
      slug: z.string().describe("Slug of an endpoint you own"),
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
    },
    withErrorHandling(async ({ slug, teamId }) => {
      await client.teams.share(teamId, slug);
      return jsonContent({ shared: true, slug, teamId });
    })
  );

  server.tool(
    "unshare_endpoint",
    "Stop sharing an endpoint you own with a team. Works even when the team is suspended.",
    {
      slug: z.string().describe("Slug of an endpoint you own"),
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
    },
    withErrorHandling(async ({ slug, teamId }) => {
      await client.teams.unshare(teamId, slug);
      return jsonContent({ shared: false, slug, teamId });
    })
  );

  server.tool(
    "create_team",
    "Create a team you own, to share endpoints with its members under a pooled quota. It does nothing until it has a subscription, which the person starts in the browser (Account > Teams); until then it is suspended.",
    { name: z.string().trim().min(1).max(100).describe("The team's name") },
    withErrorHandling(async ({ name }) => jsonContent(await client.teams.create(name)))
  );

  server.tool(
    "rename_team",
    "Rename a team you own.",
    {
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
      name: z.string().trim().min(1).max(100).describe("The new name"),
    },
    withErrorHandling(async ({ teamId, name }) => {
      await client.teams.rename(teamId, name);
      return jsonContent({ renamed: true, teamId, name });
    })
  );

  server.tool(
    "delete_team",
    "Delete a team you own: its subscription ends at once, every member loses the endpoints shared with it, and it cannot be undone. Only when the person asks for it. The team's owner must approve it: this returns a link and a code to show them, then call wait_for_approval.",
    { teamId: z.string().min(1).describe("Team id (from list_teams)") },
    withErrorHandling(async ({ teamId }) => {
      const pending = await client.teams.delete(teamId);
      if (!pending.id) return textContent(`Deleted the team ${teamId}.`);
      return approvalAsk(pending);
    })
  );

  server.tool(
    "remove_team_member",
    "Remove a member from a team you own: the endpoints they shared with the team stop being shared, and their seat is free for someone else. Only when the person asks for it.",
    {
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
      userId: z.string().min(1).describe("The member's userId (from list_team_members)"),
    },
    withErrorHandling(async ({ teamId, userId }) => {
      await client.teams.removeMember(teamId, userId);
      return jsonContent({ removed: true, teamId, userId });
    })
  );

  server.tool(
    "leave_team",
    "Leave a team you belong to: the endpoints you shared with it stop being shared, and you lose access to the ones shared with you through it. An owner cannot leave; they delete the team instead (delete_team). Only when the person asks for it.",
    { teamId: z.string().min(1).describe("Team id (from list_teams)") },
    withErrorHandling(async ({ teamId }) => {
      await client.teams.leave(teamId);
      return jsonContent({ left: true, teamId });
    })
  );

  server.tool(
    "invite_to_team",
    "Invite an email address to a team you own. It emails that address, so the team's owner must approve it: this returns a link and a code to show them, then call wait_for_approval, which returns the invite. Accepting the invite claims one of the team's paid seats. Only when the person asks for it.",
    {
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
      email: z.string().trim().email().describe("The address to invite"),
    },
    withErrorHandling(async ({ teamId, email }) => {
      const pending = await client.teams.invite(teamId, email);
      if (!pending.id) return textContent(approvalResultText({ ...(await pending.wait()) }));
      return approvalAsk(pending);
    })
  );

  server.tool(
    "list_invites",
    "List the team invites waiting for you to answer: team, who invited you, when, and the invite id for answer_invite.",
    {},
    withErrorHandling(async () => jsonContent(await client.teams.invites.list()))
  );

  server.tool(
    "answer_invite",
    "Accept or decline a team invite waiting for you (from list_invites). Accepting claims one of the team's paid seats and you join the team, seeing the endpoints shared with it; it fails when the team is full or suspended. Only when the person says which.",
    {
      inviteId: z.string().min(1).describe("The invite's id, from list_invites"),
      answer: z
        .enum(["accept", "decline"])
        .describe("accept joins the team; decline turns it down"),
    },
    withErrorHandling(async ({ inviteId, answer }) => {
      if (answer === "accept") {
        await client.teams.invites.accept(inviteId);
        return jsonContent({ accepted: true, inviteId });
      }
      await client.teams.invites.decline(inviteId);
      return jsonContent({ declined: true, inviteId });
    })
  );

  server.tool(
    "withdraw_invite",
    "Withdraw an invite to a team you own before it is answered (pending invites and their ids are in list_team_members). The invite link stops working.",
    {
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
      inviteId: z
        .string()
        .min(1)
        .describe("The invite's id (from list_team_members' pendingInvites)"),
    },
    withErrorHandling(async ({ teamId, inviteId }) => {
      await client.teams.withdrawInvite(teamId, inviteId);
      return jsonContent({ withdrawn: true, teamId, inviteId });
    })
  );

  server.tool(
    "quote_team_change",
    "What changing a team's seat count or plan would cost, read only (owner only): what is due now, any credit, and the price from the renewal. Give seats, or plan (with interval). To make it, set_seats or change_plan asks the owner to approve it.",
    {
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
      seats: z.number().int().min(1).optional().describe("Price this seat count"),
      plan: z
        .enum(["team", "team_business"])
        .optional()
        .describe("Price a move to this plan: team (Teams) or team_business (Team Business)"),
      interval: z
        .enum(["month", "year"])
        .optional()
        .describe("Billing interval for plan (default month; Teams is monthly only)"),
    },
    withErrorHandling(async ({ teamId, seats, plan, interval }) => {
      if ((seats === undefined) === (plan === undefined)) {
        throw new Error("Give seats or plan, not both.");
      }
      if (seats !== undefined) {
        if (interval !== undefined) throw new Error("interval goes with plan, not seats.");
        return jsonContent(await client.billing.quoteTeamSeats(teamId, seats));
      }
      return jsonContent(
        await client.billing.quoteTeamPlan(teamId, plan as "team" | "team_business", interval)
      );
    })
  );

  server.tool(
    "get_endpoint",
    "Get details for a specific webhook endpoint by slug.",
    getEndpointShape,
    withErrorHandling(async ({ slug }) => {
      const endpoint = await client.endpoints.get(slug);
      return jsonContent(endpoint);
    })
  );

  server.tool(
    "favorite_endpoint",
    "Mark an endpoint as one of your favourites, or unmark it with favorite: false. A favourite is your own choice, so endpoints shared with you through teams can be marked too; list_endpoints and get_endpoint show it as favorite. Idempotent.",
    {
      slug: z.string().describe("The endpoint slug"),
      favorite: z
        .boolean()
        .optional()
        .describe("true marks it as a favourite (the default), false unmarks it"),
    },
    withErrorHandling(async ({ slug, favorite }) => {
      const result =
        favorite === false
          ? await client.endpoints.unfavorite(slug)
          : await client.endpoints.favorite(slug);
      return jsonContent({ slug, favorite: result.favorite });
    })
  );

  server.tool(
    "update_endpoint",
    "Update an endpoint name, mock response, conditional response rules, signing configuration, whether codes and links are picked out of its emails, or the named fields picked out of them.",
    {
      slug: z.string().describe("The endpoint slug to update"),
      name: z.string().optional().describe("New display name"),
      mockResponse: mockResponseSchema
        .nullable()
        .optional()
        .describe("Default mock response (used when no rule matches), or null to clear"),
      responseRules: responseRulesSchema
        .nullable()
        .optional()
        .describe("Conditional response rules (first match wins), or null to clear"),
      notificationUrl: z
        .string()
        .url()
        .nullable()
        .optional()
        .describe("Notification webhook URL, or null to clear it"),
      signingProvider: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Signing provider for automatic verification (e.g. stripe, github), or null to disable"
        ),
      signingSecret: z
        .string()
        .nullable()
        .optional()
        .describe("New signing secret (encrypted server-side). Pass null to clear."),
      signingHeader: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Custom signature header name (only for generic-hmac provider), or null to clear"
        ),
      showEmailExtracts: z
        .boolean()
        .optional()
        .describe("Pick codes and links out of emails (dashboard and forwarded JSON). Owner only."),
      site: endpointSiteSchema.optional(),
      emailFields: z
        .array(emailFieldSchema)
        .max(20)
        .nullable()
        .optional()
        .describe(
          "Named fields picked out of every email: shown with it, `fields` in its JSON, read by forwarding templates and filters (email_field). Replaces the list; null or [] removes them. Owner only."
        ),
      layouts: z
        .array(layoutSchema)
        .max(50)
        .nullable()
        .optional()
        .describe(
          "How the endpoint reads each sender's emails: the first layout whose match holds applies its fields, line items and attachment parsing; the result is `parsed` in the email's JSON, and deliveries wait for it. The plan uses the first 2 (Business 50). Replaces the list; null or [] removes them. Try them with preview_layouts first. Owner only."
        ),
    },
    withErrorHandling(
      async ({
        slug,
        name,
        mockResponse,
        responseRules,
        notificationUrl,
        signingProvider,
        signingSecret,
        signingHeader,
        showEmailExtracts,
        site,
        emailFields,
        layouts,
      }) => {
        const endpoint = await client.endpoints.update(slug, {
          name,
          mockResponse,
          responseRules,
          notificationUrl,
          signingProvider,
          signingSecret,
          signingHeader,
          showEmailExtracts,
          site,
          emailFields,
          layouts,
        });
        return jsonContent(endpoint);
      }
    )
  );

  server.tool(
    "preview_layouts",
    "Dry run of an endpoint's layouts on a captured email: which layout matches, the fields and line items it finds, and what earlier parses of its attachments held. Nothing is saved and no pages are used. Pass layouts to try them before saving them with update_endpoint.",
    {
      slug: z.string().describe("The endpoint slug"),
      requestId: z
        .string()
        .optional()
        .describe("A captured email on the endpoint (default: the newest)"),
      layouts: z.array(layoutSchema).max(50).optional().describe("Unsaved layouts to try"),
    },
    withErrorHandling(async ({ slug, requestId, layouts }) => {
      const preview = await client.endpoints.previewLayouts(slug, { requestId, layouts });
      const holder = { ...preview } as Record<string, unknown>;
      shrinkToFit(holder, MAX_BODY_SIZE, [() => trimParsed(holder)]);
      return jsonContent(holder);
    })
  );

  server.tool(
    "list_layout_templates",
    "List the ready-made email layouts (order emails from Shopify, WooCommerce, Etsy and more, payments, bookings, attachments): each with its id, sender, kind, description, the fields it reads and whether it reads line items. Add one with add_layout_template.",
    { slug: z.string().describe("The endpoint slug") },
    withErrorHandling(async ({ slug }) => jsonContent(await client.endpoints.layoutTemplates(slug)))
  );

  server.tool(
    "add_layout_template",
    "Add a ready-made layout (an id from list_layout_templates) to the end of an endpoint's layouts. Emails it matches are parsed from the next one on; check it on a captured email with preview_layouts. Owner only.",
    {
      slug: z.string().describe("The endpoint slug"),
      template: z.string().min(1).describe("The template's id, from list_layout_templates"),
    },
    withErrorHandling(async ({ slug, template }) =>
      jsonContent(await client.endpoints.addLayoutTemplate(slug, template))
    )
  );

  server.tool(
    "preview_email_fields",
    "Dry run of an endpoint's named email fields on a captured email: each field's value (null where it finds nothing), and problems with fields you pass. Nothing is saved. Pass emailFields to try fields before saving them with update_endpoint. Owner only.",
    {
      slug: z.string().describe("The endpoint slug"),
      requestId: z
        .string()
        .optional()
        .describe("A captured email on the endpoint (default: the newest)"),
      emailFields: z
        .array(emailFieldSchema)
        .max(20)
        .optional()
        .describe("Unsaved fields to try instead of the saved ones"),
    },
    withErrorHandling(async ({ slug, requestId, emailFields }) =>
      jsonContent(await client.endpoints.previewEmailFields(slug, { requestId, emailFields }))
    )
  );

  server.tool(
    "preview_response",
    "Dry run of an endpoint's responses: which response rule answers a captured request, and the response with its {{ placeholders }} filled in, exactly as the receiver would send it. Nothing is sent. Pass mockResponse or responseRules to try settings before saving them with update_endpoint.",
    {
      slug: z.string().describe("The endpoint slug"),
      requestId: z
        .string()
        .optional()
        .describe(
          "A captured request on the endpoint (default: the newest HTTP request, or a sample)"
        ),
      mockResponse: mockResponseSchema
        .nullable()
        .optional()
        .describe("Try this default response instead of the saved one (null: none)"),
      responseRules: responseRulesSchema
        .nullable()
        .optional()
        .describe("Try these rules instead of the saved ones (null: none)"),
    },
    withErrorHandling(async ({ slug, requestId, mockResponse, responseRules }) => {
      const preview = await client.endpoints.previewResponse(slug, {
        ...(requestId ? { requestId } : {}),
        ...(mockResponse !== undefined ? { mockResponse } : {}),
        ...(responseRules !== undefined ? { responseRules } : {}),
      });
      return jsonContent(preview);
    })
  );

  server.tool(
    "delete_endpoint",
    "Delete a webhook endpoint and all its captured requests.",
    deleteEndpointShape,
    withErrorHandling(async ({ slug }) => {
      await client.endpoints.delete(slug);
      return textContent(`Endpoint "${slug}" deleted.`);
    })
  );

  server.tool(
    "create_endpoints",
    "Create multiple webhook endpoints in one call.",
    {
      count: z.number().int().min(1).max(20).describe("Number of endpoints to create"),
      namePrefix: z.string().optional().describe("Optional prefix for endpoint names"),
      ephemeral: z.boolean().optional().describe("Create temporary endpoints that auto-expire"),
      expiresIn: durationOrTimestampSchema
        .optional()
        .describe('Auto-expire after this duration, for example "12h"'),
    },
    withErrorHandling(async ({ count, namePrefix, ephemeral, expiresIn }) => {
      const endpoints = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          client.endpoints.create({
            name: namePrefix ? `${namePrefix}-${index + 1}` : undefined,
            ephemeral,
            expiresIn,
          })
        )
      );

      return jsonContent({ endpoints });
    })
  );

  server.tool(
    "delete_endpoints",
    "Delete multiple webhook endpoints in one call.",
    {
      slugs: z.array(z.string()).min(1).max(100).describe("Endpoint slugs to delete"),
    },
    withErrorHandling(async ({ slugs }) => {
      const settled = await Promise.allSettled(
        slugs.map(async (slug) => {
          await client.endpoints.delete(slug);
          return slug;
        })
      );

      return jsonContent({
        deleted: settled
          .filter(
            (result): result is PromiseFulfilledResult<string> => result.status === "fulfilled"
          )
          .map((result) => result.value),
        failed: settled.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                {
                  slug: slugs[index],
                  message:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                },
              ]
            : []
        ),
      });
    })
  );

  server.tool(
    "send_webhook",
    "Send a test webhook to a hosted endpoint. Supports provider templates and signing.",
    {
      slug: z.string().describe("The endpoint slug to send to"),
      method: methodSchema,
      headers: z.record(z.string(), z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body"),
      provider: z
        .enum(TEMPLATE_PROVIDERS)
        .optional()
        .describe("Optional provider template to send with signed headers"),
      template: z.string().optional().describe("Provider-specific template preset"),
      event: z.string().optional().describe("Provider event or topic name"),
      secret: z
        .string()
        .optional()
        .describe(
          "Signing secret. Required for signed provider templates; omit for secretless providers (sendgrid, discord, plaid)."
        ),
    },
    withErrorHandling(
      async ({ slug, method, headers, body, provider, template, event, secret }) => {
        let response: Response;

        if (provider) {
          const templateSecret = secret?.trim();
          if (!templateSecret && TEMPLATE_METADATA[provider]?.secretRequired !== false) {
            throw new Error(`send_webhook with provider "${provider}" requires a non-empty secret`);
          }

          response = await client.endpoints.sendTemplate(slug, {
            provider,
            template,
            event,
            secret: templateSecret,
            method,
            headers,
            body,
          });
        } else {
          response = await client.endpoints.send(slug, { method, headers, body });
        }

        const responseBody = await readBodyTruncated(response);
        return jsonContent({
          status: response.status,
          statusText: response.statusText,
          body: responseBody,
        });
      }
    )
  );

  server.tool(
    "list_requests",
    "List recent captured requests for an endpoint, HTTP requests and emails together (filter with kind). For emails, list_emails is shorter.",
    listRequestsShape,
    withErrorHandling(async ({ endpointSlug, limit, since, kind }) => {
      const requests = await client.requests.list(endpointSlug, { limit, since, kind });
      return jsonContent(requests.map(compactRequest));
    })
  );

  server.tool(
    "search_requests",
    "Search captured requests and emails across endpoints: a substring match on path, headers, body and decoded email fields. One call reads back through history for about 2 seconds and returns { requests, complete, searchedUntil, cursor }. When complete is false, older requests were not searched yet: call again with the cursor and the same filters to continue.",
    {
      slug: z.string().optional().describe("Filter to a specific endpoint slug"),
      method: z.string().optional().describe("Filter by HTTP method"),
      kind: kindSchema,
      q: z
        .string()
        .optional()
        .describe(
          "Substring to find in the path, headers, body and decoded email fields (up to 1,000 characters)"
        ),
      from: durationOrTimestampSchema
        .optional()
        .describe(
          'Start time as a timestamp (Unix ms) or a duration back from now like "1h" or "7d". A duration is counted from each call, so when you continue with a cursor pass a timestamp to keep the same range.'
        ),
      to: durationOrTimestampSchema
        .optional()
        .describe(
          'End time as a timestamp (Unix ms) or a duration back from now like "1h" or "7d". A duration is counted from each call, so when you continue with a cursor pass a timestamp to keep the same range.'
        ),
      limit: z.number().int().min(1).max(200).default(50).describe("Max results to return"),
      offset: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .default(0)
        .describe("Matches to skip (first call only; a cursor carries what is left of it)"),
      order: z.enum(["asc", "desc"]).default("desc").describe("Sort order by received time"),
      cursor: z
        .string()
        .optional()
        .describe(
          "The cursor from a previous search_requests result, to continue that search. Keep the other inputs the same."
        ),
    },
    withErrorHandling(async ({ slug, method, kind, q, from, to, limit, offset, order, cursor }) => {
      const page = await client.requests.searchPage(
        { slug, method, kind, q, from, to, limit, offset, order },
        { cursor }
      );
      const searchedUntil = isoTime(page.searchedUntil);
      const envelope = (requests: unknown[], shortened: boolean) => {
        const notes = [
          ...(page.complete ? [] : [searchStoppedNote(searchedUntil, order, Boolean(page.cursor))]),
          ...(shortened ? [SEARCH_SHORTENED_NOTE] : []),
        ];
        return {
          requests,
          complete: page.complete,
          searchedUntil,
          cursor: page.cursor,
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        };
      };
      // The cursor reads on after every match of this page, so every match
      // is listed, shortened where the output would not hold it.
      const requests = page.requests.map(compactRequest);
      if (jsonSize(envelope(requests, false)) <= MAX_BODY_SIZE) {
        return jsonContent(envelope(requests, false));
      }
      // 8: what the brackets of a list with items take over an empty one's.
      const room = MAX_BODY_SIZE - jsonSize(envelope([], true)) - 8;
      return jsonContent(envelope(fitSearchRequests(requests, room), true));
    })
  );

  server.tool(
    "count_requests",
    "Count captured requests and emails that match the given filters (q is a substring match on path, headers, body and decoded email fields). Returns { count, exact, searchedUntil, cursor }. With q or method a call counts back through history for about 2 seconds: when exact is false, count covers history back to searchedUntil only, and calling again with the cursor counts the next stretch (add the counts up).",
    {
      slug: z.string().optional().describe("Filter to a specific endpoint slug"),
      method: z.string().optional().describe("Filter by HTTP method"),
      kind: kindSchema,
      q: z
        .string()
        .optional()
        .describe(
          "Substring to find in the path, headers, body and decoded email fields (up to 1,000 characters)"
        ),
      from: durationOrTimestampSchema
        .optional()
        .describe(
          'Start time as a timestamp (Unix ms) or a duration back from now like "1h" or "7d". A duration is counted from each call, so when you continue with a cursor pass a timestamp to keep the same range.'
        ),
      to: durationOrTimestampSchema
        .optional()
        .describe(
          'End time as a timestamp (Unix ms) or a duration back from now like "1h" or "7d". A duration is counted from each call, so when you continue with a cursor pass a timestamp to keep the same range.'
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "The cursor from a previous count_requests result, to count the next stretch. Keep the other inputs the same."
        ),
    },
    withErrorHandling(async ({ slug, method, kind, q, from, to, cursor }) => {
      const page = await client.requests.countPage({ slug, method, kind, q, from, to }, { cursor });
      const searchedUntil = isoTime(page.searchedUntil);
      return jsonContent({
        count: page.count,
        exact: page.exact,
        searchedUntil,
        cursor: page.cursor,
        ...(page.exact
          ? {}
          : {
              note: `At least ${page.count}, counted ${
                searchedUntil ? `back to ${searchedUntil}` : "over part of the history"
              }; ${
                page.cursor
                  ? "call count_requests again with cursor to count further (the counts add up)."
                  : "there is no cursor to count further with."
              }`,
            }),
      });
    })
  );

  server.tool(
    "get_request",
    "Get the details of a captured request by ID: method, path, headers and body. A request larger than the tool output has its body cut (bodyTruncated, bodySize) and a note saying where the whole request is available.",
    getRequestShape,
    withErrorHandling(async ({ requestId }) => {
      const request = await client.requests.get(requestId);
      return requestContent(request);
    })
  );

  server.tool(
    "wait_for_request",
    "Wait for a request to arrive at an endpoint.",
    waitForRequestShape,
    withErrorHandling(async ({ endpointSlug, timeout, pollInterval }) => {
      const request = await client.requests.waitFor(endpointSlug, { timeout, pollInterval });
      return requestContent(request);
    })
  );

  server.tool(
    "wait_for_requests",
    "Wait for multiple requests to arrive at an endpoint.",
    {
      endpointSlug: z.string().describe("The endpoint slug to monitor"),
      count: z.number().int().min(1).max(20).describe("Number of requests to collect"),
      timeout: durationOrTimestampSchema
        .default("30s")
        .describe('How long to wait, for example "30s"'),
      pollInterval: durationOrTimestampSchema
        .optional()
        .describe('Interval between polls, for example "500ms" or "1s"'),
      method: z.string().optional().describe("Only collect requests with this HTTP method"),
    },
    withErrorHandling(async ({ endpointSlug, count, timeout, pollInterval, method }) => {
      const result = await waitForMultipleRequests(client, endpointSlug, {
        count,
        timeout,
        pollInterval,
        method,
      });
      return jsonContent(
        fitArrayField({ ...result, requests: result.requests.map(compactRequest) }, "requests")
      );
    })
  );

  server.tool(
    "replay_request",
    "Replay a previously captured request to a target URL.",
    {
      requestId: z.string().describe("The captured request ID"),
      targetUrl: httpUrlSchema.describe("The URL to replay the request to"),
    },
    withErrorHandling(async ({ requestId, targetUrl }) => {
      const response = await client.requests.replay(requestId, targetUrl);
      const responseBody = await readBodyTruncated(response);
      return jsonContent({
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
    })
  );

  server.tool(
    "render_email",
    "A captured email in the shape an inbound mail provider posts it (postmark, sendgrid, mailgun, cloudmailin), to test the inbound handler you wrote for that provider against real mail. Returns the method, headers and body; with targetUrl (your local handler), posts it there and returns the answer. A Mailgun form is signed when you pass the signing key your handler checks.",
    {
      requestId: z.string().describe("The captured email's request ID"),
      format: z
        .enum(["postmark", "sendgrid", "mailgun", "cloudmailin", "json"])
        .describe("Whose shape; json is webhooks.cc's own email.received JSON (unsigned)"),
      mailgunSigningKey: z
        .string()
        .optional()
        .describe("For mailgun: the signing key your handler verifies with (a test key)"),
      targetUrl: httpUrlSchema
        .optional()
        .describe("Post it here, e.g. http://localhost:3000/api/inbound/postmark"),
    },
    withErrorHandling(async ({ requestId, format, mailgunSigningKey, targetUrl }) => {
      const rendered = await client.emails.render(requestId, {
        format,
        ...(mailgunSigningKey ? { mailgunSigningKey } : {}),
      });
      if (!targetUrl) {
        return jsonContent(
          shrinkRendered(rendered as unknown as Record<string, unknown>, MAX_BODY_SIZE)
        );
      }
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": rendered.headers["content-type"] },
        body: rendered.body,
        redirect: "manual",
      });
      return jsonContent({
        format,
        status: response.status,
        statusText: response.statusText,
        body: await readBodyTruncated(response),
      });
    })
  );

  server.tool(
    "compare_requests",
    "Compare two captured requests and show the structured differences.",
    {
      leftRequestId: z.string().describe("The first request ID"),
      rightRequestId: z.string().describe("The second request ID"),
      ignoreHeaders: z.array(z.string()).optional().describe("Headers to ignore during comparison"),
    },
    withErrorHandling(async ({ leftRequestId, rightRequestId, ignoreHeaders }) => {
      const [leftRequest, rightRequest] = await Promise.all([
        client.requests.get(leftRequestId),
        client.requests.get(rightRequestId),
      ]);

      const diff = diffRequests(leftRequest, rightRequest, { ignoreHeaders });
      return jsonContent(diff);
    })
  );

  server.tool(
    "generate_payload_schema",
    "Generate TypeScript interfaces, Zod schemas, Pydantic models, or JSON Schema from captured request bodies. Several requests of one event teach which fields are optional or nullable, so filter with event (or pass requestIds) and write the result into the codebase instead of hand-typing the payload.",
    payloadSchemaShape,
    withErrorHandling(async ({ endpointSlug, requestIds, limit, ...args }) => {
      const requests = requestIds
        ? await Promise.all(requestIds.map((id) => client.requests.get(id)))
        : await client.requests.list(endpointSlug, { limit, kind: "http" });
      return payloadSchemaResult(requests, args);
    })
  );

  server.tool(
    "extract_from_request",
    "Extract specific JSON fields from a captured request body.",
    {
      requestId: z.string().describe("The request ID"),
      jsonPaths: z.array(z.string()).min(1).max(50).describe("Dot-notation JSON paths to extract"),
    },
    withErrorHandling(async ({ requestId, jsonPaths }) => {
      const request = await client.requests.get(requestId);
      const extracted = Object.fromEntries(
        jsonPaths.map((path) => [path, extractJsonField(request, path) ?? null])
      );
      return jsonContent(extracted);
    })
  );

  server.tool(
    "verify_signature",
    "Verify the webhook signature on a captured request. When called without provider/secret, returns the server-side pre-computed result (if signing is configured on the endpoint). When called with provider+secret, performs client-side verification.",
    {
      requestId: z.string().describe("The captured request ID"),
      provider: z
        .enum(VERIFY_PROVIDERS)
        .optional()
        .describe("Provider whose signature scheme should be verified. Omit to use stored result."),
      secret: z
        .string()
        .optional()
        .describe(
          "Provider credential for client-side verification (for example a shared signing secret, Adyen hex HMAC key, or PayPal webhook ID). Required for non-Discord providers."
        ),
      publicKey: z
        .string()
        .optional()
        .describe("Discord application public key. Required for provider=discord."),
      url: httpUrlSchema
        .optional()
        .describe("Original signed URL. Required for Twilio, Square, and HubSpot verification."),
      method: z
        .string()
        .optional()
        .describe(
          "Original HTTP method used when the signature was generated. Used by HubSpot v3 verification; the SDK assumes POST when omitted."
        ),
    },
    withErrorHandling(async ({ requestId, provider, secret, publicKey, url, method }) => {
      const request = await client.requests.get(requestId);

      // If no provider/secret given, return the stored server-side result
      if (!provider && !secret && !publicKey) {
        const verified = request.signatureVerified;
        if (verified === null || verified === undefined) {
          return jsonContent({
            valid: null,
            details:
              "No signature verification configured on this endpoint. Pass provider and secret to verify client-side.",
          });
        }
        // Parse stored error to check for skipped verification
        let errorData: { code?: string; message?: string } | null = null;
        if (request.signatureError) {
          try {
            errorData = JSON.parse(request.signatureError);
          } catch {
            errorData = null;
          }
        }
        const isSkipped =
          !verified &&
          errorData?.code &&
          (errorData.code === "missing_header" || errorData.code === "unsupported");

        return jsonContent({
          valid: isSkipped ? null : verified,
          provider: request.signingProvider ?? null,
          details: verified
            ? "Signature verified by server."
            : isSkipped
              ? `Verification skipped: ${errorData?.message ?? errorData?.code}`
              : `Signature invalid: ${request.signatureError ?? "unknown error"}`,
          error: request.signatureError ?? null,
          skipped: isSkipped ?? false,
        });
      }

      // Client-side verification with explicit provider/secret
      const verificationOptions = ensureVerifyArgs({
        provider: provider!,
        secret,
        publicKey,
        url,
        method,
      });
      const result = await verifySignature(request, verificationOptions);
      return jsonContent({
        valid: result.valid,
        details: result.valid ? "Signature is valid." : "Signature did not match.",
      });
    })
  );

  server.tool(
    "clear_requests",
    "Delete captured requests for an endpoint without deleting the endpoint itself.",
    {
      slug: z.string().describe("The endpoint slug to clear"),
      before: durationOrTimestampSchema
        .optional()
        .describe('Only clear requests older than this timestamp or duration like "1h"'),
    },
    withErrorHandling(async ({ slug, before }) => {
      await client.requests.clear(slug, { before });
      return jsonContent({ slug, cleared: true, before: before ?? null });
    })
  );

  server.tool(
    "send_to",
    "Send a webhook directly to any URL with optional provider signing.",
    {
      url: httpUrlSchema.describe("Target URL"),
      method: methodSchema,
      headers: z.record(z.string(), z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body"),
      provider: z
        .enum(TEMPLATE_PROVIDERS)
        .optional()
        .describe("Optional provider template for signing"),
      template: z.string().optional().describe("Provider-specific template preset"),
      event: z.string().optional().describe("Provider event or topic name"),
      secret: z
        .string()
        .optional()
        .describe(
          "Signing secret. Required for signed provider templates; omit for secretless providers (sendgrid, discord, plaid)."
        ),
    },
    withErrorHandling(async ({ url, method, headers, body, provider, template, event, secret }) => {
      const response = await client.sendTo(url, {
        method,
        headers,
        body,
        provider,
        template,
        event,
        secret,
      });
      const responseBody = await readBodyTruncated(response);
      return jsonContent({
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
    })
  );

  server.tool(
    "preview_webhook",
    "Preview a webhook request without sending it. Returns the exact URL, method, headers, and body.",
    {
      url: httpUrlSchema.describe("Target URL"),
      method: methodSchema,
      headers: z.record(z.string(), z.string()).optional().describe("HTTP headers to include"),
      body: z.unknown().optional().describe("Request body"),
      provider: z
        .enum(TEMPLATE_PROVIDERS)
        .optional()
        .describe("Optional provider template for signing"),
      template: z.string().optional().describe("Provider-specific template preset"),
      event: z.string().optional().describe("Provider event or topic name"),
      secret: z
        .string()
        .optional()
        .describe(
          "Signing secret. Required for signed provider templates; omit for secretless providers (sendgrid, discord, plaid)."
        ),
    },
    withErrorHandling(async ({ url, method, headers, body, provider, template, event, secret }) => {
      const preview = await client.buildRequest(url, {
        method,
        headers,
        body,
        provider,
        template,
        event,
        secret,
      });
      return jsonContent(preview);
    })
  );

  server.tool(
    "list_provider_templates",
    "List supported webhook providers, templates, and signing metadata.",
    {
      provider: z.enum(TEMPLATE_PROVIDERS).optional().describe("Filter to a single provider"),
    },
    withErrorHandling(async ({ provider }) => {
      if (provider) {
        return jsonContent([client.templates.get(provider)]);
      }

      return jsonContent(
        client.templates.listProviders().map((name) => client.templates.get(name))
      );
    })
  );

  server.tool(
    "get_billing",
    "What the account pays for: the plan and its subscription (status, monthly or annual, when it renews, a pending change, whether it cancels at the period's end), the add-ons (extra requests, parsed pages, domains), and every team's subscription and add-ons. Read only: change_plan, set_seats, change_addons and cancel_subscription ask the owner to approve a change.",
    {},
    withErrorHandling(async () => {
      // An account in many teams could pass the output budget: trim the
      // teams, so the answer stays JSON and says it was cut.
      const billing = (await client.billing.get()) as unknown as Record<string, unknown>;
      return jsonContent(fitArrayField(billing, "teams"));
    })
  );

  // Billing changes: each is quoted and waits for the owner's approval.
  const billingAsk = (pending: Awaited<ReturnType<typeof client.billing.cancel>>) =>
    pending.id ? approvalAsk(pending) : textContent("Done: the change was made at once.");
  const BILLING_APPROVAL =
    "The account's owner (the team's owner for a team) approves the quoted change, with what is charged now and when it applies: this returns a link and a code to show them, then call wait_for_approval. If the price or the subscription changed before they approve, nothing is changed and you ask again. Only when the person asks for it; never to spend money on your own.";
  const teamIdShape = z
    .string()
    .min(1)
    .optional()
    .describe("A team you own (from list_teams); the account's own billing when left out");

  server.tool(
    "change_plan",
    `Change the plan or its interval: pro or business for the account, team or team_business with teamId. A monthly move up a tier (Pro to Business, Teams to Team Business, or a team to annual) applies at once and charges the difference now; anything else waits for the renewal. keep: true instead drops a plan change waiting for the renewal. A first plan is a checkout the person starts in the browser. ${BILLING_APPROVAL}`,
    {
      plan: z
        .enum(["pro", "business", "team", "team_business"])
        .optional()
        .describe("The plan to move to (team plans need teamId)"),
      interval: z.enum(["month", "year"]).optional().describe("Billing interval (default month)"),
      keep: z
        .boolean()
        .optional()
        .describe("true: keep the current plan, dropping a change waiting for the renewal"),
      teamId: teamIdShape,
    },
    withErrorHandling(async ({ plan, interval, keep, teamId }) => {
      if (keep === true) {
        if (plan !== undefined) throw new Error("Give plan or keep: true, not both.");
        return billingAsk(await client.billing.keepPlan({ teamId }));
      }
      if (plan === undefined) throw new Error("Give plan, or keep: true.");
      return billingAsk(await client.billing.changePlan({ plan, interval, teamId }));
    })
  );

  server.tool(
    "set_seats",
    `Change a team's seat count: more seats apply at once and are charged pro rata now, fewer take effect at the renewal (and need no more members than seats). quote_team_change prices it first. ${BILLING_APPROVAL}`,
    {
      teamId: z.string().min(1).describe("Team id (from list_teams)"),
      seats: z.number().int().min(1).max(1000).describe("The new seat count"),
    },
    withErrorHandling(async ({ teamId, seats }) =>
      billingAsk(await client.billing.setSeats(teamId, seats))
    )
  );

  server.tool(
    "change_addons",
    `Change add-ons: set_monthly_blocks sets the blocks renewed every period (0 ends them at the renewal; more than now are paid at a checkout the owner is sent to), buy_blocks buys one-time blocks at a checkout, set_overage turns overage on (with maxBlocks a period) or off. A block is 25,000 requests, 1,000 parsed pages (Business) or one extra domain (monthly only). ${BILLING_APPROVAL}`,
    {
      action: z.enum(["set_monthly_blocks", "buy_blocks", "set_overage"]),
      resource: z
        .enum(["requests", "pages", "domains"])
        .optional()
        .describe(
          "What the add-on adds to (default requests; domains take set_monthly_blocks only)"
        ),
      blocks: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Blocks for set_monthly_blocks or buy_blocks"),
      enabled: z.boolean().optional().describe("set_overage: on or off"),
      maxBlocks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("set_overage: the most a period may add, in blocks"),
      teamId: teamIdShape,
    },
    withErrorHandling(async ({ action, resource, blocks, enabled, maxBlocks, teamId }) => {
      if (action === "set_overage") {
        if (enabled === undefined) throw new Error("set_overage needs enabled.");
        if (resource === "domains") throw new Error("Domains have no overage.");
        return billingAsk(
          await client.billing.setOverage({ enabled, maxBlocks, resource, teamId })
        );
      }
      if (blocks === undefined) throw new Error(`${action} needs blocks.`);
      if (action === "buy_blocks") {
        if (resource === "domains") throw new Error("Domains are monthly only.");
        return billingAsk(await client.billing.buyBlocks({ blocks, resource, teamId }));
      }
      return billingAsk(await client.billing.setMonthlyBlocks({ blocks, resource, teamId }));
    })
  );

  server.tool(
    "cancel_subscription",
    `Cancel the plan (or a team's subscription) at the end of the period: it, its monthly add-ons and overage stay until then. ${BILLING_APPROVAL}`,
    { teamId: teamIdShape },
    withErrorHandling(async ({ teamId }) => billingAsk(await client.billing.cancel({ teamId })))
  );

  server.tool(
    "resume_subscription",
    `Undo a cancellation, so the plan (or a team's subscription) renews. ${BILLING_APPROVAL}`,
    { teamId: teamIdShape },
    withErrorHandling(async ({ teamId }) =>
      billingAsk(await client.billing.resubscribe({ teamId }))
    )
  );

  server.tool(
    "get_usage",
    "Check current request usage, remaining quota, plan, and period end; parsed pages, preview data (whk share) and AI assists, each with when it resets; and the pooled quota of every subscribed team you belong to.",
    {},
    withErrorHandling(async () => {
      // Team pools are additive: a failing /api/teams must not turn a working
      // personal-usage query into a tool error, so it degrades to teamsError.
      const [usageResult, teamsResult] = await Promise.allSettled([
        client.usage(),
        client.teams.list(),
      ]);
      if (usageResult.status === "rejected") throw usageResult.reason;
      const usage = usageResult.value;
      const teams = teamsResult.status === "fulfilled" ? teamsResult.value : [];
      const teamsError =
        teamsResult.status === "rejected"
          ? teamsResult.reason instanceof Error
            ? teamsResult.reason.message
            : String(teamsResult.reason)
          : undefined;
      return jsonContent({
        ...usage,
        periodEnd: usage.periodEnd ? new Date(usage.periodEnd).toISOString() : null,
        ...(teamsError ? { teamsError } : {}),
        teams: teams
          .filter((team) => !team.suspended)
          .map((team) => ({
            id: team.id,
            name: team.name,
            role: team.role,
            seats: team.seats,
            used: team.requestsUsed,
            limit: team.requestLimit,
            remaining: Math.max(0, team.requestLimit - team.requestsUsed),
            periodEnd: team.periodEnd ? new Date(team.periodEnd).toISOString() : null,
          })),
      });
    })
  );

  server.tool(
    "test_webhook_flow",
    "Run a full webhook test flow: create endpoint, optionally mock, send, wait, verify, replay, and clean up.",
    {
      provider: z
        .enum(TEMPLATE_PROVIDERS)
        .optional()
        .describe("Optional provider template to use when sending the webhook"),
      event: z.string().optional().describe("Optional provider event or topic name"),
      secret: z
        .string()
        .optional()
        .describe(
          "Signing secret. Required when provider is set or signature verification is enabled."
        ),
      mockStatus: z
        .number()
        .int()
        .min(100)
        .max(599)
        .optional()
        .describe("Optional mock response status to configure before sending"),
      targetUrl: httpUrlSchema
        .optional()
        .describe("Optional URL to replay the captured request to after capture"),
      verifySignature: z
        .boolean()
        .default(false)
        .describe("Verify the captured request signature after capture"),
      cleanup: z
        .boolean()
        .default(true)
        .describe("Delete the created endpoint after the flow completes"),
    },
    withErrorHandling(
      async ({
        provider,
        event,
        secret,
        mockStatus,
        targetUrl,
        verifySignature: shouldVerify,
        cleanup,
      }) => {
        const flow = client
          .flow()
          .createEndpoint({ expiresIn: "1h" })
          .waitForCapture({ timeout: "30s", pollInterval: "1s" });

        if (mockStatus !== undefined) {
          flow.setMock({
            status: mockStatus,
            body: "",
            headers: {},
          });
        }

        if (provider) {
          const templateSecret = secret?.trim();
          if (!templateSecret && TEMPLATE_METADATA[provider]?.secretRequired !== false) {
            throw new Error(
              `test_webhook_flow with provider "${provider}" requires a non-empty secret`
            );
          }

          flow.sendTemplate({
            provider,
            event,
            secret: templateSecret,
          });

          if (shouldVerify) {
            // Discord uses Ed25519 public keys (not HMAC), so it cannot
            // be verified through the secret-based flow path.
            if (provider === "discord") {
              throw new Error(
                "test_webhook_flow cannot verify Discord signatures (Ed25519 requires a public key, not a secret)"
              );
            }
            if (!templateSecret) {
              throw new Error(
                `test_webhook_flow cannot verify "${provider}" signatures — this provider's templates are unsigned`
              );
            }

            flow.verifySignature({
              provider: provider as Exclude<typeof provider, "discord">,
              secret: templateSecret,
            });
          }
        } else {
          if (shouldVerify) {
            throw new Error("test_webhook_flow cannot verify signatures without a provider");
          }

          flow.send();
        }

        if (targetUrl) {
          flow.replayTo(targetUrl);
        }
        if (cleanup) {
          flow.cleanup();
        }

        const result = await flow.run();
        return jsonContent({
          endpoint: result.endpoint,
          request: result.request ?? null,
          verification: result.verification ?? null,
          replayResponse: result.replayResponse
            ? await summarizeResponse(result.replayResponse)
            : null,
          cleanedUp: result.cleanedUp,
        });
      }
    )
  );

  server.tool(
    "list_emails",
    "List the emails an endpoint received at its mailhooks.cc address, newest first: subject, sender, tag, and the one-time code and main link found in each.",
    {
      endpointSlug: z.string().describe("The endpoint slug"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe(
          `Max emails to return. With tag, subject or from, the newest ${EMAIL_SCAN_LIMIT} emails are searched.`
        ),
      since: z.number().optional().describe("Only emails received after this timestamp in ms"),
      tag: z
        .string()
        .optional()
        .describe("Only emails sent to {slug}+{tag}@mailhooks.cc (exact, case-sensitive)"),
      subject: z.string().optional().describe("Only emails whose subject contains this text"),
      from: z.string().optional().describe("Only emails from this address (case-insensitive)"),
    },
    withErrorHandling(async ({ endpointSlug, limit, since, tag, subject, from }) => {
      // The SDK filters after listing, so a filter has to look past the newest `limit` emails.
      const filtered = tag !== undefined || subject !== undefined || from !== undefined;
      const scan = filtered ? Math.max(limit, EMAIL_SCAN_LIMIT) : limit;
      const [emails, view] = await Promise.all([
        client.emails.list(endpointSlug, { limit: scan, since, tag, subject, from }),
        emailEndpointView(client, endpointSlug),
      ]);
      return jsonContent(
        emails.slice(0, limit).map((email) => summarizeEmail(email, view.includeExtracts))
      );
    })
  );

  server.tool(
    "get_email",
    "Get one captured email: by requestId, or the newest at an endpoint (optionally with a tag). Returns the parsed message with its one-time code and main link.",
    {
      requestId: z.string().optional().describe("The email's request ID"),
      endpointSlug: z
        .string()
        .optional()
        .describe("Get the newest email at this endpoint instead (with requestId unset)"),
      tag: z.string().optional().describe("With endpointSlug: only emails sent to this +tag"),
      includeHtml: z
        .boolean()
        .default(false)
        .describe("Include the HTML part (default: false, only its size)"),
    },
    withErrorHandling(async ({ requestId, endpointSlug, tag, includeHtml }) => {
      if ((requestId === undefined) === (endpointSlug === undefined)) {
        throw new Error("Pass exactly one of requestId or endpointSlug");
      }
      const email = requestId
        ? await client.emails.get(requestId)
        : await client.emails.latest(endpointSlug!, { tag });
      if (!email) {
        throw new NotFoundError(
          `No email at ${endpointSlug}${tag ? ` with tag "${tag}"` : ""} yet. Send one with send_test_email, or wait with wait_for_email.`
        );
      }
      const view = endpointSlug
        ? await emailEndpointView(client, endpointSlug)
        : await emailEndpointViewFor(client, email);
      return jsonContent(emailDetail(client, email, view, includeHtml));
    })
  );

  server.tool(
    "wait_for_email",
    "Wait for an email to arrive at an endpoint (for example after triggering a signup), then return it with its one-time code and main link. Use a tag per run to find your own email.",
    {
      endpointSlug: z.string().describe("The endpoint slug"),
      tag: z.string().optional().describe("Only emails sent to {slug}+{tag}@mailhooks.cc"),
      subject: z.string().optional().describe("Only emails whose subject contains this text"),
      from: z.string().optional().describe("Only emails from this address (case-insensitive)"),
      timeout: durationOrTimestampSchema
        .default("30s")
        .describe(
          'How long to wait (default "30s"). Keep it under your MCP client\'s request timeout, often 60 seconds.'
        ),
      since: z
        .number()
        .optional()
        .describe("Only emails received after this timestamp in ms (default: five minutes ago)"),
      includeHtml: z.boolean().default(false).describe("Include the HTML part (default: false)"),
    },
    withErrorHandling(async ({ endpointSlug, tag, subject, from, timeout, since, includeHtml }) => {
      // The endpoint first: if it cannot be read, no wait is left polling.
      const view = await emailEndpointView(client, endpointSlug);
      const email = await client.emails.waitFor(endpointSlug, {
        tag,
        subject,
        from,
        timeout,
        since,
      });
      return jsonContent(emailDetail(client, email, view, includeHtml));
    })
  );

  server.tool(
    "send_test_email",
    "Deliver a sample email (with a 6-digit code and a link) to an endpoint, optionally to a +tag address. It counts as one request and skips SMTP, so sender checks do not run on it.",
    {
      slug: z.string().describe("The endpoint slug"),
      tag: z.string().optional().describe("Deliver to {slug}+{tag}@mailhooks.cc"),
    },
    withErrorHandling(async ({ slug, tag }) => {
      const result = await client.emails.sendTest(slug, { tag });
      return jsonContent({ ...result, address: client.emails.address(slug, tag) });
    })
  );

  server.tool(
    "list_destinations",
    "List where an endpoint's captures go: its destinations (up to 10) with their URL, kinds, filter, format, templates and timing, and with summary: true their last 24 hours. Owner only.",
    {
      slug: z.string().describe("The endpoint slug"),
      summary: z.boolean().default(true).describe("Add each destination's last 24 hours"),
    },
    withErrorHandling(async ({ slug, summary }) => {
      return jsonContent(await client.destinations.list(slug, { summary }));
    })
  );

  server.tool(
    "add_destination",
    "Add a destination for an endpoint's captures: your server (as received or signed JSON), a Slack or Discord channel (chat, optionally your own messageTemplate, throttleSeconds 1 for a heads-up), or a JSON body you shape with bodyTemplate (for Zapier, n8n or your API). filter sends only matching captures; delaySeconds makes it a callback. Each destination gets its own signing secret. Check it with preview_destination before relying on it. Owner only.",
    {
      slug: z.string().describe("The endpoint slug"),
      url: httpUrlSchema.describe("https URL on a public host name, or a Slack or Discord webhook"),
      ...destinationFields,
    },
    withErrorHandling(async ({ slug, ...input }) => {
      return jsonContent(await client.destinations.create(slug, input));
    })
  );

  server.tool(
    "update_destination",
    "Change a destination: any of its fields; only the ones you pass change. Owner only.",
    {
      slug: z.string().describe("The endpoint slug"),
      destinationId: z.string().describe("The destination's id (from list_destinations)"),
      url: httpUrlSchema.optional().describe("A new URL"),
      ...destinationFields,
    },
    withErrorHandling(async ({ slug, destinationId, ...input }) => {
      return jsonContent(await client.destinations.update(slug, destinationId, input));
    })
  );

  server.tool(
    "remove_destination",
    "Remove a destination. Deliveries still waiting for it are marked failed; its log stays. Owner only.",
    {
      slug: z.string().describe("The endpoint slug"),
      destinationId: z.string().describe("The destination's id"),
    },
    withErrorHandling(async ({ slug, destinationId }) => {
      await client.destinations.delete(slug, destinationId);
      return textContent(`Destination ${destinationId} removed.`);
    })
  );

  server.tool(
    "preview_destination",
    "Dry run of a destination against a captured request: whether its filter lets the request through and the exact request it would send (method, URL, headers, body with placeholders filled in). Nothing is sent. Use destinationId for a saved destination, destination for unsaved fields (on top of the saved ones, or with a url on their own), or both.",
    {
      slug: z.string().describe("The endpoint slug"),
      destinationId: z.string().optional().describe("A saved destination"),
      destination: z
        .object({ url: httpUrlSchema.optional(), ...destinationFields })
        .optional()
        .describe("Unsaved fields to try"),
      requestId: z
        .string()
        .optional()
        .describe("A captured request (default: the newest of the kind it takes, or a sample)"),
    },
    withErrorHandling(async ({ slug, destinationId, destination, requestId }) => {
      if (!destinationId && !destination?.url) {
        throw new Error("Pass destinationId, or a destination with a url");
      }
      return jsonContent(
        await client.destinations.preview(slug, {
          ...(destinationId ? { destinationId } : {}),
          ...(destination ? { destination } : {}),
          ...(requestId ? { requestId } : {}),
        })
      );
    })
  );

  server.tool(
    "configure_forwarding",
    "Change an endpoint's primary forwarding destination (the one the endpoint's forward* fields stand for): the URL, on or off, which kinds, the format, your own headers, and the advanced options. Only the arguments you pass change. Owner only. For several destinations, filters, templates, throttling or delays, use add_destination and update_destination.",
    {
      slug: z.string().describe("The endpoint slug"),
      url: httpUrlSchema
        .nullable()
        .optional()
        .describe("https URL on a public host name, or null to remove it (forwarding must be off)"),
      enabled: z
        .boolean()
        .optional()
        .describe("Turn forwarding on (needs a URL) or off (fails deliveries still waiting)"),
      http: z.boolean().optional().describe("Forward HTTP requests"),
      email: z.boolean().optional().describe("Forward emails"),
      format: z
        .enum(["auto", "as_received", "json", "chat"])
        .optional()
        .describe(
          "auto (pick from the URL), as_received (relay HTTP requests unchanged; emails as signed JSON), json (signed JSON envelope for both kinds) or chat (Slack or Discord message)"
        ),
      headers: z
        .array(
          z.object({
            name: z.string().describe("Header name, e.g. Authorization"),
            value: z
              .string()
              .nullable()
              .describe("Header value, or null to keep the value stored under this name"),
          })
        )
        .max(10)
        .optional()
        .describe(
          "Your own headers for every delivery (not chat). Replaces the whole list; [] removes them"
        ),
      appendPath: z
        .boolean()
        .optional()
        .describe("Add the path after the slug to the URL for relayed requests (default true)"),
      retrySeconds: z
        .union([z.literal(0), z.literal(3600), z.literal(86400)])
        .optional()
        .describe("Retry failed deliveries for 86400 (default), 3600 or 0 seconds"),
      keepOrder: z
        .boolean()
        .optional()
        .describe("One delivery at a time, in capture order (default false)"),
      sentField: z
        .string()
        .max(128)
        .nullable()
        .optional()
        .describe(
          "JSON body field with the sender's own timestamp, e.g. publishedAt or data.publishedAt; null clears it"
        ),
    },
    withErrorHandling(async ({ slug, ...options }) => {
      const endpoint = await client.forwarding.configure(slug, options);
      return jsonContent({
        slug: endpoint.slug,
        forwardEnabled: endpoint.forwardEnabled ?? false,
        forwardUrl: endpoint.forwardUrl ?? null,
        hasForwardSecret: endpoint.hasForwardSecret ?? false,
        forwardHttp: endpoint.forwardHttp ?? false,
        forwardEmail: endpoint.forwardEmail ?? false,
        forwardFormat: endpoint.forwardFormat ?? "auto",
        forwardHeaders: endpoint.forwardHeaders ?? [],
        forwardAppendPath: endpoint.forwardAppendPath ?? true,
        forwardRetrySeconds: endpoint.forwardRetrySeconds ?? 86400,
        forwardKeepOrder: endpoint.forwardKeepOrder ?? false,
        forwardSentField: endpoint.forwardSentField ?? null,
      });
    })
  );

  server.tool(
    "get_forwarding_secret",
    "Read (or with rotate: true, replace) the whsec_ secret forwarded deliveries are signed with. Owner only. Treat the value as a credential: put it in the handler's environment, not in code.",
    {
      slug: z.string().describe("The endpoint slug"),
      destinationId: z
        .string()
        .optional()
        .describe("A destination (default: the endpoint's primary destination)"),
      rotate: z
        .boolean()
        .default(false)
        .describe("Replace the secret; every delivery from now on uses the new one"),
    },
    withErrorHandling(async ({ slug, destinationId, rotate }) => {
      const secret = destinationId
        ? rotate
          ? await client.destinations.rotateSecret(slug, destinationId)
          : await client.destinations.secret(slug, destinationId)
        : rotate
          ? await client.forwarding.rotateSecret(slug)
          : await client.forwarding.secret(slug);
      return jsonContent({ secret, rotated: rotate });
    })
  );

  server.tool(
    "test_forwarding",
    "Send the endpoint's newest captured request of a kind (or a sample, or requestId) to a destination once, exactly as a delivery would go out, and report the answer. Works whether it is on or off, and whatever its filter says; nothing is retried or logged.",
    {
      slug: z.string().describe("The endpoint slug"),
      destinationId: z
        .string()
        .optional()
        .describe("A destination (default: the endpoint's primary destination)"),
      kind: z
        .enum(["http", "email"])
        .optional()
        .describe("Which kind to send (default: http when the destination takes HTTP requests)"),
      requestId: z.string().optional().describe("With destinationId: a captured request to send"),
    },
    withErrorHandling(async ({ slug, destinationId, kind, requestId }) => {
      if (destinationId) {
        return jsonContent(
          await client.destinations.test(slug, destinationId, {
            ...(kind ? { kind } : {}),
            ...(requestId ? { requestId } : {}),
          })
        );
      }
      return jsonContent(await client.forwarding.test(slug, kind ? { kind } : {}));
    })
  );

  server.tool(
    "list_deliveries",
    "List forwarding deliveries: an endpoint's delivery log with its counts (endpointSlug), or every delivery and try of one captured request or email (requestId). Rows carry senderAt when the request had the sender's own timestamp, so receivedAt - senderAt is the time to reach webhooks.cc.",
    {
      endpointSlug: z.string().optional().describe("List the endpoint's delivery log"),
      requestId: z.string().optional().describe("List every delivery and try of this request"),
      limit: z.number().int().min(1).max(100).default(20).describe("With endpointSlug: max rows"),
      status: z
        .enum(["all", "pending", "failed", "skipped"])
        .default("all")
        .describe(
          "With endpointSlug: all, pending (queued or retrying), failed or skipped (filtered out)"
        ),
      destinationId: z.string().optional().describe("With endpointSlug: only this destination"),
      before: z
        .string()
        .optional()
        .describe("With endpointSlug: a row's cursor, to list older rows"),
    },
    withErrorHandling(async ({ endpointSlug, requestId, limit, status, destinationId, before }) => {
      if ((requestId === undefined) === (endpointSlug === undefined)) {
        throw new Error("Pass exactly one of endpointSlug or requestId");
      }
      if (requestId) return jsonContent(await client.forwarding.requestDeliveries(requestId));
      const [summary, deliveries] = await Promise.all([
        client.forwarding.summary(endpointSlug!),
        client.forwarding.deliveries(endpointSlug!, {
          limit,
          status,
          before,
          ...(destinationId ? { destinationId } : {}),
        }),
      ]);
      return jsonContent({
        summary,
        deliveries,
        nextCursor:
          deliveries.length === limit ? (deliveries[deliveries.length - 1]?.cursor ?? null) : null,
      });
    })
  );

  server.tool(
    "redeliver",
    "Forward again with the current settings: one captured request or email (requestId; to every destination that takes it, or with destinationId to that one whatever its filter says), or every request whose latest delivery failed (endpointSlug, optionally only destinationId, oldest first, up to 1,000 at a time per destination). Owner only.",
    {
      requestId: z.string().optional().describe("The request or email to send again"),
      endpointSlug: z
        .string()
        .optional()
        .describe("Send every failed delivery of this endpoint again"),
      destinationId: z.string().optional().describe("Only this destination"),
    },
    withErrorHandling(async ({ requestId, endpointSlug, destinationId }) => {
      if ((requestId === undefined) === (endpointSlug === undefined)) {
        throw new Error("Pass exactly one of requestId or endpointSlug");
      }
      const options = destinationId ? { destinationId } : {};
      return jsonContent(
        requestId
          ? await client.forwarding.redeliver(requestId, options)
          : await client.forwarding.redeliverFailed(endpointSlug!, options)
      );
    })
  );

  // Shares this server started, by port, so asking again returns the same
  // link. They run until stop_share, the plan's limit, or this server's end
  // (whk stops when its stdin closes).
  const started = new Map<number, LiveShare>();

  server.tool(
    "share_port",
    "Share a port on this computer at a public link (https://<name>.sharehooks.cc) by running the webhooks.cc CLI (whk share), so a person can open the site you are building. Returns the link. It keeps running until stop_share, the plan's session limit, or the end of this MCP server. Asking again for the same port without a name or password returns the running link; with a name or password, the running share on that port stops and a new one starts. Free accounts get a random name ending in -free, a 2-hour limit and a notice page before the site; Pro and Business can use a reserved name and a password. Needs whk installed on this computer. For a webhook provider that must get your local app's real answer, use `whk tunnel <port> --live` instead.",
    {
      port: z.number().int().min(1).max(65535).describe("The local port the site runs on"),
      name: z
        .string()
        .optional()
        .describe("A name you reserved (Pro and Business); leave out for a random one"),
      password: z
        .string()
        .min(8)
        .max(200)
        .optional()
        .describe("What visitors must type (Pro and Business), 8 to 200 characters"),
    },
    withErrorHandling(async ({ port, name, password }) => {
      const running = started.get(port);
      if (running && !name && !password) {
        return jsonContent({ ...shareSummary(running), alreadyRunning: true });
      }
      // New options for a port already shared: the running share stops first,
      // so no whk run is left behind that this server no longer tracks.
      if (running) {
        started.delete(port);
        await running.stop();
      }
      let live: LiveShare;
      try {
        live = await client.shares.start({
          port,
          ...(name ? { name } : {}),
          ...(password ? { password } : {}),
          ...(process.env.WHK_PATH ? { whkPath: process.env.WHK_PATH } : {}),
        });
      } catch (error) {
        // whk's own words, plus what an agent can do here without the
        // dashboard: see what runs and the plan's limits, free a slot.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message} With these tools: list_shares shows what runs and the plan's limits, stop_share frees a slot, list_names shows the names you can use.`
        );
      }
      started.set(port, live);
      void live.closed.then(() => {
        if (started.get(port) === live) started.delete(port);
      });
      const summary: Record<string, unknown> = shareSummary(live);
      // The plan's limits and this month's data, so the agent knows what is
      // left; a failure here never hides the link.
      try {
        const list = await client.shares.list({ state: "live" });
        summary.limits = list.limits;
        summary.usage = list.usage;
        const hints = shareHints(list);
        if (hints.length > 0) summary.hints = hints;
      } catch {
        // The link is what matters.
      }
      return jsonContent(summary);
    })
  );

  server.tool(
    "list_shares",
    `List your public previews of local ports (whk share${remote ? "" : ", share_port"}) and live tunnels (whk tunnel --live): live ones first, then the latest that ended, with this month's shared data and your plan's sharing limits. Not the same as share_endpoint, which shares an endpoint with a team.`,
    {
      state: z
        .enum(["live", "ended"])
        .optional()
        .describe("Only the running ones, or only the ended ones"),
    },
    withErrorHandling(async ({ state }) => {
      return jsonContent(withShareHints(await client.shares.list(state ? { state } : {}), remote));
    })
  );

  server.tool(
    "list_api_keys",
    "List the account's API keys: id, name, prefix, when they were made, when they expire and when they were last used. The keys themselves are never listed.",
    {},
    withErrorHandling(async () => jsonContent(await client.apiKeys.list()))
  );

  server.tool(
    "create_api_key",
    "Ask for a new API key for the account, for CI or another tool. The account's owner must approve it: this returns at once with a link and a code. Show the person the link and tell them to check that the page shows the same code, then call wait_for_approval with the approval id to get the key (shown once).",
    {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe('A name that says where the key is used, such as "GitHub Actions"'),
      expiresInDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("How many days the key works, 1 to 365 (default 90)"),
    },
    withErrorHandling(async ({ name, expiresInDays }) => {
      const pending = await client.apiKeys.create({ name, expiresInDays });
      if (!pending.id) {
        const key = await pending.wait();
        return textContent(keyText(key));
      }
      return approvalAsk(pending);
    })
  );

  server.tool(
    "wait_for_approval",
    "Wait for the account's owner to answer an approval (from create_api_key, create_share_link, remove_domain, rename_account, delete_team, invite_to_team, connect_google, pick_spreadsheet, ai_setup or a billing change) and collect what it grants or did, such as the new API key, the share link or AI setup's proposals. If they have not answered yet, call it again.",
    {
      id: z.string().describe("The approval id"),
      timeout: durationOrTimestampSchema
        .default("45s")
        .describe('How long to wait for the person, for example "45s"'),
    },
    withErrorHandling(async ({ id, timeout }) =>
      textContent(await waitForApprovalText(client, id, durationMs(timeout) ?? 45_000))
    )
  );

  server.tool(
    "revoke_api_key",
    "Revoke one of the account's API keys by its id (from list_api_keys). Anything using it stops working at once.",
    {
      id: z.string().describe("The key's id, from list_api_keys"),
    },
    withErrorHandling(async ({ id }) => {
      await client.apiKeys.revoke(id);
      return textContent(`Revoked the API key ${id}, if the account had it.`);
    })
  );

  server.tool(
    "rename_account",
    "Set the account's display name, or clear it with null. The account's owner must approve it: this returns a link and a code to show them, then call wait_for_approval.",
    {
      name: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .describe("The new display name, or null to clear it"),
    },
    withErrorHandling(async ({ name }) => {
      const pending = await client.account.rename(name);
      if (!pending.id) return textContent(approvalResultText(await pending.wait()));
      return approvalAsk(pending);
    })
  );

  server.tool(
    "list_connected_agents",
    "List the agents connected to the account (claimed agents and OAuth sign-ins such as hosted MCP clients): id, client name, when each connected and was last used.",
    {},
    withErrorHandling(async () => jsonContent(await client.agents.list()))
  );

  server.tool(
    "disconnect_agent",
    "Disconnect an agent by its id (from list_connected_agents): its tokens stop working at once. The endpoints it made stay in the account. Disconnecting the agent you are running as ends your own access.",
    {
      id: z.string().describe("The agent's id, from list_connected_agents"),
    },
    withErrorHandling(async ({ id }) => {
      await client.agents.disconnect(id);
      return textContent(`Disconnected the agent ${id}.`);
    })
  );

  server.tool(
    "list_share_links",
    "List live public links to frozen copies of requests (/s/<token>), the account's or one request's. Not the same as list_shares, which lists port previews and live tunnels.",
    {
      requestId: z.string().optional().describe("Only the links to this request"),
    },
    withErrorHandling(async ({ requestId }) => {
      const links = requestId
        ? await client.shareLinks.forRequest(requestId)
        : await client.shareLinks.list();
      return jsonContent(links);
    })
  );

  server.tool(
    "create_share_link",
    "Make a public link to a read-only copy of one HTTP request (not an email), for a teammate or a bug report. Anyone with the link can read it, so the account's owner must approve: this returns a link and a code to show them, then call wait_for_approval for the share link.",
    {
      requestId: z.string().describe("The request's id"),
      expiresInDays: z
        .union([z.literal(1), z.literal(7), z.literal(30)])
        .optional()
        .describe("How long the link works: 1, 7 or 30 days (default 7)"),
      hideSensitive: z
        .boolean()
        .optional()
        .describe(
          "Also leave out signature and token headers (default true). Credentials are always left out."
        ),
    },
    withErrorHandling(async ({ requestId, expiresInDays, hideSensitive }) => {
      const pending = await client.shareLinks.create(requestId, { expiresInDays, hideSensitive });
      if (!pending.id) return textContent(approvalResultText({ ...(await pending.wait()) }));
      return approvalAsk(pending);
    })
  );

  server.tool(
    "revoke_share_link",
    "Revoke a share link by its id (from list_share_links): its page answers 404 from then on.",
    {
      id: z.string().describe("The link's id, from list_share_links"),
    },
    withErrorHandling(async ({ id }) => {
      await client.shareLinks.revoke(id);
      return textContent(`Revoked the share link ${id}.`);
    })
  );

  const teamIdSchema = z
    .string()
    .optional()
    .describe("A Team Business team's id (its owner only); leave out for your own account");

  server.tool(
    "list_domains",
    "List custom inbound domains (Business): each one's status, DNS records to publish, routes and catch-all endpoint.",
    { teamId: teamIdSchema },
    withErrorHandling(async ({ teamId }) => jsonContent(await client.domains.list({ teamId })))
  );

  server.tool(
    "add_domain",
    "Add a custom inbound domain (Business) so mail to it is captured. Returns the TXT and MX records to publish; then call verify_domain.",
    {
      domain: z.string().min(1).max(253).describe("The domain, such as mail.example.com"),
      teamId: teamIdSchema,
    },
    withErrorHandling(async ({ domain, teamId }) =>
      jsonContent(await client.domains.add(domain, { teamId }))
    )
  );

  server.tool(
    "verify_domain",
    "Look a custom domain's TXT and MX records up now. It receives mail once both are found.",
    {
      id: z.string().describe("The domain's id, from list_domains"),
      teamId: teamIdSchema,
    },
    withErrorHandling(async ({ id, teamId }) =>
      jsonContent(await client.domains.verify(id, { teamId }))
    )
  );

  server.tool(
    "route_domain",
    "Set where a custom domain's mail goes: routes by local part (the part before @) to endpoints, everything else to a catch-all endpoint, or refused when the catch-all is null. Replaces the domain's routing.",
    {
      id: z.string().describe("The domain's id, from list_domains"),
      catchAllEndpointId: z
        .string()
        .nullable()
        .describe("The endpoint id for mail no route matches, or null to refuse it"),
      routes: z
        .array(
          z.object({
            localPart: z.string().max(64).describe("The part before @"),
            endpointId: z.string().describe("The endpoint's id"),
          })
        )
        .max(100)
        .default([])
        .describe("Routes by local part"),
      teamId: teamIdSchema,
    },
    withErrorHandling(async ({ id, catchAllEndpointId, routes, teamId }) =>
      jsonContent(await client.domains.route(id, { catchAllEndpointId, routes }, { teamId }))
    )
  );

  server.tool(
    "remove_domain",
    "Remove a custom inbound domain: mail to it is refused from then on. The account's owner must approve it: this returns a link and a code to show them, then call wait_for_approval.",
    {
      id: z.string().describe("The domain's id, from list_domains"),
      teamId: teamIdSchema,
    },
    withErrorHandling(async ({ id, teamId }) => {
      const pending = await client.domains.remove(id, { teamId });
      if (!pending.id) return textContent(`Removed the domain ${id}.`);
      return approvalAsk(pending);
    })
  );

  server.tool(
    "list_google_connections",
    "List the Google accounts connected for Google Sheets destinations (id, email, when connected), and whether Google Sheets is set up on this server.",
    {},
    withErrorHandling(async () => jsonContent(await client.google.connections()))
  );

  server.tool(
    "connect_google",
    "Connect a Google account for Google Sheets destinations. The account's owner must approve it: this returns a link and a code to show them, and approving takes them to Google to choose the account. Then call wait_for_approval for the new connection's id.",
    {},
    withErrorHandling(async () => approvalAsk(await client.google.connect()))
  );

  server.tool(
    "pick_spreadsheet",
    "Have the account's owner choose an existing spreadsheet from Google Drive with a connected account (to add rows to it from a Sheets destination). Returns a link and a code to show them; the page opens Google's picker. Then call wait_for_approval for the spreadsheet's id and tabs. To use a new spreadsheet instead, call create_spreadsheet.",
    {
      connectionId: z.string().describe("The Google connection's id, from list_google_connections"),
    },
    withErrorHandling(async ({ connectionId }) =>
      approvalAsk(await client.google.pick(connectionId))
    )
  );

  server.tool(
    "create_spreadsheet",
    "Create a new spreadsheet with a header row in a connected Google account, for a Sheets destination. Needs no approval: the app reaches only spreadsheets it created or that were chosen for it.",
    {
      connectionId: z.string().describe("The Google connection's id, from list_google_connections"),
      title: z.string().max(200).optional().describe("The spreadsheet's title"),
      sheet: z.string().max(100).optional().describe('The tab rows go to (default "Sheet1")'),
      headers: z.array(z.string().max(200)).max(50).describe("The header row, one per column"),
    },
    withErrorHandling(async ({ connectionId, title, sheet, headers }) =>
      jsonContent(await client.google.createSpreadsheet({ connectionId, title, sheet, headers }))
    )
  );

  server.tool(
    "list_sheet_tabs",
    "List a spreadsheet's tabs (one created by the app or chosen with pick_spreadsheet), to choose the one a Sheets destination writes to.",
    {
      connectionId: z.string().describe("The Google connection's id"),
      spreadsheetId: z.string().describe("The spreadsheet's id"),
    },
    withErrorHandling(async ({ connectionId, spreadsheetId }) =>
      jsonContent({ tabs: await client.google.tabs(connectionId, spreadsheetId) })
    )
  );

  server.tool(
    "disconnect_google",
    "Disconnect a Google account (id from list_google_connections) and revoke its access at Google. Sheets destinations using it fail until another account is chosen.",
    {
      connectionId: z.string().describe("The Google connection's id"),
    },
    withErrorHandling(async ({ connectionId }) => {
      await client.google.disconnect(connectionId);
      return textContent(`Disconnected the Google account ${connectionId}.`);
    })
  );

  server.tool(
    "ai_setup_status",
    "Whether AI setup is offered for an endpoint, and how many AI assists the plan has left in a rolling 30 days.",
    {
      slug: z.string().describe("The endpoint's slug"),
    },
    withErrorHandling(async ({ slug }) => jsonContent(await client.ai.status(slug)))
  );

  server.tool(
    "ai_setup",
    "Have AI propose email fields (or a layout, or a repaired field) from 1 to 5 of an endpoint's captured emails. It sends those emails (subject, sender, recipients, text, headers; never attachments) to Anthropic's model, so the account's owner must approve it: this returns a link and a code to show them, and the page lists the emails. Then call wait_for_approval for the proposals, each with the value it found in every email. Nothing is saved: apply the fields with update_endpoint. Uses one AI assist.",
    {
      slug: z.string().describe("The endpoint's slug"),
      requestIds: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("1 to 5 of the endpoint's email request ids, from list_emails"),
      ask: z
        .union([
          z.object({
            kind: z.literal("field"),
            name: z.string().describe("The field's name: letters, digits and _"),
            description: z.string().describe('What the field is, such as "the order number"'),
          }),
          z.object({
            kind: z.literal("layout"),
            description: z.string().optional().describe("What these emails are"),
          }),
          z.object({
            kind: z.literal("repair"),
            field: z
              .object({
                name: z.string(),
                from: z.string(),
                header: z.string().optional(),
                pattern: z.string(),
              })
              .describe("The field to repair, as the endpoint has it"),
          }),
        ])
        .describe("What to propose"),
    },
    withErrorHandling(async ({ slug, requestIds, ask }) =>
      approvalAsk(
        await client.ai.setup(slug, {
          requestIds,
          ask: ask as Parameters<typeof client.ai.setup>[1]["ask"],
        })
      )
    )
  );

  server.tool(
    "stop_share",
    "Stop a public preview or live tunnel by its id (from list_shares). The CLI running it is told why and exits.",
    {
      id: z.string().describe("The share's id, from list_shares"),
    },
    withErrorHandling(async ({ id }) => {
      const result = await client.shares.stop(id);
      return jsonContent({
        id,
        stopped: result.stopped,
        edgeReached: result.edgeReached,
        note: result.stopped
          ? result.edgeReached
            ? "Stopped; its CLI was told and exits."
            : "Stopped; the edge could not be told at once, so it ends within half a minute."
          : "It had already ended.",
      });
    })
  );

  server.tool(
    "share_requests",
    "The last requests visitors made to a running preview (from list_shares), newest first: method, path, status, time, size, country, device and a number per visitor, never an address. Use it to see whether the person opened the link and what failed for them. `available` is false when the log could not be read just now.",
    {
      id: z.string().describe("The share's id, from list_shares"),
    },
    withErrorHandling(async ({ id }) => {
      return jsonContent(await client.shares.requests(id));
    })
  );

  server.tool(
    "list_names",
    `List the reserved preview names you can share under (Pro and Business): your own and your teams', each with its link, whether it has a password, whether a preview runs under it now, and whether your plan still covers it (usable). Includes how many your plan allows and how many you hold. Share under one with ${remote ? "`whk share <port> --name <name>` on the person's computer (or the local MCP server's share_port)" : "share_port and its name"}.`,
    {},
    withErrorHandling(async () => {
      return jsonContent(await client.names.list());
    })
  );

  server.tool(
    "reserve_name",
    `Reserve a preview name, so ${shareWith} can use the link https://<name>.sharehooks.cc (Pro and Business). Lowercase letters, digits and dashes; names that look like random ones or end in -free are refused. With team, the name belongs to that team and every member may share under it.`,
    {
      name: z.string().min(1).max(63).describe("The name: lowercase letters, digits and dashes"),
      team: z
        .string()
        .optional()
        .describe("A team's id or name (from list_teams), to keep the name inside that team"),
    },
    withErrorHandling(async ({ name, team }) => {
      return jsonContent(await client.names.reserve(name, team ? { team } : {}));
    })
  );

  server.tool(
    "release_name",
    "Release a reserved preview name you kept (or, for a team name, as the team's owner). A preview running under it stops, and the link stops working.",
    {
      name: z.string().min(1).max(63).describe("The name, from list_names"),
    },
    withErrorHandling(async ({ name }) => {
      await client.names.release(name);
      return jsonContent({ released: name });
    })
  );

  server.tool(
    "set_name_password",
    "Put a password on every preview under a reserved name (Pro and Business): visitors must type it before the page opens. The password is not shown back; give it to the person yourself.",
    {
      name: z.string().min(1).max(63).describe("The name, from list_names"),
      password: z.string().min(8).max(200).describe("What visitors must type, 8 to 200 characters"),
    },
    withErrorHandling(async ({ name, password }) => {
      await client.names.setPassword(name, password);
      return jsonContent({ name, password: true });
    })
  );

  server.tool(
    "clear_name_password",
    "Take the password off a reserved name, so its previews open without one.",
    {
      name: z.string().min(1).max(63).describe("The name, from list_names"),
    },
    withErrorHandling(async ({ name }) => {
      await client.names.clearPassword(name);
      return jsonContent({ name, password: false });
    })
  );

  server.tool(
    "describe",
    "Describe all available SDK operations, parameters, and types.",
    {},
    withErrorHandling(async () => {
      const description = client.describe();
      return jsonContent(description);
    })
  );

  return handles;
}

export {
  clientLoadsEverything,
  defaultToolGroups,
  parseToolGroups,
  TOOL_CATALOG,
  TOOL_GROUP_NAMES,
  TOOL_GROUPS,
  toolAnnotations,
  type ToolGroup,
} from "./catalog";

export { sdkToolResult, toolCallFrom } from "./sdk-call";
export { attachSkill } from "./skills";
export { attachInspector, INSPECTOR_URI, INSPECTOR_URI_TEMPLATE, APP_MIME_TYPE } from "./app";
