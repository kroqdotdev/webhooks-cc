import { createAdminClient } from "@/lib/supabase/admin";

const MAX_LIMIT = 100;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10) || 25),
    MAX_LIMIT
  );

  const admin = createAdminClient();

  // Verify the endpoint exists and is ephemeral before returning requests
  const { data: endpoint, error: epError } = await admin
    .from("endpoints")
    .select("id")
    .eq("slug", slug)
    .eq("is_ephemeral", true)
    .maybeSingle();

  if (epError) {
    console.error("Failed to verify guest endpoint:", epError);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!endpoint) {
    return Response.json({ error: "Endpoint not found" }, { status: 404 });
  }

  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, query_params, content_type, ip, size, received_at"
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
