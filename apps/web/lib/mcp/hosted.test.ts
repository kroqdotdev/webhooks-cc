import { describe, expect, it } from "vitest";
import { TOOL_GROUP_NAMES } from "@webhooks-cc/mcp/tools";
import { INSTRUCTIONS, requestClientName, toolSelection, unknownGroupsNote } from "./hosted";

const META = "io.modelcontextprotocol/clientInfo";
const url = (query = "") => new URL(`https://webhooks.cc/mcp${query}`);

describe("toolSelection", () => {
  it("gives a client with a tool limit the core, and one that loads on demand everything", () => {
    expect([...toolSelection(url(), ["cursor-vscode"]).groups]).toEqual(["core"]);
    expect(toolSelection(url(), [null, "Claude Code"]).groups.has("teams")).toBe(true);
    expect(toolSelection(url(), ["claude-code"]).groups.has("teams")).toBe(true);
    expect(toolSelection(url(), [null, null]).groups.has("teams")).toBe(false);
  });

  it("follows ?tools= and ?readonly= over the client", () => {
    const chosen = toolSelection(url("?tools=core,teams&readonly=1"), ["claude-code"]);
    expect([...chosen.groups].sort()).toEqual(["core", "teams"]);
    expect(chosen.readOnly).toBe(true);
    expect(toolSelection(url("?tools=all"), ["cursor-vscode"]).groups.has("sheets")).toBe(true);
    expect(toolSelection(url(), []).readOnly).toBe(false);
  });
});

describe("unknown groups in ?tools=", () => {
  it("keeps the client's default when no name is a group, and reports them", () => {
    const bogus = toolSelection(url("?tools=bogus"), ["Claude Code"]);
    expect([...bogus.groups].sort()).toEqual([...TOOL_GROUP_NAMES].sort());
    expect(bogus.unknown).toEqual(["bogus"]);
    expect([...toolSelection(url("?tools=bogus"), ["cursor-vscode"]).groups]).toEqual(["core"]);
  });

  it("loads the groups named beside an unknown one and says which was not known", () => {
    const chosen = toolSelection(url("?tools=core,teamz"), ["Claude Code"]);
    expect([...chosen.groups]).toEqual(["core"]);
    expect(chosen.unknown).toEqual(["teamz"]);
    const note = unknownGroupsNote(chosen.unknown);
    expect(note).toBe(
      `Unknown tool groups in ?tools=: teamz (known: all, ${TOOL_GROUP_NAMES.join(", ")}).`
    );
    expect(unknownGroupsNote([])).toBeNull();
    expect(toolSelection(url("?tools=core,teams"), []).unknown).toEqual([]);
  });

  it("reports at most five short names of plain characters", () => {
    const long = "x".repeat(80);
    const setting = encodeURIComponent(`<script>,${long},a1,b2,c3,d4,e5,f6`);
    const { unknown } = toolSelection(url(`?tools=${setting}`), []);
    expect(unknown).toEqual(["script", "x".repeat(32), "a1", "b2", "c3"]);
    for (const name of unknown) expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
  });
});

describe("the instructions", () => {
  it("say how to get the groups past the core", () => {
    expect(INSTRUCTIONS).toContain("?tools=");
  });

  it("list exactly the groups beside core that ?tools= takes", () => {
    // "name groups beside core: forwarding, layouts, extras (notes), ... and names (notes), as in"
    const list = /beside core: (.+?), as in\b/.exec(INSTRUCTIONS)?.[1];
    expect(list, "the instructions list the groups after 'beside core:'").toBeDefined();
    const named = list!
      .replace(/\([^)]*\)/g, "")
      .split(/,|\band\b/)
      .map((name) => name.trim())
      .filter(Boolean);
    const expected = TOOL_GROUP_NAMES.filter((group) => group !== "core");
    expect([...named].sort()).toEqual([...expected].sort());
    expect(new Set(named).size, "no group named twice").toBe(named.length);
    // Every name listed is one ?tools= takes.
    for (const group of named) {
      expect([...toolSelection(url(`?tools=${group}`), []).groups], group).toContain(group);
    }
  });
});

describe("requestClientName", () => {
  it("reads the per-request _meta, then a 2025-era initialize", () => {
    expect(
      requestClientName({ params: { _meta: { [META]: { name: "codex-mcp-client" } } } }, META)
    ).toBe("codex-mcp-client");
    expect(requestClientName({ params: { clientInfo: { name: "cursor-vscode" } } }, META)).toBe(
      "cursor-vscode"
    );
    expect(requestClientName({ method: "tools/list" }, META)).toBeNull();
    expect(requestClientName(null, META)).toBeNull();
  });
});
