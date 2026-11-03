import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Refunds held for a person (polar_refunds, from the automatic refunds
 * work). With POLAR_AUTO_REFUNDS off every refund waits here; staff approve
 * one (the refund worker then refunds exactly the orders it prepared) or
 * dismiss it. A database without that table answers installed: false and
 * the page says so; nothing else depends on it.
 */

export interface HeldRefund {
  id: string;
  status: string;
  reason: string;
  holdReason: string | null;
  plannedCents: number | null;
  refundedCents: number;
  orders: {
    orderId: string;
    netCents: number | null;
    createdAt: string | null;
    billingReason: string | null;
  }[];
  account: { kind: "user" | "team"; id: string; label: string } | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface RefundRow {
  id: string;
  status: string;
  reason: string;
  hold_reason: string | null;
  planned_cents: number | null;
  refunded_cents: number;
  orders: unknown;
  user_id: string | null;
  team_id: string | null;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

// The table is not in the generated types on every branch.
function untyped(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

function missingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.code === "PGRST202" ||
    /polar_refunds/.test(error.message ?? "")
  );
}

function orderList(value: unknown): HeldRefund["orders"] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const order = (entry ?? {}) as Record<string, unknown>;
    return {
      orderId: String(order.order_id ?? ""),
      netCents: typeof order.net === "number" ? order.net : null,
      createdAt: typeof order.created_at === "string" ? order.created_at : null,
      billingReason: typeof order.billing_reason === "string" ? order.billing_reason : null,
    };
  });
}

export async function listRefunds(
  view: "held" | "recent"
): Promise<{ installed: boolean; refunds: HeldRefund[] }> {
  let query = untyped()
    .from("polar_refunds")
    .select(
      "id, status, reason, hold_reason, planned_cents, refunded_cents, orders, user_id, team_id, last_error, created_at, finished_at"
    )
    .limit(100);
  query =
    view === "held"
      ? query.in("status", ["held", "failed"]).order("created_at", { ascending: true })
      : query.not("status", "in", "(held,failed)").order("updated_at", { ascending: false });
  const { data, error } = await query;
  if (error) {
    if (missingTable(error)) return { installed: false, refunds: [] };
    throw error;
  }
  const rows = (data ?? []) as RefundRow[];

  const admin = createAdminClient();
  const userIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => !!id))];
  const teamIds = [...new Set(rows.map((row) => row.team_id).filter((id): id is string => !!id))];
  const [users, teams] = await Promise.all([
    userIds.length ? admin.from("users").select("id, email").in("id", userIds) : { data: [] },
    teamIds.length ? admin.from("teams").select("id, name").in("id", teamIds) : { data: [] },
  ]);
  const userLabel = new Map((users.data ?? []).map((user) => [user.id, user.email]));
  const teamLabel = new Map((teams.data ?? []).map((team) => [team.id, team.name]));

  return {
    installed: true,
    refunds: rows.map((row) => ({
      id: row.id,
      status: row.status,
      reason: row.reason,
      holdReason: row.hold_reason,
      plannedCents: row.planned_cents,
      refundedCents: row.refunded_cents,
      orders: orderList(row.orders),
      account: row.user_id
        ? { kind: "user", id: row.user_id, label: userLabel.get(row.user_id) ?? "Deleted account" }
        : row.team_id
          ? { kind: "team", id: row.team_id, label: teamLabel.get(row.team_id) ?? "Deleted team" }
          : null,
      lastError: row.last_error,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    })),
  };
}

/** Approves or dismisses a held refund. False when it was no longer waiting. */
export async function decideRefund(id: string, decision: "approve" | "dismiss"): Promise<boolean> {
  const { data, error } = await untyped().rpc(
    decision === "approve" ? "approve_polar_refund" : "dismiss_polar_refund",
    { p_id: id }
  );
  if (error) throw error;
  return data === true;
}
