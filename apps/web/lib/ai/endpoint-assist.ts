import {
  AssistInputError,
  MAX_SAMPLES,
  prepareAssist,
  runAssist,
  type AssistAsk,
  type AssistResult,
} from "@/lib/ai/assist";
import { AssistModelError, FIELD_SOURCES } from "@/lib/ai/model";
import type { EmailField } from "@webhooks-cc/sdk/email";
import { ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestByIdForUser, type RequestRecord } from "@/lib/supabase/requests";
import { isUuid } from "@/lib/uuid";

/**
 * AI setup for one endpoint, shared by its route (a session, with consent on
 * the request) and the approval an agent asks for (lib/approvals: the
 * owner's approval is the consent). Checks the ask, reads the picked emails,
 * takes an assist from the billing account, runs the model and gives the
 * assist back when nothing was billed. Nothing is saved to the endpoint.
 */

/** A refusal the asker reads, with its HTTP status. */
export class AssistRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "AssistRefusal";
  }
}

export interface AssistInput {
  ask: AssistAsk;
  requestIds: string[];
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function parseAsk(value: unknown): AssistAsk | string {
  if (!value || typeof value !== "object") return "ask is { kind, ... }.";
  const ask = value as Record<string, unknown>;
  if (ask.kind === "field") {
    if (typeof ask.name !== "string" || !FIELD_NAME.test(ask.name)) {
      return "ask.name is a field name: letters, digits and _, starting with a letter.";
    }
    if (typeof ask.description !== "string" || !ask.description.trim()) {
      return "ask.description says what the field is.";
    }
    return { kind: "field", name: ask.name, description: ask.description.trim().slice(0, 500) };
  }
  if (ask.kind === "layout") {
    const description = typeof ask.description === "string" ? ask.description.trim() : "";
    return { kind: "layout", description: description.slice(0, 500) };
  }
  if (ask.kind === "repair") {
    const field = ask.field as Record<string, unknown> | null;
    if (
      !field ||
      typeof field.name !== "string" ||
      typeof field.from !== "string" ||
      !(FIELD_SOURCES as readonly string[]).includes(field.from) ||
      typeof field.pattern !== "string" ||
      field.pattern.length > 300
    ) {
      return "ask.field is the field to repair: { name, from, pattern }.";
    }
    if (!FIELD_NAME.test(field.name)) {
      return "ask.field.name is a field name.";
    }
    if (
      field.from === "header" &&
      (typeof field.header !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(field.header))
    ) {
      return "ask.field.header is the header the field reads.";
    }
    return {
      kind: "repair",
      field: {
        name: field.name,
        from: field.from as EmailField["from"],
        ...(typeof field.header === "string" ? { header: field.header } : {}),
        pattern: field.pattern,
      },
    };
  }
  return 'ask.kind is "field", "layout" or "repair".';
}

/** The ask and the picked emails from a request body, or what is wrong with them. */
export function parseAssistInput(body: Record<string, unknown>): AssistInput | string {
  const ask = parseAsk(body.ask);
  if (typeof ask === "string") return ask;
  const ids = body.requestIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_SAMPLES ||
    !ids.every((id) => typeof id === "string" && isUuid(id)) ||
    new Set(ids).size !== ids.length
  ) {
    return `requestIds names 1 to ${MAX_SAMPLES} of the endpoint's emails.`;
  }
  return { ask, requestIds: ids as string[] };
}

/** Assists in the rolling 30 days, and when the oldest counted one stops counting. */
export async function assistsLeft(
  endpointId: string
): Promise<{ allowed: number; used: number; nextAt: string | null }> {
  const { data, error } = await createAdminClient().rpc("ai_assists_left", {
    p_endpoint_id: endpointId,
  });
  if (error) throw error;
  const result = (data ?? {}) as { allowed?: number; used?: number; next_at?: string | null };
  const nextAt = typeof result.next_at === "string" ? new Date(result.next_at) : null;
  return {
    allowed: result.allowed ?? 0,
    used: result.used ?? 0,
    nextAt: nextAt && !Number.isNaN(nextAt.getTime()) ? nextAt.toISOString() : null,
  };
}

/**
 * The endpoint (its owner only) and the picked emails: this endpoint's own,
 * every one of them, and only those still within retention.
 */
export async function assistSamples(
  userId: string,
  slug: string,
  requestIds: string[]
): Promise<{ endpointId: string; requests: RequestRecord[] }> {
  const endpoint = await ownedEndpoint(userId, slug);
  if (!endpoint) throw new AssistRefusal(404, "Endpoint not found");
  const samples = await Promise.all(
    requestIds.map(async (id) => {
      const item = await getRequestByIdForUser(userId, id);
      return item && item.endpointId === endpoint.id && item.kind === "email" ? item : undefined;
    })
  );
  if (samples.some((sample) => !sample?.email)) {
    throw new AssistRefusal(400, "Pick emails this endpoint captured (and still keeps).");
  }
  return { endpointId: endpoint.id, requests: samples as RequestRecord[] };
}

export type EndpointAssistResult = AssistResult & { allowed: number; used: number };

/**
 * Runs AI setup: takes an assist, asks the model, and finishes the use row.
 * Throws AssistRefusal for what the asker should read; anything else is our
 * failure. The caller audits (it holds the request).
 */
export async function runEndpointAssist(
  userId: string,
  slug: string,
  input: AssistInput
): Promise<EndpointAssistResult> {
  const { endpointId, requests } = await assistSamples(userId, slug, input.requestIds);
  let prepared;
  try {
    prepared = prepareAssist(input.ask, requests);
  } catch (error) {
    if (error instanceof AssistInputError) throw new AssistRefusal(400, error.message);
    throw error;
  }

  const admin = createAdminClient();
  const finish = async (id: string, outcome: "proposed" | "none" | "error" | "failed") => {
    const { error } = await admin.rpc("finish_ai_assist", { p_id: id, p_outcome: outcome });
    if (error) throw error;
  };
  const { data: taken, error: takeError } = await admin.rpc("take_ai_assist", {
    p_endpoint_id: endpointId,
    p_actor_id: userId,
    p_kind: input.ask.kind,
  });
  if (takeError) throw takeError;
  const take = (taken ?? {}) as { status?: string; id?: string; allowed?: number; used?: number };
  if (take.status !== "ok" || !take.id) {
    throw new AssistRefusal(
      take.status === "none_left" ? 429 : take.status === "busy" ? 409 : 404,
      take.status === "none_left"
        ? `No AI assists left: your plan has ${take.allowed} in 30 days.`
        : take.status === "busy"
          ? "Another AI ask of yours is still running. Try again when it is done."
          : "Endpoint not found",
      take.status
    );
  }
  const useId = take.id;

  // Once the model was asked, a failure keeps the assist ("error"); before, it is given back.
  let asked = false;
  try {
    let result: AssistResult;
    try {
      asked = true;
      result = await runAssist(input.ask, requests, prepared);
    } catch (error) {
      // Given back when it cost nothing; kept when the model may have run.
      const billed = error instanceof AssistModelError && error.billed;
      asked = billed;
      await finish(useId, billed ? "error" : "failed");
      asked = false;
      if (error instanceof AssistModelError) {
        throw new AssistRefusal(error.temporary ? 503 : 422, error.message);
      }
      throw error;
    }
    await finish(useId, result.fields.length > 0 ? "proposed" : "none");
    // The counts the take answered (this ask included): a fresh read that
    // failed would lose a proposal the assist was spent on.
    return { ...result, allowed: take.allowed ?? 0, used: take.used ?? 0 };
  } catch (error) {
    // Only an ask that never finished (finish_ai_assist leaves finished ones be).
    if (!(error instanceof AssistRefusal)) {
      await admin
        .rpc("finish_ai_assist", { p_id: useId, p_outcome: asked ? "error" : "failed" })
        .then(undefined, () => undefined);
    }
    throw error;
  }
}
