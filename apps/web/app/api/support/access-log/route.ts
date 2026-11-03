import { authenticateSessionRequest } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { grantActive, grantEndsAt } from "@/lib/support/shared";

/**
 * Support access for the signed-in account: tickets that give access, and
 * every time staff looked, newest first.
 */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  try {
    const admin = createAdminClient();
    const [grants, log] = await Promise.all([
      admin
        .from("support_tickets")
        .select("id, number, subject, status, closed_at, access_granted, access_changed_at")
        .eq("user_id", auth.userId)
        .eq("access_granted", true)
        .order("access_changed_at", { ascending: false })
        .limit(50),
      admin
        .from("support_access_log")
        .select("id, ticket_id, action, target_id, created_at")
        .eq("user_id", auth.userId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (grants.error) throw grants.error;
    if (log.error) throw log.error;
    const numbers = new Map<string, number>();
    for (const ticket of grants.data ?? []) numbers.set(ticket.id, ticket.number);
    const missing = [
      ...new Set(
        (log.data ?? [])
          .map((row) => row.ticket_id)
          .filter((id): id is string => !!id && !numbers.has(id))
      ),
    ];
    if (missing.length > 0) {
      const { data } = await admin
        .from("support_tickets")
        .select("id, number")
        .in("id", missing)
        .eq("user_id", auth.userId);
      for (const ticket of data ?? []) numbers.set(ticket.id, ticket.number);
    }
    return Response.json(
      {
        grants: (grants.data ?? [])
          .filter((ticket) => grantActive(ticket))
          .map((ticket) => ({
            number: ticket.number,
            subject: ticket.subject,
            status: ticket.status,
            grantedAt: ticket.access_changed_at,
            endsAt: grantEndsAt(ticket.closed_at),
          })),
        log: (log.data ?? []).map((row) => ({
          id: row.id,
          action: row.action,
          ticketNumber: row.ticket_id ? (numbers.get(row.ticket_id) ?? null) : null,
          targetId: row.target_id,
          at: row.created_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    reportError("[support] reading the access log failed", error);
    return Response.json({ error: "Support access could not be loaded." }, { status: 500 });
  }
}
