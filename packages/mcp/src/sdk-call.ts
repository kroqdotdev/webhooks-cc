import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
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
  const { approval, ...plain } = result;
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
