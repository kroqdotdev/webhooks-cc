import { isSigningKeyConfigured } from "@/lib/crypto";
import { getEndpointBySlugForUser, type EndpointRecord } from "@/lib/supabase/endpoints";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/**
 * What every destination route starts with: only the endpoint's owner
 * manages where its captures go (the URLs and headers can be secrets).
 */
export async function ownedEndpoint(userId: string, slug: string): Promise<EndpointRecord | null> {
  const access = await resolveEndpointAccess(userId, slug);
  if (!access?.isOwner) return null;
  return getEndpointBySlugForUser(access.ownerId, slug);
}

/** Destinations sign with secrets encrypted by SIGNING_SECRET_KEY. */
export function forwardingUnavailable(): Response | null {
  return isSigningKeyConfigured()
    ? null
    : Response.json({ error: "Forwarding is not available. Contact support." }, { status: 503 });
}

/** The request body as an object, or a 400 to return. */
export async function jsonObject(
  request: Request,
  maxBytes = 128 * 1024
): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: "Send a JSON object." }, { status: 400 });
  }
  if (text.length > maxBytes) {
    return Response.json({ error: "Request body too large" }, { status: 413 });
  }
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the error below.
  }
  return Response.json({ error: "Send a JSON object." }, { status: 400 });
}
