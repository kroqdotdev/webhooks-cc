import { getGuestEndpointBySlug } from "@/lib/supabase/endpoints";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let data;
  try {
    data = await getGuestEndpointBySlug(slug);
  } catch (error) {
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
