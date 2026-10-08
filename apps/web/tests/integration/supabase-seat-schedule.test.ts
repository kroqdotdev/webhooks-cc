import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { applyTeamPolarWebhookEvent } from "@/lib/supabase/team-billing";

// Subscription webhooks re-read the subscription from Polar to mirror its
// pending seat change; this stands in for Polar's current state.
const polarState = vi.hoisted(() => ({ pendingSeats: null as number | null }));
vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: () => ({
      subscriptions: {
        get: async (id: string) => ({
          id,
          pending_update:
            polarState.pendingSeats === null ? null : { seats: polarState.pendingSeats },
        }),
      },
    }),
  };
});

afterEach(() => {
  vi.useRealTimers();
  polarState.pendingSeats = null;
});

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const createdUserIds: string[] = [];
let teamId: string;
let ownerId: string;

async function createTestUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-seat-schedule-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user!.id);
  return data.user!.id;
}

async function inviteAndAccept(label: string): Promise<string> {
  const userId = await createTestUser(label);
  const { data: invite, error } = await admin
    .from("team_invites")
    .insert({
      team_id: teamId,
      invited_by: ownerId,
      invited_email: `test-seat-schedule-${label}-${ts}@webhooks-test.local`,
      invited_user_id: userId,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;

  const { data, error: rpcError } = await admin.rpc("accept_team_invite", {
    p_user_id: userId,
    p_invite_id: invite.id,
    p_seat_id: null,
  });
  if (rpcError) throw rpcError;
  return (data as { status: string }).status;
}

async function schedule(seats: number) {
  const { data, error } = await admin.rpc("schedule_team_seat_reduction", {
    p_team_id: teamId,
    p_seats: seats,
  });
  if (error) throw error;
  return data as { status: string; member_count?: number; previous_pending_seats?: number | null };
}

async function team() {
  const { data, error } = await admin
    .from("teams")
    .select("seats, pending_seats, request_limit")
    .eq("id", teamId)
    .single();
  if (error) throw error;
  return data as { seats: number; pending_seats: number | null; request_limit: number };
}

beforeAll(async () => {
  ownerId = await createTestUser("owner");
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: ownerId,
    p_name: `Seat Schedule ${ts}`,
  });
  if (error) throw error;
  teamId = (data as { id: string }).id;

  const { error: activateError } = await admin
    .from("teams")
    .update({
      subscription_status: "active",
      seats: 4,
      request_limit: 400_000,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      polar_subscription_id: `sub_seat_schedule_${ts}`,
    })
    .eq("id", teamId);
  if (activateError) throw activateError;
});

afterAll(async () => {
  if (teamId) await admin.from("teams").delete().eq("id", teamId);
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe("scheduled seat reductions", () => {
  it("records a reduction without touching the paid seats or pool", async () => {
    expect(await inviteAndAccept("member1")).toBe("accepted"); // 2 members

    await expect(schedule(2)).resolves.toMatchObject({
      status: "ok",
      previous_pending_seats: null,
    });
    expect(await team()).toEqual({ seats: 4, pending_seats: 2, request_limit: 400_000 });
  });

  it("caps invite accepts at the scheduled count while it is pending", async () => {
    expect(await inviteAndAccept("member2")).toBe("full");
  });

  it("refuses a reduction below the current members", async () => {
    await expect(schedule(1)).resolves.toMatchObject({ status: "below_members", member_count: 2 });
    expect((await team()).pending_seats).toBe(2);
  });

  it("refuses an increase and cancels on the current count", async () => {
    await expect(schedule(5)).resolves.toMatchObject({ status: "not_a_reduction" });
    await expect(schedule(4)).resolves.toMatchObject({ status: "ok", previous_pending_seats: 2 });
    expect((await team()).pending_seats).toBeNull();
    expect(await inviteAndAccept("member3")).toBe("accepted"); // 3 of 4 seats
  });

  it("an increase clears a pending reduction, as Polar does", async () => {
    await schedule(3);
    const { data, error } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: 5,
    });
    if (error) throw error;
    expect((data as { status: string }).status).toBe("ok");
    expect(await team()).toEqual({ seats: 5, pending_seats: null, request_limit: 500_000 });
  });

  it("mirrors Polar's current schedule and lets an older read lose", async () => {
    const subscriptionId = `sub_seat_schedule_${ts}`;
    // Polar keeps the subscription's modified_at when a pending update is
    // scheduled or cleared, so every event here carries the same one.
    const event = (pendingSeats: number | null) => ({
      id: subscriptionId,
      status: "active",
      seats: 5,
      modified_at: "2026-10-01T10:00:00.000000Z",
      pending_update: pendingSeats === null ? null : { seats: pendingSeats },
    });
    const readAt = (iso: string) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(iso));
    };

    polarState.pendingSeats = 3;
    readAt("2026-10-01T10:00:02.000Z");
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, event(3));
    expect((await team()).pending_seats).toBe(3);

    // A read that started earlier but finished later (Polar still showed the
    // reduction to 4) must not loosen the cap.
    polarState.pendingSeats = 4;
    readAt("2026-10-01T10:00:01.000Z");
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, event(4));
    expect((await team()).pending_seats).toBe(3);

    // The reduction was cancelled in Polar: the payload still shows the old
    // schedule and the same modified_at, but a newer read clears it.
    polarState.pendingSeats = null;
    readAt("2026-10-01T10:00:03.000Z");
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, event(3));
    expect((await team()).pending_seats).toBeNull();
  });
});
