import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diffRequests,
  extractJsonField,
  MOCK_RESPONSE_DELAY_MAX,
  MOCK_RESPONSE_DELAY_MIN,
  MOCK_RESPONSE_STATUS_MAX,
  MOCK_RESPONSE_STATUS_MIN,
  MAX_CONDITION_VALUE_LEN,
  MAX_CONDITION_NAME_LEN,
  MAX_CONDITION_PATH_LEN,
  MAX_RULE_NAME_LEN,
  MAX_GLOB_PATTERN_LEN,
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
  extractCode,
  extractLink,
  type EmailRequest,
  type Request,
  type VerifyProvider,
} from "@webhooks-cc/sdk";
import {
  capExtracts,
  capLists,
  compactRequest,
  cutEmailText,
  cutStringToFit,
  jsonSize,
  keepOnly,
  MAX_OUTPUT,
  omitHeaders,
  shrinkToFit,
  sliceText,
  TEXT_FLOOR,
} from "./compact";

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
const ruleConditionSchema = z
  .object({
    field: z
      .enum(["method", "path", "header", "body_contains", "body_path", "query"])
      .describe("Request field to match against"),
    op: z
      .enum(["eq", "contains", "starts_with", "matches", "exists"])
      .describe("Comparison operator"),
    value: z
      .string()
      .max(MAX_CONDITION_VALUE_LEN)
      .optional()
      .describe(
        `Value to compare against (required unless op is "exists", max ${MAX_CONDITION_VALUE_LEN} chars)`
      ),
    name: z
      .string()
      .max(MAX_CONDITION_NAME_LEN)
      .optional()
      .describe(
        `Header name or query param name (required for header/query, max ${MAX_CONDITION_NAME_LEN} chars)`
      ),
    path: z
      .string()
      .max(MAX_CONDITION_PATH_LEN)
      .optional()
      .describe(
        `JSON dot-notation path (required for body_path, max ${MAX_CONDITION_PATH_LEN} chars)`
      ),
  })
  .refine((c) => c.op === "exists" || (c.value !== undefined && c.value.length > 0), {
    message: 'value is required when op is not "exists"',
  })
  .refine(
    (c) =>
      !(c.field === "header" || c.field === "query") || (c.name !== undefined && c.name.length > 0),
    { message: "name is required for header and query conditions" }
  )
  .refine((c) => c.field !== "body_path" || (c.path !== undefined && c.path.length > 0), {
    message: "path is required for body_path conditions",
  })
  .refine((c) => c.op !== "matches" || !c.value || c.value.length <= MAX_GLOB_PATTERN_LEN, {
    message: `matches pattern must be ${MAX_GLOB_PATTERN_LEN} chars or less`,
  });

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
  body: z.string().default("").describe("Response body string (default: empty)"),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe("Response headers (default: none)"),
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

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

/** Create a text content response for MCP tools. */
function textContent(text: string): ToolResult {
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

function jsonContent(value: unknown): ToolResult {
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

  return JSON.stringify(payload, null, 2);
}

/** Wrap a tool handler with error handling that returns structured MCP errors. */
function withErrorHandling<T>(
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

    await sleep(Math.max(10, pollIntervalMs));
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
  const endpoint = await client.endpoints.get(slug);
  return {
    endpoint: { slug: endpoint.slug, name: endpoint.name ?? null },
    includeExtracts: endpoint.showEmailExtracts !== false,
  };
}

function emailSlugFromAddress(address: string): string {
  const local = address.slice(0, Math.max(0, address.lastIndexOf("@")));
  return local.split("+")[0].toLowerCase();
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
  "size",
  "test",
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
    () => omitHeaders(detail),
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
export function registerTools(server: McpServer, client: WebhooksCC): void {
  server.tool(
    "create_endpoint",
    "Create a webhook endpoint. Returns the endpoint slug, URL, and metadata.",
    {
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
    },
    withErrorHandling(
      async ({
        name,
        ephemeral,
        expiresIn,
        mockResponse,
        responseRules,
        notificationUrl,
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
    {
      team: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Team id or name (case-insensitive). Keeps endpoints shared with you from that team and endpoints you own that are shared with it."
        ),
    },
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
    "get_endpoint",
    "Get details for a specific webhook endpoint by slug.",
    { slug: z.string().describe("The endpoint slug") },
    withErrorHandling(async ({ slug }) => {
      const endpoint = await client.endpoints.get(slug);
      return jsonContent(endpoint);
    })
  );

  server.tool(
    "update_endpoint",
    "Update an endpoint name, mock response, conditional response rules, signing configuration, or whether codes and links are picked out of its emails.",
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
        });
        return jsonContent(endpoint);
      }
    )
  );

  server.tool(
    "delete_endpoint",
    "Delete a webhook endpoint and all its captured requests.",
    { slug: z.string().describe("The endpoint slug to delete") },
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
    {
      endpointSlug: z.string().describe("The endpoint slug"),
      limit: z.number().int().min(1).max(100).default(25).describe("Max requests to return"),
      since: z.number().optional().describe("Only return requests after this timestamp in ms"),
      kind: kindSchema,
    },
    withErrorHandling(async ({ endpointSlug, limit, since, kind }) => {
      const requests = await client.requests.list(endpointSlug, { limit, since, kind });
      return jsonContent(requests.map(compactRequest));
    })
  );

  server.tool(
    "search_requests",
    "Search captured webhook requests across endpoints using retained full-text search.",
    {
      slug: z.string().optional().describe("Filter to a specific endpoint slug"),
      method: z.string().optional().describe("Filter by HTTP method"),
      kind: kindSchema,
      q: z.string().optional().describe("Free-text search across path, body, and headers"),
      from: durationOrTimestampSchema
        .optional()
        .describe('Start time as a timestamp or duration like "1h" or "7d"'),
      to: durationOrTimestampSchema
        .optional()
        .describe('End time as a timestamp or duration like "1h" or "7d"'),
      limit: z.number().int().min(1).max(200).default(50).describe("Max results to return"),
      offset: z.number().int().min(0).max(10_000).default(0).describe("Result offset"),
      order: z.enum(["asc", "desc"]).default("desc").describe("Sort order by received time"),
    },
    withErrorHandling(async ({ slug, method, kind, q, from, to, limit, offset, order }) => {
      const results = await client.requests.search({
        slug,
        method,
        kind,
        q,
        from,
        to,
        limit,
        offset,
        order,
      });
      return jsonContent(results.map(compactRequest));
    })
  );

  server.tool(
    "count_requests",
    "Count captured webhook requests that match the given filters.",
    {
      slug: z.string().optional().describe("Filter to a specific endpoint slug"),
      method: z.string().optional().describe("Filter by HTTP method"),
      kind: kindSchema,
      q: z.string().optional().describe("Free-text search across path, body, and headers"),
      from: durationOrTimestampSchema
        .optional()
        .describe('Start time as a timestamp or duration like "1h" or "7d"'),
      to: durationOrTimestampSchema
        .optional()
        .describe('End time as a timestamp or duration like "1h" or "7d"'),
    },
    withErrorHandling(async ({ slug, method, kind, q, from, to }) => {
      const count = await client.requests.count({ slug, method, kind, q, from, to });
      return jsonContent({ count });
    })
  );

  server.tool(
    "get_request",
    "Get full details for a specific captured request by ID.",
    { requestId: z.string().describe("The request ID") },
    withErrorHandling(async ({ requestId }) => {
      const request = await client.requests.get(requestId);
      return jsonContent(compactRequest(request));
    })
  );

  server.tool(
    "wait_for_request",
    "Wait for a request to arrive at an endpoint.",
    {
      endpointSlug: z.string().describe("The endpoint slug to monitor"),
      timeout: durationOrTimestampSchema
        .default("30s")
        .describe('How long to wait, for example "30s"'),
      pollInterval: durationOrTimestampSchema
        .optional()
        .describe('Interval between polls, for example "500ms" or "1s"'),
    },
    withErrorHandling(async ({ endpointSlug, timeout, pollInterval }) => {
      const request = await client.requests.waitFor(endpointSlug, { timeout, pollInterval });
      return jsonContent(compactRequest(request));
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
    "get_usage",
    "Check current request usage, remaining quota, plan, and period end, plus the pooled quota of every subscribed team you belong to.",
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
          .waitForCapture({ timeout: "30s" });

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
      const view = await emailEndpointView(
        client,
        endpointSlug ?? emailSlugFromAddress(email.path)
      );
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
      const [email, view] = await Promise.all([
        client.emails.waitFor(endpointSlug, { tag, subject, from, timeout, since }),
        emailEndpointView(client, endpointSlug),
      ]);
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
    "configure_forwarding",
    "Set the URL captured emails are forwarded to (as signed JSON) and turn forwarding on or off. Owner only. Saving the first URL creates the signing secret.",
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
    },
    withErrorHandling(async ({ slug, url, enabled }) => {
      const endpoint = await client.forwarding.configure(slug, { url, enabled });
      return jsonContent({
        slug: endpoint.slug,
        forwardEnabled: endpoint.forwardEnabled ?? false,
        forwardUrl: endpoint.forwardUrl ?? null,
        hasForwardSecret: endpoint.hasForwardSecret ?? false,
      });
    })
  );

  server.tool(
    "get_forwarding_secret",
    "Read (or with rotate: true, replace) the whsec_ secret forwarded emails are signed with. Owner only. Treat the value as a credential: put it in the handler's environment, not in code.",
    {
      slug: z.string().describe("The endpoint slug"),
      rotate: z
        .boolean()
        .default(false)
        .describe("Replace the secret; every delivery from now on uses the new one"),
    },
    withErrorHandling(async ({ slug, rotate }) => {
      const secret = rotate
        ? await client.forwarding.rotateSecret(slug)
        : await client.forwarding.secret(slug);
      return jsonContent({ secret, rotated: rotate });
    })
  );

  server.tool(
    "test_forwarding",
    "Post the endpoint's newest email (or a sample) to its forwarding URL once and report what the server answered. Works with forwarding on or off; nothing is retried or logged.",
    { slug: z.string().describe("The endpoint slug") },
    withErrorHandling(async ({ slug }) => {
      return jsonContent(await client.forwarding.test(slug));
    })
  );

  server.tool(
    "list_deliveries",
    "List forwarding deliveries: an endpoint's latest (endpointSlug), or every try of one email (requestId).",
    {
      endpointSlug: z.string().optional().describe("List the endpoint's latest deliveries"),
      requestId: z.string().optional().describe("List every delivery and try of this email"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("With endpointSlug: max deliveries"),
    },
    withErrorHandling(async ({ endpointSlug, requestId, limit }) => {
      if ((requestId === undefined) === (endpointSlug === undefined)) {
        throw new Error("Pass exactly one of endpointSlug or requestId");
      }
      return jsonContent(
        requestId
          ? await client.forwarding.emailDeliveries(requestId)
          : await client.forwarding.deliveries(endpointSlug!, { limit })
      );
    })
  );

  server.tool(
    "redeliver_email",
    "Forward a captured email again with the endpoint's current URL and secret. Owner only; fails while forwarding is off.",
    { requestId: z.string().describe("The email's request ID") },
    withErrorHandling(async ({ requestId }) => {
      return jsonContent(await client.forwarding.redeliver(requestId));
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

  registerAgentRegistrationTools(server);
}

/**
 * Resolve the webhooks.cc app base URL the SAME way the client/server does, so
 * the unauthenticated registration tools hit the right deployment. The
 * registration on-ramp is unauthenticated by design (an agent uses it BEFORE it
 * has a key), so these tools never touch the authenticated client.
 */
function resolveBaseUrl(): string {
  return process.env.WHK_BASE_URL ?? "https://webhooks.cc";
}

/**
 * Agent self-registration tools (auth.md). These are UNAUTHENTICATED — they let
 * an agent that does NOT yet have a webhooks.cc credential obtain one, then
 * configure the MCP server with the returned key (WHK_API_KEY). Registered on
 * every server so a probing agent can always discover the on-ramp via
 * `describe` / `how_to_register`.
 */
export function registerAgentRegistrationTools(server: McpServer): void {
  const baseUrl = resolveBaseUrl();

  server.tool(
    "how_to_register",
    "Explain how an agent self-registers for a webhooks.cc API credential (auth.md). Call this FIRST when you have no API key. Returns the three registration flows and the auth.md documentation URL. No authentication required.",
    {},
    withErrorHandling(async () => {
      return jsonContent({
        ...WebhooksCC.describeRegistration(baseUrl),
        next_steps: [
          "Easiest: call register_agent (anonymous) to get a key immediately, then ask a human to open the returned claimUrl while signed in to webhooks.cc and enter the userCode. Poll check_claim until it says claimed.",
          "Or set WHK_API_KEY to an existing whcc_ key and use the authenticated tools.",
        ],
      });
    })
  );

  server.tool(
    "register_agent",
    "Self-register for a webhooks.cc API credential via the anonymous auth.md flow. Returns a whcc_ API key, plus a short userCode and claimUrl a human uses to bind the key to their account. Until a human claims it, the key only works with the sandbox API (/api/agent/sandbox/endpoints), not with these tools, and it is deleted about 15 minutes after registration. No authentication required.",
    {
      clientName: z
        .string()
        .optional()
        .describe("A human-readable name for this agent, recorded on the issued key"),
    },
    withErrorHandling(async ({ clientName }) => {
      const reg = await WebhooksCC.register.anonymous({ baseUrl, clientName });
      return jsonContent({
        credential: reg.credential,
        scopes: reg.scopes,
        claim: {
          userCode: reg.userCode,
          claimUrl: reg.claimUrl,
          claimToken: reg.claimToken,
          expiresAt: reg.claimTokenExpires,
          instructions: `Ask a human to open ${reg.claimUrl} while logged in to webhooks.cc and either enter the code ${reg.userCode} or open ${reg.claimUrl}?token=${reg.claimToken}. Then call check_claim with the claimToken.`,
        },
        usage:
          "Until a human claims it, the key only works with the sandbox API at /api/agent/sandbox/endpoints (create temporary endpoints, read their requests), and it is deleted about 15 minutes after registration. Once check_claim says claimed, set WHK_API_KEY to `credential` and restart the MCP server to use the authenticated tools.",
      });
    })
  );

  server.tool(
    "check_claim",
    "Check whether an anonymous registration's API key has been claimed by a human yet. Poll this after register_agent until status is 'claimed'. No authentication required.",
    {
      claimToken: z.string().describe("The claimToken returned by register_agent"),
    },
    withErrorHandling(async ({ claimToken }) => {
      const poll = await WebhooksCC.register.pollClaim(claimToken, { baseUrl });
      return jsonContent(poll);
    })
  );

  server.tool(
    "register_agent_with_email",
    "Self-register via the verified_email auth.md flow: webhooks.cc emails a one-time code to the address. The credential is WITHHELD until the code is confirmed with verify_agent_otp. Returns a claimToken to pass to verify_agent_otp. No authentication required.",
    {
      email: z
        .string()
        .email({ message: "Invalid email address" })
        .describe("The email address to verify and bind the credential to"),
      clientName: z
        .string()
        .optional()
        .describe("A human-readable name for this agent, recorded on the issued key"),
    },
    withErrorHandling(async ({ email, clientName }) => {
      const challenge = await WebhooksCC.register.withEmail(email, { baseUrl, clientName });
      return jsonContent({
        claimToken: challenge.claimToken,
        expiresAt: challenge.claimTokenExpires,
        postClaimScopes: challenge.postClaimScopes,
        next_step: `A one-time code was emailed to ${email}. Ask the human for it, then call verify_agent_otp with this claimToken and the code.`,
      });
    })
  );

  server.tool(
    "verify_agent_otp",
    "Complete the verified_email flow: submit the emailed OTP with the claimToken from register_agent_with_email. On success returns the whcc_ API key (bound to the verified email). Set WHK_API_KEY to it. No authentication required.",
    {
      claimToken: z.string().describe("The claimToken returned by register_agent_with_email"),
      otp: z.string().describe("The one-time code the human received by email"),
    },
    withErrorHandling(async ({ claimToken, otp }) => {
      const issued = await WebhooksCC.register.confirmEmailOtp({ claimToken, otp }, { baseUrl });
      return jsonContent({
        credential: issued.credential,
        scopes: issued.scopes,
        usage: "Set WHK_API_KEY to `credential` to use the authenticated tools.",
      });
    })
  );

  server.tool(
    "register_agent_with_idjag",
    "Self-register via the identity_assertion (ID-JAG) auth.md flow: present a verified identity-assertion JWT (urn:ietf:params:oauth:token-type:id-jag) from a trusted provider. The credential is returned synchronously — no human claim step. No webhooks.cc authentication required, but only works if webhooks.cc trusts your provider.",
    {
      assertion: z
        .string()
        .describe("The ID-JAG assertion JWT (typ oauth-id-jag+jwt) from a trusted provider"),
    },
    withErrorHandling(async ({ assertion }) => {
      const issued = await WebhooksCC.register.withIdJag(assertion, { baseUrl });
      return jsonContent({
        credential: issued.credential,
        scopes: issued.scopes,
        usage: "Set WHK_API_KEY to `credential` to use the authenticated tools.",
      });
    })
  );
}
