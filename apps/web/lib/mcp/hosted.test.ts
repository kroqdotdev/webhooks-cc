import { describe, expect, it } from "vitest";
import { requestClientName, toolSelection } from "./hosted";

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
