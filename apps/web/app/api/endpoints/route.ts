import {
  authenticateRequest,
  extractBearerToken,
  validateBearerTokenWithPlan,
} from "@/lib/api-auth";
import {
  parseJsonBody,
  validateNotificationUrl,
  validateMockResponseField,
} from "@/lib/request-validation";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { createEndpointForUser, listEndpointsForUser } from "@/lib/supabase/endpoints";
import { getShareMetadataForOwnedEndpoints, getSharedEndpointsForUser } from "@/lib/supabase/teams";

const USER_ENDPOINT_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const USER_ENDPOINT_RATE_LIMIT_MAX = 30;

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    // Check plan — team features only for pro users
    const token = extractBearerToken(request);
    const validation = token ? await validateBearerTokenWithPlan(token) : null;
    const isPro = validation?.plan === "pro";

    const [endpoints, shareMetadata, sharedEndpoints] = await Promise.all([
      listEndpointsForUser(auth.userId),
      isPro ? getShareMetadataForOwnedEndpoints(auth.userId) : Promise.resolve(new Map()),
      isPro ? getSharedEndpointsForUser(auth.userId) : Promise.resolve([]),
    ]);

    const owned = endpoints.map((ep) => ({
      ...ep,
      sharedWith: shareMetadata.get(ep.id) ?? [],
    }));

    const shared = sharedEndpoints.map((ep) => ({
      id: ep.id,
      slug: ep.slug,
      name: ep.name ?? undefined,
      url: ep.url,
      mockResponse: ep.mockResponse ?? undefined,
      isEphemeral: ep.isEphemeral ?? undefined,
      createdAt: ep.createdAt,
      fromTeam: ep.fromTeam,
    }));

    return Response.json({ owned, shared });
  } catch (error) {
    console.error("Failed to list endpoints:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `endpoint-create:${auth.userId}`,
    USER_ENDPOINT_RATE_LIMIT_MAX,
    USER_ENDPOINT_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) {
    return rateLimit.response;
  }

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name !== undefined && (name.length === 0 || name.length > 100)) {
    return Response.json({ error: "Name must be between 1 and 100 characters" }, { status: 400 });
  }

  if (body.isEphemeral !== undefined && typeof body.isEphemeral !== "boolean") {
    return Response.json({ error: "isEphemeral must be a boolean" }, { status: 400 });
  }

  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
      ? body.expiresAt
      : undefined;
  if (body.expiresAt !== undefined && (expiresAt === undefined || expiresAt <= Date.now())) {
    return Response.json({ error: "expiresAt must be a future timestamp" }, { status: 400 });
  }

  const mockCheck = validateMockResponseField(body.mockResponse);
  if (!mockCheck.valid) return mockCheck.response;

  const notifCheck = validateNotificationUrl(body.notificationUrl);
  if (!notifCheck.valid) return notifCheck.response;

  const isEphemeral = body.isEphemeral === true || expiresAt !== undefined;

  try {
    const created = await createEndpointForUser({
      userId: auth.userId,
      name,
      isEphemeral,
      expiresAt,
      mockResponse:
        body.mockResponse === undefined
          ? undefined
          : (body.mockResponse as Record<string, unknown>),
      notificationUrl:
        typeof body.notificationUrl === "string" && body.notificationUrl.length > 0
          ? body.notificationUrl
          : undefined,
    });

    return applyRateLimitHeaders(Response.json(created), rateLimit);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Too many active demo endpoints")) {
      return applyRateLimitHeaders(
        Response.json({ error: error.message }, { status: 429 }),
        rateLimit
      );
    }

    console.error("Failed to create endpoint:", error);
    return applyRateLimitHeaders(
      Response.json({ error: "Internal server error" }, { status: 500 }),
      rateLimit
    );
  }
}
