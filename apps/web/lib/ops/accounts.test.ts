import { describe, expect, it } from "vitest";
import { mergeActivity } from "./accounts";

const USER = "11111111-1111-4111-8111-111111111111";

function row(id: string, at: string, actor: { type: string; user: string | null }) {
  return {
    id,
    action: `action.${id}`,
    outcome: "ok",
    via: null,
    occurred_at: at,
    actor_type: actor.type,
    actor_user_id: actor.user,
  };
}

describe("mergeActivity", () => {
  it("lists what the account did and what was done to it, newest first", () => {
    const own = row("own", "2026-11-10T10:00:00Z", { type: "user", user: USER });
    const system = row("system", "2026-11-12T10:00:00Z", { type: "system", user: null });
    const other = row("other", "2026-11-11T10:00:00Z", { type: "user", user: "someone-else" });
    // An event the account made on itself comes back from both reads: listed once.
    const self = row("self", "2026-11-09T10:00:00Z", { type: "user", user: USER });
    const merged = mergeActivity(USER, [own, self], [system, other, self]);
    expect(merged.map((entry) => [entry.action, entry.by])).toEqual([
      ["action.system", "system"],
      ["action.other", "user"],
      ["action.own", null],
      ["action.self", null],
    ]);
  });

  it("keeps the newest up to the limit", () => {
    const asActor = [1, 2, 3].map((day) =>
      row(`a${day}`, `2026-11-0${day}T00:00:00Z`, { type: "user", user: USER })
    );
    const asTarget = [4, 5].map((day) =>
      row(`t${day}`, `2026-11-0${day}T00:00:00Z`, { type: "polar", user: null })
    );
    const merged = mergeActivity(USER, asActor, asTarget, 3);
    expect(merged.map((entry) => entry.action)).toEqual(["action.t5", "action.t4", "action.a3"]);
  });
});
