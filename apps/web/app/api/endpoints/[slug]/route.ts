import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  parseJsonBody,
  validateNotificationUrl,
  validateMockResponseField,
  validateResponseRules,
} from "@/lib/request-validation";
import {
  deleteEndpointBySlugForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import { isValidSigningHeaderName, isValidSigningProvider } from "@/lib/signing-config";
import { resolveEndpointAccess } from "@/lib/supabase/teams";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  try {
    const access = await resolveEndpointAccess(auth.userId, slug);
    if (!access) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    const endpoint = await getEndpointBySlugForUser(access.ownerId, slug);
    if (!endpoint) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    // Strip notification URL for non-owners — it's a bearer secret (Slack/Discord)
    if (access.ownerId !== auth.userId) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { notificationUrl, ...safe } = endpoint;
      return Response.json(safe);
    }

    return Response.json(endpoint);
  } catch (error) {
    console.error("Failed to fetch endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  // Validate name type and length if provided
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 100)) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }

  const notifCheck = validateNotificationUrl(body.notificationUrl);
  if (!notifCheck.valid) return notifCheck.response;

  const mockCheck = validateMockResponseField(body.mockResponse, true);
  if (!mockCheck.valid) return mockCheck.response;

  const rulesCheck = validateResponseRules(body.responseRules);
  if (!rulesCheck.valid) return rulesCheck.response;

  // Validate signing config if provided
  if (body.signingProvider !== undefined && body.signingProvider !== null) {
    if (!isValidSigningProvider(body.signingProvider)) {
      return Response.json({ error: "Invalid signing provider" }, { status: 400 });
    }
  }
  // Validate signingHeader for generic-hmac — check both explicit provider and existing endpoint config
  const effectiveProvider = body.signingProvider ?? undefined;
  if (body.signingHeader !== undefined) {
    // We need to validate if the effective provider is generic-hmac
    // If body.signingProvider is set, use that; otherwise we'll validate after loading the endpoint
    if (effectiveProvider === "generic-hmac") {
      if (!isValidSigningHeaderName(body.signingHeader)) {
        return Response.json({ error: "Invalid signing header name" }, { status: 400 });
      }
    }
  }
  if (body.signingSecret !== undefined && body.signingSecret !== null) {
    if (typeof body.signingSecret !== "string" || body.signingSecret.length > 10000) {
      return Response.json({ error: "Invalid signing secret" }, { status: 400 });
    }
  }

  try {
    // Allow team members to edit (they can rename + change mock response)
    const access = await resolveEndpointAccess(auth.userId, slug);
    if (!access) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    const signingConfigTouched =
      body.signingProvider !== undefined ||
      body.signingSecret !== undefined ||
      body.signingHeader !== undefined;
    const ownerOnlyConfigTouched = body.notificationUrl !== undefined || signingConfigTouched;

    if (!access.isOwner && ownerOnlyConfigTouched) {
      return Response.json(
        { error: "Only the endpoint owner can update notification or signing settings" },
        { status: 403 }
      );
    }

    const existing = signingConfigTouched
      ? await getEndpointBySlugForUser(access.ownerId, slug)
      : null;

    if (signingConfigTouched && !existing) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    if (signingConfigTouched && existing) {
      const requestedProvider =
        body.signingProvider === undefined ? undefined : (body.signingProvider as string | null);
      const nextProvider =
        requestedProvider === undefined ? (existing.signingProvider ?? null) : requestedProvider;
      const providerChanged =
        requestedProvider !== undefined && requestedProvider !== (existing.signingProvider ?? null);
      const hasNewSecret = typeof body.signingSecret === "string" && body.signingSecret.length > 0;
      const hasStoredSecretForSelectedProvider = !providerChanged && !!existing.hasSigningSecret;

      if (nextProvider && body.signingSecret === null) {
        return Response.json(
          { error: "Cannot clear signing secret while signature verification is enabled" },
          { status: 400 }
        );
      }

      if (!nextProvider && hasNewSecret) {
        return Response.json(
          { error: "A signing provider is required before saving a signing secret" },
          { status: 400 }
        );
      }

      if (nextProvider && !hasNewSecret && !hasStoredSecretForSelectedProvider) {
        const secretLabel = nextProvider === "discord" ? "public key" : "signing secret";
        return Response.json(
          { error: `A ${secretLabel} is required for ${nextProvider}` },
          { status: 400 }
        );
      }

      if (nextProvider === "generic-hmac") {
        const nextHeader =
          body.signingHeader === undefined ? existing.signingHeader : body.signingHeader;
        if (!isValidSigningHeaderName(nextHeader)) {
          return Response.json({ error: "Invalid signing header name" }, { status: 400 });
        }
      }

      // Check encryption key only after access is confirmed so missing local/prod
      // config does not leak endpoint existence through a different status code.
      if (hasNewSecret) {
        const { isSigningKeyConfigured } = await import("@/lib/crypto");
        if (!isSigningKeyConfigured()) {
          return Response.json(
            { error: "Signature verification is not available. Contact support." },
            { status: 503 }
          );
        }
      }
    }

    // Validate signingHeader when existing endpoint uses generic-hmac and provider isn't being changed
    if (body.signingHeader !== undefined && effectiveProvider === undefined && existing) {
      if (existing?.signingProvider === "generic-hmac") {
        if (!isValidSigningHeaderName(body.signingHeader)) {
          return Response.json({ error: "Invalid signing header name" }, { status: 400 });
        }
      }
    }

    const endpoint = await updateEndpointBySlugForUser({
      userId: access.ownerId,
      slug,
      name: body.name as string | undefined,
      mockResponse:
        body.mockResponse === undefined
          ? undefined
          : (body.mockResponse as Record<string, unknown> | null),
      responseRules:
        body.responseRules === undefined ? undefined : (body.responseRules as unknown[] | null),
      notificationUrl:
        body.notificationUrl === undefined
          ? undefined
          : body.notificationUrl === null || body.notificationUrl === ""
            ? null
            : (body.notificationUrl as string),
      signingProvider:
        body.signingProvider === undefined ? undefined : (body.signingProvider as string | null),
      signingSecret:
        body.signingSecret === undefined ? undefined : (body.signingSecret as string | null),
      signingHeader:
        body.signingHeader === undefined ? undefined : (body.signingHeader as string | null),
    });

    if (!endpoint) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return Response.json(endpoint);
  } catch (error) {
    console.error("Failed to update endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  try {
    const deleted = await deleteEndpointBySlugForUser(auth.userId, slug);
    if (!deleted) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
