import { beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
const from = vi.fn(() => ({ insert }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from }),
}));

const {
  auditAgentEvent,
  auditPolarEvent,
  auditUserAction,
  emailDomain,
  outcomeForStatus,
  polarAuditAction,
  requestVia,
} = await import("./audit");

function request(headers: Record<string, string>): Request {
  return new Request("https://webhooks.cc/api/teams", { method: "POST", headers });
}

describe("audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ error: null });
  });

  it("maps HTTP status to an outcome", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(204)).toBe("ok");
    expect(outcomeForStatus(400)).toBe("refused");
    expect(outcomeForStatus(404)).toBe("refused");
    expect(outcomeForStatus(500)).toBe("error");
  });

  it("tells API keys from dashboard sessions", () => {
    expect(requestVia(request({ Authorization: "Bearer whcc_abc" }))).toBe("api_key");
    expect(requestVia(request({ Authorization: "Bearer eyJhbGciOi" }))).toBe("session");
    expect(requestVia(request({}))).toBe("session");
  });

  it("records a user action with status, reason, and user agent", async () => {
    await auditUserAction(
      request({ Authorization: "Bearer eyJ", "User-Agent": "whk/1.3.1" }),
      "user-1",
      {
        action: "team.invite_accepted",
        status: 400,
        reason: "Team has no available seats",
        teamId: "team-1",
        targetUserId: "user-1",
        targetId: "invite-1",
      }
    );

    expect(from).toHaveBeenCalledWith("audit_events");
    expect(insert).toHaveBeenCalledWith({
      actor_type: "user",
      actor_user_id: "user-1",
      via: "session",
      user_agent: "whk/1.3.1",
      action: "team.invite_accepted",
      outcome: "refused",
      team_id: "team-1",
      target_user_id: "user-1",
      target_id: "invite-1",
      metadata: { status: 400, reason: "Team has no available seats" },
    });
  });

  it("never throws when the insert fails", async () => {
    insert.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(
      auditUserAction(request({}), "user-1", { action: "team.deleted", status: 204 })
    ).resolves.toBeUndefined();

    insert.mockRejectedValueOnce(new Error("network"));
    await expect(
      auditUserAction(request({}), "user-1", { action: "team.deleted", status: 204 })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("names Polar actions after the event type", () => {
    expect(polarAuditAction("customer_seat.claimed")).toBe("polar.customer_seat.claimed");
    expect(polarAuditAction("Subscription Updated!")).toBe("polar.subscription_updated_");
  });

  it("keeps only scalar allowlisted Polar fields and the seat user", async () => {
    await auditPolarEvent({
      eventType: "customer_seat.revoked",
      teamId: "team-1",
      outcome: "ok",
      data: {
        id: "seat-1",
        status: "revoked",
        subscription_id: "sub-1",
        email: "someone@example.com",
        customer: { email: "someone@example.com" },
        seat_metadata: { userId: "user-2", teamId: "team-1" },
      },
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_type: "polar",
        action: "polar.customer_seat.revoked",
        team_id: "team-1",
        target_user_id: "user-2",
        target_id: "seat-1",
        metadata: { id: "seat-1", status: "revoked", subscription_id: "sub-1" },
      })
    );
  });

  it("records agent events as the agent, with long agent-chosen strings cut", async () => {
    await auditAgentEvent(request({ "user-agent": "agent/1" }), {
      action: "agent.registration.created",
      status: 200,
      targetId: "reg-1",
      metadata: { flow: "anonymous", client_name: "x".repeat(5000) },
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_type: "agent",
        actor_user_id: null,
        via: null,
        action: "agent.registration.created",
        outcome: "ok",
        target_id: "reg-1",
        metadata: { flow: "anonymous", client_name: "x".repeat(100), status: 200 },
      })
    );
  });

  it("records a human confirming a claim as the user", async () => {
    await auditAgentEvent(request({ authorization: "Bearer jwt" }), {
      action: "agent.claim.confirmed",
      status: 200,
      actorUserId: "user-1",
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ actor_type: "user", actor_user_id: "user-1", via: "session" })
    );
  });

  it("keeps only the domain of an email address", () => {
    expect(emailDomain("Dev@Example.COM")).toBe("example.com");
    expect(emailDomain("no-at-sign")).toBeNull();
  });
});
