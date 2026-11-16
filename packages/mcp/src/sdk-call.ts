import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { ToolCall, ToolResult } from "./tools";

/** The key an approval's URL request goes under. */
const APPROVAL_INPUT = "approval";

/**
 * What our tools need to know about a call, read from the SDK's context:
 * whether the client can open a URL for the person (declared per request on
 * the 2026-07-28 revision, at initialize on a 2025-era connection), and what
 * a retried call carries back.
 */
export function toolCallFrom(server: McpServer, ctx: ServerContext | undefined): ToolCall {
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities =
    (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
    server.server.getClientCapabilities();
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  const state = ctx ? ctx.mcpReq.requestState<string>() : undefined;
  const answer = ctx ? inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT) : undefined;
  return {
    urlElicitation: Boolean(elicitation && typeof elicitation.url === "object"),
    requestState: typeof state === "string" ? state : undefined,
    urlAnswer: answer?.kind === "elicit" ? answer.action : undefined,
  };
}

/**
 * A tool's answer for the SDK: a pending approval becomes a URL request
 * the client opens for the person (the call comes back to finish it), and
 * the field never reaches the wire.
 */
export function sdkToolResult(result: ToolResult): CallToolResult | InputRequiredResult {
  const { approval, checkout, ...plain } = result;
  if (checkout && !approval) {
    return inputRequired({
      inputRequests: {
        [APPROVAL_INPUT]: inputRequired.elicitUrl({
          message: `${checkout.summary} Open it signed in to webhooks.cc as the account's owner; it goes on to Polar's checkout, and nothing is charged until you pay there with your card.`,
          url: checkout.url,
        }),
      },
      // The link's id: on its own it reaches nothing, since only the
      // person who asked for it may read it (GET /api/billing/checkouts/{id}).
      requestState: checkout.id,
    });
  }
  if (!approval) return plain;
  return inputRequired({
    inputRequests: {
      [APPROVAL_INPUT]: inputRequired.elicitUrl({
        message: `${approval.summary} The page shows the code ${approval.code}: approve only if it matches.`,
        url: approval.url,
      }),
    },
    // The approval's id: on its own it reaches nothing, since only the key
    // or agent that asked may read the approval (GET /api/approvals/{id}).
    requestState: approval.id,
  });
}

/**
 * A tool's input schema as it is listed: the JSON Schema without its
 * `$schema` URI. MCP reads an inputSchema without one as JSON Schema
 * 2020-12, which is what zod writes, so the URI only made every tool of
 * every list about 50 characters longer. Validation is the schema's own.
 */
export function listedInputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  const strip =
    (
      convert: (options: Parameters<typeof standard.jsonSchema.input>[0]) => Record<string, unknown>
    ) =>
    (options: Parameters<typeof standard.jsonSchema.input>[0]) => {
      const listed = { ...convert(options) };
      delete listed.$schema;
      return listed;
    };
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: strip(standard.jsonSchema.input),
        output: strip(standard.jsonSchema.output),
      },
    },
  };
}

/**
 * The two names the tools give an endpoint's slug: `slug` (the endpoint and
 * send tools) and `endpointSlug` (the tools about its requests, emails and
 * deliveries). Each tool keeps listing the name it always had, so clients
 * and prompts written against it keep working, and takes the other name as
 * well, so a call that guessed the other one is not refused.
 */
const SLUG_NAMES = ["slug", "endpointSlug"] as const;

/** `value` with an endpoint's slug under the name the tool lists, when it came under the other. */
function slugUnderListedName(
  value: unknown,
  keys: readonly string[]
): { value: unknown } | { issue: string; path: string } {
  const listed = SLUG_NAMES.filter((name) => keys.includes(name));
  if (listed.length !== 1 || typeof value !== "object" || value === null || Array.isArray(value)) {
    return { value };
  }
  const own = listed[0];
  const other = own === "slug" ? "endpointSlug" : "slug";
  const input = value as Record<string, unknown>;
  // A client that fills unlisted fields with null or "" has not named a
  // second endpoint: drop it, as the schema used to.
  if (input[other] === undefined || input[other] === null || input[other] === "") {
    if (input[other] === undefined) return { value };
    const rest = { ...input };
    delete rest[other];
    return { value: rest };
  }
  if (input[own] !== undefined && input[own] !== input[other]) {
    return {
      issue: `${own} and ${other} name different endpoints; pass only ${own}.`,
      path: other,
    };
  }
  const renamed = { ...input, [own]: input[other] };
  delete renamed[other];
  return { value: renamed };
}

/**
 * A tool's input schema as the adapters register it: listed as JSON Schema
 * without `$schema` (listedInputSchema), and taking an endpoint's slug under
 * either name (SLUG_NAMES).
 */
export function toolInputSchema(
  schema: StandardSchemaWithJSON,
  keys: readonly string[]
): StandardSchemaWithJSON {
  const listed = listedInputSchema(schema);
  if (!SLUG_NAMES.some((name) => keys.includes(name))) return listed;
  const standard = listed["~standard"];
  return {
    "~standard": {
      ...standard,
      validate(value) {
        const renamed = slugUnderListedName(value, keys);
        if ("issue" in renamed) {
          return { issues: [{ message: renamed.issue, path: [renamed.path] }] };
        }
        return standard.validate(renamed.value);
      },
    },
  };
}
