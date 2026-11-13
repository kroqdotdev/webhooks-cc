import { auditUserAction } from "@/lib/audit";
import { NextResponse } from "next/server";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { claimGuestEndpoint } from "@/lib/supabase/endpoints";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const claimBody = z.object({ slug: z.unknown().optional() });

/**
 * POST /api/endpoints/claim
 * Claim an ephemeral guest endpoint for the authenticated user.
 * Body: { slug: string }
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const parsed = await parseJsonBodyWith(request, claimBody, { message: "Invalid JSON body" });
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;
  if (!body.slug || typeof body.slug !== "string") {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  const endpoint = await claimGuestEndpoint(auth.userId, body.slug);
  await auditUserAction(request, auth.userId, {
    action: "endpoint.claimed",
    status: endpoint ? 200 : 404,
    targetId: body.slug,
  });
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found or already claimed" }, { status: 404 });
  }

  return NextResponse.json(endpoint);
}
