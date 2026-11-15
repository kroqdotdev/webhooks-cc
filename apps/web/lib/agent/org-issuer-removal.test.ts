import { describe, expect, test } from "vitest";
import { removalWarning, removedText } from "./org-issuer-removal";

describe("removedText", () => {
  test("says nothing was connected", () => {
    expect(removedText(0, [])).toBe("Issuer removed. No agent was connected through it.");
  });

  test("counts and names each agent with its member", () => {
    expect(
      removedText(2, [
        { id: "a", client_name: "claude.ai", pending: false, member_email: "ada@acme.test" },
        { id: "b", client_name: null, pending: true, member_email: "bob@acme.test" },
      ])
    ).toBe(
      "Issuer removed. Disconnected 2 agents: claude.ai for ada@acme.test; An agent for bob@acme.test (not yet confirmed)."
    );
  });

  test("still counts when no names came back", () => {
    expect(removedText(1, [])).toBe("Issuer removed. Disconnected one agent.");
  });
});

describe("removalWarning", () => {
  test("names the count, and that another team's members are disconnected too", () => {
    expect(removalWarning(0)).toBe("No agent is connected through it now.");
    expect(removalWarning(1)).toMatch(/^One agent is connected through it\. It is disconnected/);
    expect(removalWarning(3)).toMatch(/^3 agents are connected through it\. They are all/);
    expect(removalWarning(3)).toContain("another team that trusts the same issuer");
  });

  test("falls back when the count is unknown", () => {
    expect(removalWarning(undefined)).toContain("Every agent it connected is disconnected");
  });
});
