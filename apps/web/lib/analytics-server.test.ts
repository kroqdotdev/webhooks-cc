import { describe, expect, it } from "vitest";
import { auditAnalyticsEvent, clientFromUserAgent, stableEventUuid } from "./analytics-server";

const row = {
  actor_type: "user" as const,
  actor_user_id: "user-1",
  via: "api_key" as const,
  user_agent: "whk-cli/1.7.0",
  action: "endpoint.created",
  outcome: "ok",
  team_id: null,
  target_id: "endpoint-1",
  metadata: { status: 201, kind: "email" },
};

describe("auditAnalyticsEvent", () => {
  it("leaves staff work in the operations center out", () => {
    expect(auditAnalyticsEvent({ ...row, action: "ops.account_viewed" })).toBeNull();
    expect(auditAnalyticsEvent({ ...row, action: "ops.ticket_replied" })).toBeNull();
  });

  it("sends the action as the event, with the client that made it", () => {
    expect(auditAnalyticsEvent(row)).toEqual({
      distinctId: "user-1",
      event: "endpoint.created",
      properties: { outcome: "ok", via: "api_key", client: "cli", status: 201, kind: "email" },
      groups: undefined,
      personless: false,
    });
  });

  it("keeps addresses, domains, names and refusal messages out", () => {
    const event = auditAnalyticsEvent({
      ...row,
      action: "team.invite_sent",
      team_id: "team-1",
      metadata: {
        invited_email: "a@acme.test",
        verified_host: "mail.acme.test",
        name: "Acme",
        reason: "acme.test is already verified",
        destination: "https://hooks.acme.test/x",
        fields: ["name", "mock_response"],
        seats: 3,
      },
    });
    expect(event?.properties).toEqual({
      outcome: "ok",
      via: "api_key",
      client: "cli",
      team_id: "team-1",
      fields: ["name", "mock_response"],
      seats: 3,
    });
    expect(event?.groups).toEqual({ team: "team-1" });
  });

  it("counts an agent without an account by its registration, with no person", () => {
    const event = auditAnalyticsEvent({
      ...row,
      actor_type: "agent",
      actor_user_id: null,
      via: null,
      action: "agent.registration.created",
      target_id: "reg-1",
    });
    expect(event?.distinctId).toBe("agent:reg-1");
    expect(event?.personless).toBe(true);
    expect(event?.properties?.client).toBe("cli");
  });

  it("leaves out refused anonymous agents and agent-chosen names", () => {
    const refused = { ...row, actor_type: "agent" as const, actor_user_id: null, via: null };
    expect(auditAnalyticsEvent({ ...refused, outcome: "refused", target_id: null })).toBeNull();
    const ok = auditAnalyticsEvent({ ...refused, metadata: { client_name: "Acme bot" } });
    expect(ok?.properties).not.toHaveProperty("client_name");
  });

  it("names an agent token's client when the client names itself, else counts it as an agent", () => {
    const agent = { ...row, via: "agent_token" as const };
    expect(
      auditAnalyticsEvent({
        ...agent,
        user_agent: "webhooks-cc-mcp-remote/0.58.2 webhooks-cc-sdk/1.20.0",
      })?.properties?.client
    ).toBe("mcp_remote");
    expect(auditAnalyticsEvent({ ...agent, user_agent: "whk-cli/1.7.0" })?.properties?.client).toBe(
      "cli"
    );
    expect(auditAnalyticsEvent({ ...agent, user_agent: "node" })?.properties?.client).toBe("agent");
    expect(auditAnalyticsEvent({ ...agent, user_agent: null })?.properties?.client).toBe("agent");
    expect(
      auditAnalyticsEvent({ ...agent, user_agent: "webhooks-cc-sdk/1.21.0" })?.properties?.client
    ).toBe("typescript_sdk");
  });

  it("removes the email from a deleted account's person", () => {
    const event = auditAnalyticsEvent({ ...row, action: "account.deleted" });
    expect(event?.properties?.$unset).toEqual(["email"]);
  });

  it("skips Polar and system rows", () => {
    expect(auditAnalyticsEvent({ ...row, actor_type: "polar", actor_user_id: null })).toBeNull();
    expect(auditAnalyticsEvent({ ...row, actor_type: "system" })).toBeNull();
  });
});

describe("clientFromUserAgent", () => {
  it.each([
    ["whk-cli/1.7.0", "cli"],
    ["webhooks-cc-python/0.4.0", "python_sdk"],
    ["webhooks-cc-go/0.4.0", "go_sdk"],
    ["webhooks-cc-sdk/1.20.0", "typescript_sdk"],
    ["acme-tool/2.0 webhooks-cc-sdk/1.20.0", "typescript_sdk"],
    ["notwebhooks-cc-sdk/1.21.0", "other"],
    ["webhooks-cc-mcp/1.16.0 webhooks-cc-sdk/1.20.0", "mcp"],
    ["webhooks-cc-mcp-remote/0.58.2 webhooks-cc-sdk/1.20.0", "mcp_remote"],
    ["Zapier", "zapier"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "browser"],
    ["node", "node"],
    ["curl/8.5.0", "other"],
    [null, "unknown"],
  ])("%s is %s", (userAgent, client) => {
    expect(clientFromUserAgent(userAgent)).toBe(client);
  });
});

describe("stableEventUuid", () => {
  it("is a version 8 UUID that depends only on the name", () => {
    const id = stableEventUuid("daily:user-1:2026-11-01");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableEventUuid("daily:user-1:2026-11-01")).toBe(id);
    expect(stableEventUuid("daily:user-1:2026-11-02")).not.toBe(id);
  });
});
