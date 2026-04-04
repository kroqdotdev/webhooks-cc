import { createAdminClient } from "@/lib/supabase/admin";
import { getGuestEndpointBySlug } from "@/lib/supabase/endpoints";

const MAX_LIMIT = 100;

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10) || 25),
    MAX_LIMIT
  );

  let endpoint;
  try {
    endpoint = await getGuestEndpointBySlug(slug);
  } catch (error) {
    console.error("Failed to verify guest endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!endpoint) {
    return Response.json({ error: "Endpoint not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at"
    )
    .eq("endpoint_id", endpoint.id)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Failed to fetch guest requests:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }

  return Response.json(data ?? []);
}
