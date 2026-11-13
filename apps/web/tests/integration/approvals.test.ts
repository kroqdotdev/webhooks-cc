import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  ApprovalError,
  createApproval,
  decideApproval,
  MAX_PENDING_APPROVALS,
  pollApproval,
  reviewApproval,
  withdrawApproval,
} from "@/lib/approvals/store";
import { generateApiKey, hashApiKey } from "@/lib/supabase/api-keys";
import { actionSpec } from "@/lib/approvals/actions";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const requester = {
  client: "whk 1.14.0 on linux",
  country: "DK",
  network: "203.0.113.0/24",
  remote: false,
};

let owner: string;
let other: string;
let keyId: string;
let otherKeyId: string;

async function makeUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-approvals-${label}-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

async function makeKey(userId: string, name: string): Promise<string> {
  const raw = generateApiKey();
  const { data, error } = await admin
    .from("api_keys")
    .insert({ user_id: userId, name, key_hash: hashApiKey(raw), key_prefix: raw.slice(0, 12) })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

function ask(userId = owner, key = keyId) {
  return createApproval({
    asker: { userId, keyId: key },
    action: "api_keys.create",
    params: { name: "CI", expiresInDays: 30 },
    requester,
  });
}

describe("approvals", () => {
  beforeAll(async () => {
    owner = await makeUser("owner");
    other = await makeUser("other");
    keyId = await makeKey(owner, "Laptop");
    otherKeyId = await makeKey(owner, "Second");
  });

  afterAll(async () => {
    for (const id of [owner, other]) if (id) await admin.auth.admin.deleteUser(id);
  });

  it("asks, shows the owner, and hands the new key to the asker once", async () => {
    const { approval, requester: label } = await ask();
    expect(approval.status).toBe("pending");
    expect(approval.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(approval.url).toContain(`/approve?code=${approval.code}`);
    expect(label).toContain('the API key "Laptop"');

    const review = await reviewApproval(approval.code.toLowerCase(), owner, "203.0.113.0/24");
    expect(review).toMatchObject({
      summary: approval.summary,
      requester: label,
      country: "DK",
      network: "same",
    });
    expect(review!.details.map((d) => d.label)).toContain("Works for");

    expect((await pollApproval(approval.id, { userId: owner, keyId }))?.approval.status).toBe(
      "pending"
    );
    await decideApproval(approval.code, owner, true);

    const collected = await pollApproval(approval.id, { userId: owner, keyId });
    expect(collected?.approval.status).toBe("completed");
    const key = collected?.result as { key: string; keyPrefix: string; expiresAt: string };
    expect(key.key.startsWith("whcc_")).toBe(true);
    const days = (new Date(key.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    // Only once, and the row never holds the key.
    const again = await pollApproval(approval.id, { userId: owner, keyId });
    expect(again?.approval.status).toBe("completed");
    expect(again?.result).toBeUndefined();
    const { data: row } = await admin
      .from("approvals")
      .select("result")
      .eq("id", approval.id)
      .single();
    expect(JSON.stringify(row?.result)).not.toContain(key.key);
    await admin.from("api_keys").delete().eq("key_prefix", key.keyPrefix);
  });

  it("answers only the key that asked, and only the account's own sessions", async () => {
    const { approval } = await ask();
    expect(await pollApproval(approval.id, { userId: owner, keyId: otherKeyId })).toBeNull();
    expect(await pollApproval(approval.id, { userId: other, keyId })).toBeNull();
    await expect(reviewApproval(approval.code, other, null)).rejects.toBeInstanceOf(ApprovalError);
    await expect(decideApproval(approval.code, other, true)).rejects.toMatchObject({ status: 403 });
    await decideApproval(approval.code, owner, false);
  });

  it("ends a refused approval, and an expired one", async () => {
    const refused = (await ask()).approval;
    await decideApproval(refused.code, owner, false);
    expect((await pollApproval(refused.id, { userId: owner, keyId }))?.approval.status).toBe(
      "denied"
    );
    await expect(decideApproval(refused.code, owner, true)).rejects.toMatchObject({ status: 400 });

    const late = (await ask()).approval;
    await admin
      .from("approvals")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", late.id);
    expect((await pollApproval(late.id, { userId: owner, keyId }))?.approval.status).toBe(
      "expired"
    );
    expect(await reviewApproval(late.code, owner, null)).toBeNull();
  });

  it("lets the owner withdraw an approval until it is collected", async () => {
    const first = (await ask()).approval;
    await decideApproval(first.code, owner, true);
    expect(await withdrawApproval(first.code, owner)).toMatchObject({ collected: false });
    expect((await pollApproval(first.id, { userId: owner, keyId }))?.approval.status).toBe(
      "denied"
    );

    const second = (await ask()).approval;
    await decideApproval(second.code, owner, true);
    const collected = await pollApproval(second.id, { userId: owner, keyId });
    expect(await withdrawApproval(second.code, owner)).toMatchObject({ collected: true });
    await expect(withdrawApproval(second.code, other)).rejects.toMatchObject({ status: 403 });
    const prefix = (collected?.result as { keyPrefix: string }).keyPrefix;
    await admin.from("api_keys").delete().eq("key_prefix", prefix);
  });

  it("undoes a collection the owner withdrew while it ran", async () => {
    const spec = actionSpec("api_keys.create");
    const run = spec.run.bind(spec);

    // Withdrawn while the key was being made: the key is deleted again.
    const first = (await ask()).approval;
    await decideApproval(first.code, owner, true);
    let made: string | undefined;
    const spy = vi.spyOn(spec, "run").mockImplementationOnce(async (userId, params) => {
      const out = await run(userId, params);
      made = (out.stored as { keyPrefix: string }).keyPrefix;
      expect(await withdrawApproval(first.code, owner)).toMatchObject({ collected: false });
      return out;
    });
    await expect(pollApproval(first.id, { userId: owner, keyId })).rejects.toMatchObject({
      status: 410,
    });
    const { count } = await admin
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("key_prefix", made!);
    expect(count).toBe(0);
    expect((await pollApproval(first.id, { userId: owner, keyId }))?.approval.status).toBe(
      "denied"
    );

    // Withdrawn while a collection failed: it does not come back.
    const second = (await ask()).approval;
    await decideApproval(second.code, owner, true);
    spy.mockImplementationOnce(async () => {
      await withdrawApproval(second.code, owner);
      throw new Error("key creation failed");
    });
    await expect(pollApproval(second.id, { userId: owner, keyId })).rejects.toThrow(
      "key creation failed"
    );
    expect((await pollApproval(second.id, { userId: owner, keyId }))?.approval.status).toBe(
      "denied"
    );
    spy.mockRestore();
  });

  it("caps the approvals an account may have waiting", async () => {
    await admin.from("approvals").delete().eq("user_id", owner);
    for (let i = 0; i < MAX_PENDING_APPROVALS; i++) await ask();
    await expect(ask()).rejects.toMatchObject({ status: 429 });
    await admin.from("approvals").delete().eq("user_id", owner);
  });
});
