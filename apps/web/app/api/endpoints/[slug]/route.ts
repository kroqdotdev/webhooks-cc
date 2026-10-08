import { auditUserAction } from "@/lib/audit";
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
import { allowPrivateTargets } from "@/lib/forwarding/config";
import { checkForwardUrl } from "@/lib/forwarding/target";
import { getWebProviderCredentialLabel } from "@/lib/provider-catalog";

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

    // Strip notification and forwarding URLs for non-owners: they can be bearer secrets
    if (access.ownerId !== auth.userId) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { notificationUrl, forwardUrl, ...safe } = endpoint;
      return Response.json(safe);
    }

    return Response.json(endpoint);
  } catch (error) {
    console.error("Failed to fetch endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

const AUDITED_ENDPOINT_FIELDS = [
  "name",
  "mockResponse",
  "responseRules",
  "notificationUrl",
  "signingProvider",
  "signingSecret",
  "signingHeader",
  "showEmailExtracts",
  "forwardEnabled",
  "forwardUrl",
] as const;

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

  if (body.showEmailExtracts !== undefined && typeof body.showEmailExtracts !== "boolean") {
    return Response.json({ error: "Invalid showEmailExtracts" }, { status: 400 });
  }

  if (body.forwardEnabled !== undefined && typeof body.forwardEnabled !== "boolean") {
    return Response.json({ error: "Invalid forwardEnabled" }, { status: 400 });
  }
  if (body.forwardUrl !== undefined && body.forwardUrl !== null && body.forwardUrl !== "") {
    if (typeof body.forwardUrl !== "string" || body.forwardUrl.length > 2048) {
      return Response.json({ error: "Invalid forwardUrl" }, { status: 400 });
    }
    const forwardCheck = checkForwardUrl(body.forwardUrl, { allowPrivate: allowPrivateTargets() });
    if (!forwardCheck.ok) {
      return Response.json({ error: forwardCheck.reason }, { status: 400 });
    }
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

  // Field names only: values can include signing secrets and notification URLs.
  const updatedFields = AUDITED_ENDPOINT_FIELDS.filter((field) => body[field] !== undefined);

  try {
    // Team members can rename the endpoint and change its responses
    const access = await resolveEndpointAccess(auth.userId, slug);
    if (!access) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    const signingConfigTouched =
      body.signingProvider !== undefined ||
      body.signingSecret !== undefined ||
      body.signingHeader !== undefined;
    const forwardingTouched = body.forwardEnabled !== undefined || body.forwardUrl !== undefined;
    // showEmailExtracts also decides whether codes and links are in the JSON
    // forwarded to the owner's server, so a team member must not change it.
    const ownerOnlyConfigTouched =
      body.notificationUrl !== undefined ||
      body.showEmailExtracts !== undefined ||
      signingConfigTouched ||
      forwardingTouched;

    if (!access.isOwner && ownerOnlyConfigTouched) {
      return Response.json(
        {
          error:
            "Only the endpoint owner can update email, notification, forwarding or signing settings",
        },
        { status: 403 }
      );
    }

    if (forwardingTouched) {
      const current = await getEndpointBySlugForUser(access.ownerId, slug);
      if (!current) {
        return Response.json({ error: "Endpoint not found" }, { status: 404 });
      }
      const nextEnabled = (body.forwardEnabled as boolean | undefined) ?? current.forwardEnabled;
      const nextUrl =
        body.forwardUrl === undefined
          ? current.forwardUrl
          : (body.forwardUrl as string | null) || null;
      if (nextEnabled && !nextUrl) {
        return Response.json({ error: "Add a URL before turning forwarding on." }, { status: 400 });
      }
      if ((nextEnabled || nextUrl) && !current.hasForwardSecret) {
        const { isSigningKeyConfigured } = await import("@/lib/crypto");
        if (!isSigningKeyConfigured()) {
          return Response.json(
            { error: "Forwarding is not available. Contact support." },
            { status: 503 }
          );
        }
      }
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
        const secretLabel = getWebProviderCredentialLabel(nextProvider).toLowerCase();
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
      showEmailExtracts: body.showEmailExtracts as boolean | undefined,
      forwardEnabled: body.forwardEnabled as boolean | undefined,
      forwardUrl:
        body.forwardUrl === undefined ? undefined : (body.forwardUrl as string | null) || null,
    });

    await auditUserAction(request, auth.userId, {
      action: "endpoint.updated",
      status: endpoint ? 200 : 404,
      targetId: slug,
      targetUserId: access.isOwner ? null : access.ownerId,
      metadata: { fields: updatedFields },
    });

    if (!endpoint) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return Response.json(endpoint);
  } catch (error) {
    console.error("Failed to update endpoint:", error);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.updated",
      status: 500,
      targetId: slug,
      metadata: { fields: updatedFields },
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  try {
    const deleted = await deleteEndpointBySlugForUser(auth.userId, slug);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.deleted",
      status: deleted ? 204 : 404,
      targetId: slug,
    });
    if (!deleted) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete endpoint:", error);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.deleted",
      status: 500,
      targetId: slug,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
