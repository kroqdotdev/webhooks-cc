import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import {
  AssistInputError,
  MAX_SAMPLES,
  prepareAssist,
  runAssist,
  type AssistAsk,
} from "@/lib/ai/assist";
import { aiOffered, AssistModelError, FIELD_SOURCES } from "@/lib/ai/model";
import type { EmailField } from "@webhooks-cc/sdk/email";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestByIdForUser } from "@/lib/supabase/requests";
import { isUuid } from "@/lib/uuid";

/**
 * AI setup and repair (lib/ai/assist.ts) for an endpoint's layouts and
 * fields. GET: whether it is offered and how many assists are left this
 * 30 days. POST { ask, requestIds, consent: true }: sends the picked emails
 * (1 to 5 of the endpoint's own) to the model, with the person's consent
 * each time, and answers only proposals that compile and find a value in
 * every sample; nothing is saved. A session only: consent is a person's.
 * The owner only, like the layouts themselves.
 */

type Params = { params: Promise<{ slug: string }> };

async function left(endpointId: string): Promise<{ allowed: number; used: number }> {
  const { data, error } = await createAdminClient().rpc("ai_assists_left", {
    p_endpoint_id: endpointId,
  });
  if (error) throw error;
  const result = (data ?? {}) as { allowed?: number; used?: number };
  return { allowed: result.allowed ?? 0, used: result.used ?? 0 };
}

export async function GET(request: Request, { params }: Params) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return Response.json({ error: "Endpoint not found" }, { status: 404 });
    return Response.json({ offered: aiOffered(), ...(await left(endpoint.id)) });
  } catch (error) {
    reportError("Reading AI assists failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

function parseAsk(value: unknown): AssistAsk | string {
  if (!value || typeof value !== "object") return "ask is { kind, ... }.";
  const ask = value as Record<string, unknown>;
  if (ask.kind === "field") {
    if (typeof ask.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(ask.name)) {
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
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(field.name)) {
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

export async function POST(request: Request, { params }: Params) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  const limited = await checkRateLimitByKeyWithInfo(`user:ai-assist:${auth.userId}`, 10);
  if (limited.response) return limited.response;
  if (!aiOffered()) {
    return Response.json({ error: "AI setup is not available on this server." }, { status: 404 });
  }

  const body = await jsonObject(request, 8 * 1024);
  if (body instanceof Response) return body;
  if (body.consent !== true) {
    return Response.json(
      { error: "Agree to send the emails to the AI service first (consent: true)." },
      { status: 400 }
    );
  }
  const ask = parseAsk(body.ask);
  if (typeof ask === "string") return Response.json({ error: ask }, { status: 400 });
  const ids = body.requestIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_SAMPLES ||
    !ids.every((id) => typeof id === "string" && isUuid(id)) ||
    new Set(ids).size !== ids.length
  ) {
    return Response.json(
      { error: `requestIds names 1 to ${MAX_SAMPLES} of the endpoint's emails.` },
      { status: 400 }
    );
  }

  let useId: string | null = null;
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return Response.json({ error: "Endpoint not found" }, { status: 404 });
    // Only this endpoint's own emails, every one of them, and only those
    // still within retention (the reader the request routes use).
    const samples = await Promise.all(
      (ids as string[]).map(async (id) => {
        const item = await getRequestByIdForUser(auth.userId, id);
        return item && item.endpointId === endpoint.id && item.kind === "email" ? item : undefined;
      })
    );
    if (samples.some((sample) => !sample?.email)) {
      return Response.json(
        { error: "Pick emails this endpoint captured (and still keeps)." },
        { status: 400 }
      );
    }
    const requests = samples as NonNullable<(typeof samples)[number]>[];
    let prepared;
    try {
      prepared = prepareAssist(ask, requests);
    } catch (error) {
      if (error instanceof AssistInputError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const admin = createAdminClient();
    const finish = async (id: string, outcome: "proposed" | "none" | "error" | "failed") => {
      const { error } = await admin.rpc("finish_ai_assist", { p_id: id, p_outcome: outcome });
      if (error) throw error;
    };
    const { data: taken, error: takeError } = await admin.rpc("take_ai_assist", {
      p_endpoint_id: endpoint.id,
      p_actor_id: auth.userId,
      p_kind: ask.kind,
    });
    if (takeError) throw takeError;
    const take = (taken ?? {}) as { status?: string; id?: string; allowed?: number; used?: number };
    if (take.status !== "ok" || !take.id) {
      return Response.json(
        {
          error:
            take.status === "none_left"
              ? `No AI assists left: your plan has ${take.allowed} in 30 days.`
              : take.status === "busy"
                ? "Another AI ask of yours is still running. Try again when it is done."
                : "Endpoint not found",
          code: take.status,
        },
        { status: take.status === "none_left" ? 429 : take.status === "busy" ? 409 : 404 }
      );
    }
    useId = take.id;

    let result;
    try {
      result = await runAssist(ask, requests, prepared);
    } catch (error) {
      // Given back when it cost nothing; kept when the model may have run.
      const billed = error instanceof AssistModelError && error.billed;
      await finish(useId, billed ? "error" : "failed");
      useId = null;
      if (error instanceof AssistModelError) {
        return Response.json({ error: error.message }, { status: error.temporary ? 503 : 422 });
      }
      throw error;
    }
    await finish(useId, result.fields.length > 0 ? "proposed" : "none");
    useId = null;
    await auditUserAction(request, auth.userId, {
      action: "endpoint.ai_assist",
      status: 200,
      targetId: slug,
      // What was asked and how it went; never the emails or the patterns.
      metadata: {
        kind: ask.kind,
        samples: samples.length,
        proposed: result.fields.length,
        dropped: result.dropped,
      },
    });
    return Response.json({ ...result, ...(await left(endpoint.id)) });
  } catch (error) {
    // Only an ask that never finished (finish_ai_assist leaves finished ones be).
    if (useId) {
      await createAdminClient()
        .rpc("finish_ai_assist", { p_id: useId, p_outcome: "failed" })
        .then(undefined, () => undefined);
    }
    reportError("An AI assist failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
