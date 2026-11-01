import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { POST as templateRoute } from "@/app/api/endpoints/[slug]/layouts/template/route";

/**
 * Ready-made layouts added through POST /api/endpoints/{slug}/layouts/template
 * (append_endpoint_layout(), migration 00071): imports at the same moment each
 * land under their own id, and none writes over another.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

afterAll(async () => {
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function owner(): Promise<{ userId: string; apiKey: string }> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-layout-templates-${Date.now()}-${userIds.length}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  userIds.push(userId);
  const apiKey = `whcc_${randomBytes(24).toString("hex")}`;
  const { error: keyError } = await admin.from("api_keys").insert({
    user_id: userId,
    key_hash: createHash("sha256").update(apiKey).digest("hex"),
    key_prefix: apiKey.slice(0, 12),
    name: "Layout templates test",
  });
  if (keyError) throw keyError;
  return { userId, apiKey };
}

function importTemplate(slug: string, apiKey: string, template: string) {
  return templateRoute(
    new Request(`http://localhost/api/endpoints/${slug}/layouts/template`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ template }),
    }),
    { params: Promise.resolve({ slug }) }
  );
}

describe("layout templates", () => {
  it("keeps both of two imports made at the same moment", async () => {
    const { userId, apiKey } = await owner();
    const endpoint = await createEndpointForUser({ userId, name: "Imports" });
    const responses = await Promise.all([
      importTemplate(endpoint.slug, apiKey, "shopify-orders"),
      importTemplate(endpoint.slug, apiKey, "shopify-orders"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const ids = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { layoutId: string }).layoutId)
    );
    expect(new Set(ids)).toEqual(new Set(["shopify-orders", "shopify-orders-2"]));
    const { data } = await admin.from("endpoints").select("layouts").eq("id", endpoint.id).single();
    expect((data?.layouts as { id: string }[]).map((layout) => layout.id).sort()).toEqual([
      "shopify-orders",
      "shopify-orders-2",
    ]);
  });

  it("refuses an unknown template", async () => {
    const { userId, apiKey } = await owner();
    const endpoint = await createEndpointForUser({ userId, name: "Unknown" });
    expect((await importTemplate(endpoint.slug, apiKey, "nope")).status).toBe(400);
  });
});
