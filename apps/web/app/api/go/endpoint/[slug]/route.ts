import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, slug, is_ephemeral, expires_at, request_count")
    .eq("slug", slug.toLowerCase())
    .eq("is_ephemeral", true)
    .maybeSingle();

  if (error) {
    console.error("Failed to fetch guest endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!data) {
    return Response.json(null, { status: 404 });
  }

  return Response.json({
    id: data.id,
    slug: data.slug,
    isEphemeral: data.is_ephemeral || undefined,
    expiresAt: data.expires_at ? Date.parse(data.expires_at) : undefined,
    requestCount: data.request_count,
  });
}
