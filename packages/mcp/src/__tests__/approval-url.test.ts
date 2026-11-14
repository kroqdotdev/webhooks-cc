import { describe, expect, it, vi } from "vitest";
import type { WebhooksCC } from "@webhooks-cc/sdk";
import { registerTools, type ToolCall, type ToolResult, type ToolServer } from "../tools";
import { sdkToolResult } from "../sdk-call";

const ID = "2a2a29cc-d875-41aa-b59f-04dbe77c56f8";
const pending = {
  id: ID,
  status: "pending",
  action: "domains.remove",
  summary: "Remove the inbound domain acme.example: mail to it is refused from then on.",
  url: "https://webhooks.cc/approve?code=ABCD-EFGH",
  code: "ABCD-EFGH",
  expiresAt: "2026-11-14T12:15:00.000Z",
  wait: vi.fn(),
};

type Handler = (args: unknown, call?: ToolCall) => Promise<ToolResult>;

function tools(client: Partial<WebhooksCC>): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server: ToolServer = {
    tool(name, _description, _shape, handler) {
      handlers[name] = handler as Handler;
      return { remove() {} };
    },
  };
  registerTools(server, client as WebhooksCC);
  return handlers;
}

describe("approvals opened by the client (URL elicitation)", () => {
  it("answers with text and no approval for a client that cannot open a link", async () => {
    const remove = vi.fn(async () => pending);
    const handlers = tools({ domains: { remove } as unknown as WebhooksCC["domains"] });
    const result = await handlers.remove_domain({ id: "d1" }, { urlElicitation: false });
    expect(result.approval).toBeUndefined();
    expect(result.content[0].text).toContain(pending.url);
  });

  it("asks a client that can open a link to open it, then finishes on the retry", async () => {
    const remove = vi.fn(async () => pending);
    const wait = vi.fn(async () => ({ removed: "acme.example", domainId: "d1" }));
    const handlers = tools({
      domains: { remove } as unknown as WebhooksCC["domains"],
      approvals: { wait } as unknown as WebhooksCC["approvals"],
    });
    const asked = await handlers.remove_domain({ id: "d1" }, { urlElicitation: true });
    expect(asked.approval).toMatchObject({ id: ID, url: pending.url, code: "ABCD-EFGH" });

    const sdk = sdkToolResult(asked) as unknown as Record<string, unknown>;
    expect(sdk.resultType).toBe("input_required");
    expect(sdk.requestState).toBe(ID);
    expect(JSON.stringify(sdk.inputRequests)).toContain(pending.url);
    expect(JSON.stringify(sdk.inputRequests)).toContain("ABCD-EFGH");

    // The retry finishes the approval and never asks for a second one.
    const done = await handlers.remove_domain(
      { id: "d1" },
      { urlElicitation: true, requestState: ID, urlAnswer: "accept" }
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(ID, { timeout: 45_000 });
    expect(done.content[0].text).toContain("acme.example");
    expect(done.approval).toBeUndefined();
  });

  it("says how to go on when the person closed the link, and refuses state it did not make", async () => {
    const wait = vi.fn();
    const handlers = tools({ approvals: { wait } as unknown as WebhooksCC["approvals"] });
    const closed = await handlers.remove_domain(
      { id: "d1" },
      { urlElicitation: true, requestState: ID, urlAnswer: "decline" }
    );
    expect(closed.content[0].text).toContain(`wait_for_approval with id ${ID}`);
    const forged = await handlers.remove_domain(
      { id: "d1" },
      { urlElicitation: true, requestState: "../../api/keys" }
    );
    expect(forged.isError).toBe(true);
    expect(wait).not.toHaveBeenCalled();
  });

  it("passes plain answers through untouched", () => {
    const plain = { content: [{ type: "text" as const, text: "ok" }] };
    expect(sdkToolResult(plain)).toEqual(plain);
  });
});
