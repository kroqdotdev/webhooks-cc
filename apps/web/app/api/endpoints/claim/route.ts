import { NextResponse } from "next/server";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { claimGuestEndpoint } from "@/lib/supabase/endpoints";

/**
 * POST /api/endpoints/claim
 * Claim an ephemeral guest endpoint for the authenticated user.
 * Body: { slug: string }
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  let body: { slug?: string };
  try {
    body = (await request.json()) as { slug?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.slug || typeof body.slug !== "string") {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  const endpoint = await claimGuestEndpoint(auth.userId, body.slug);
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found or already claimed" }, { status: 404 });
  }

  return NextResponse.json(endpoint);
}
