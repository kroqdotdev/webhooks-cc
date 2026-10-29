import { parseSheetsConfig } from "@/lib/integrations/sheets";
import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  parseDestinationInput,
  sheetsProblem,
  fileDropProblem,
  templateProblem,
} from "@/lib/forwarding/destination-input";
import {
  forwardingUnavailable,
  jsonObject,
  ownedEndpoint,
} from "@/lib/forwarding/destination-routes";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import {
  deleteDestination,
  DestinationHeaderValueMissingError,
  getDestination,
  updateDestination,
  getDestinationDropSecret,
} from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";
import type { Json } from "@/lib/supabase/database";

type Params = { params: Promise<{ slug: string; id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One destination: read it, change any of its fields, or remove it. Owner only. */
export async function GET(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug, id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Destination not found" }, { status: 404 });
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    const destination = endpoint ? await getDestination(endpoint.id, id) : null;
    if (!destination) return Response.json({ error: "Destination not found" }, { status: 404 });
    return Response.json(destination);
  } catch (error) {
    reportError("Failed to read a destination", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug, id } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "destinations", 60);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);
  if (!UUID.test(id)) return reply({ error: "Destination not found" }, 404);

  const body = await jsonObject(request);
  if (body instanceof Response) return applyRateLimitHeaders(body, rateLimit);
  const unavailable = forwardingUnavailable();
  if (unavailable) return applyRateLimitHeaders(unavailable, rateLimit);

  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    const current = endpoint ? await getDestination(endpoint.id, id) : null;
    if (!endpoint || !current) return reply({ error: "Destination not found" }, 404);
    const parsed = parseDestinationInput(body, {
      creating: false,
      current: {
        http: current.http,
        email: current.email,
        format: current.format,
        config: current.config,
      },
    });
    if (!parsed.ok) return reply({ error: parsed.error }, 400);
    // Changing the kinds changes which placeholders a stored Sheets config may
    // use (email fields only for emails): check it again against them.
    if (
      parsed.changes.config === undefined &&
      (parsed.changes.http !== undefined || parsed.changes.email !== undefined) &&
      (parsed.changes.format ?? current.format) === "sheets" &&
      current.config
    ) {
      const recheck = parseSheetsConfig(current.config, {
        http: parsed.changes.http ?? current.http,
        email: parsed.changes.email ?? current.email,
      });
      if (typeof recheck === "string") return reply({ error: recheck }, 400);
    }
    const problem = templateProblem({
      format: parsed.changes.format ?? current.format,
      bodyTemplate:
        parsed.changes.bodyTemplate !== undefined
          ? parsed.changes.bodyTemplate
          : current.bodyTemplate,
    });
    if (problem) return reply({ error: problem }, 400);
    const sheets = await sheetsProblem(auth.userId, {
      format: parsed.changes.format ?? current.format,
      config: parsed.changes.config !== undefined ? parsed.changes.config : current.config,
    });
    if (sheets) return reply({ error: sheets }, 400);
    const nextFormat = parsed.changes.format ?? current.format;
    if (nextFormat === "file_drop" && parsed.changes.config) {
      // Another server: the key pinned for the old one does not carry over.
      const before = current.config as { host?: unknown; port?: unknown } | null;
      const after = parsed.changes.config as { host?: unknown; port?: unknown; hostKey?: unknown };
      if (before && (before.host !== after.host || before.port !== after.port)) {
        parsed.changes.config = { ...(after as Record<string, Json>), hostKey: null };
      }
    }
    const drop = await fileDropProblem(endpoint.id, {
      format: nextFormat,
      config: parsed.changes.config !== undefined ? parsed.changes.config : current.config,
      secret:
        parsed.changes.dropSecret !== undefined
          ? parsed.changes.dropSecret
          : nextFormat === "file_drop"
            ? await getDestinationDropSecret(endpoint.id, id)
            : null,
    });
    if (drop) return reply({ error: drop }, 400);

    const destination = await updateDestination(endpoint.id, id, parsed.changes);
    if (!destination) return reply({ error: "Destination not found" }, 404);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.destination_updated",
      status: 200,
      targetId: slug,
      // Field names only: values can hold URLs and headers that are secrets.
      metadata: { destinationId: id, fields: Object.keys(parsed.changes) },
    });
    return reply(destination);
  } catch (error) {
    if (error instanceof DestinationHeaderValueMissingError) {
      return reply({ error: error.message }, 400);
    }
    reportError("Failed to change a destination", error);
    return reply({ error: "Internal server error" }, 500);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug, id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Destination not found" }, { status: 404 });
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    const removed = endpoint ? await deleteDestination(endpoint.id, id) : false;
    if (!removed) return Response.json({ error: "Destination not found" }, { status: 404 });
    await auditUserAction(request, auth.userId, {
      action: "endpoint.destination_deleted",
      status: 200,
      targetId: slug,
      metadata: { destinationId: id },
    });
    return Response.json({ deleted: true });
  } catch (error) {
    reportError("Failed to remove a destination", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
