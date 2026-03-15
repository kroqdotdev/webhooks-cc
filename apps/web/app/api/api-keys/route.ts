import { authenticateSessionRequest, type AuthResult } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateApiKey, hashApiKey, MAX_KEYS_PER_USER } from "@/lib/supabase/api-keys";

const DEFAULT_TTL_DAYS = 365;

export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("id, name, key_prefix, created_at, expires_at, last_used_at")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to list API keys:", error);
    return Response.json({ error: "Failed to list API keys" }, { status: 500 });
  }

  return Response.json(data ?? []);
}

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { count, error: countError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId);

  if (countError) {
    console.error("Failed to count API keys:", countError);
    return Response.json({ error: "Failed to create API key" }, { status: 500 });
  }

  if ((count ?? 0) >= MAX_KEYS_PER_USER) {
    return Response.json(
      { error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed` },
      { status: 409 }
    );
  }

  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 10);
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();

  const { error: insertError } = await admin.from("api_keys").insert({
    user_id: auth.userId,
    name,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    expires_at: expiresAt,
  });

  if (insertError) {
    console.error("Failed to insert API key:", insertError);
    return Response.json({ error: "Failed to create API key" }, { status: 500 });
  }

  return Response.json({ key: rawKey, name, keyPrefix, expiresAt });
}

export async function DELETE(request: Request) {
  const auth: AuthResult = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const url = new URL(request.url);
  const keyId = url.searchParams.get("id");
  if (!keyId) {
    return Response.json({ error: "Missing key id" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("api_keys")
    .delete()
    .eq("id", keyId)
    .eq("user_id", auth.userId);

  if (error) {
    console.error("Failed to delete API key:", error);
    return Response.json({ error: "Failed to delete API key" }, { status: 500 });
  }

  return Response.json({ success: true });
}
