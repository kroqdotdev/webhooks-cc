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

  it("finishes approvals only for the tools that ask for them", async () => {
    const wait = vi.fn();
    const remove = vi.fn(async () => undefined);
    const handlers = tools({
      approvals: { wait } as unknown as WebhooksCC["approvals"],
      endpoints: { delete: remove } as unknown as WebhooksCC["endpoints"],
    });
    await handlers.delete_endpoint({ slug: "abc" }, { urlElicitation: true, requestState: ID });
    expect(wait).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("abc");
  });

  it("passes plain answers through untouched", () => {
    const plain = { content: [{ type: "text" as const, text: "ok" }] };
    expect(sdkToolResult(plain)).toEqual(plain);
  });
});

describe("checkout links opened by the client (URL elicitation)", () => {
  const CHECKOUT = "11111111-2222-4333-8444-555555555555";
  const link = {
    id: CHECKOUT,
    status: "open",
    kind: "plan",
    summary: "The Pro plan, billed monthly.",
    item: { kind: "plan", plan: "pro", interval: "month" },
    teamId: null,
    url: "https://polar.sh/checkout/polar_c_x",
    createdAt: "2026-11-14T12:00:00.000Z",
    expiresAt: "2026-11-14T13:00:00.000Z",
    paidAt: null,
  };

  it("answers with the link as text for a client that cannot open one", async () => {
    const createCheckout = vi.fn(async () => link);
    const handlers = tools({ billing: { createCheckout } as unknown as WebhooksCC["billing"] });
    const result = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: false }
    );
    expect(createCheckout).toHaveBeenCalledWith({ kind: "plan", plan: "pro" });
    expect(result.checkout).toBeUndefined();
    expect(result.content[0].text).toContain(link.url);
    expect(result.content[0].text).toContain(`wait_for_checkout with id ${CHECKOUT}`);
  });

  it("opens the checkout for a client that can, then waits for the payment on the retry", async () => {
    const createCheckout = vi.fn(async () => link);
    const waitForCheckout = vi.fn(async () => ({ ...link, status: "paid", url: null }));
    const handlers = tools({
      billing: { createCheckout, waitForCheckout } as unknown as WebhooksCC["billing"],
    });
    const asked = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true }
    );
    expect(asked.checkout).toMatchObject({ id: CHECKOUT, url: link.url });
    const sdk = sdkToolResult(asked) as unknown as Record<string, unknown>;
    expect(sdk.resultType).toBe("input_required");
    expect(sdk.requestState).toBe(CHECKOUT);
    expect(JSON.stringify(sdk.inputRequests)).toContain(link.url);

    const done = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true, requestState: CHECKOUT, urlAnswer: "accept" }
    );
    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(waitForCheckout).toHaveBeenCalledWith(CHECKOUT, { timeout: 45_000 });
    expect(done.content[0].text).toContain("Paid: The Pro plan");

    const closed = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true, requestState: CHECKOUT, urlAnswer: "decline" }
    );
    expect(closed.content[0].text).toContain(`wait_for_checkout with id ${CHECKOUT}`);
    const forged = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true, requestState: "../../api/keys" }
    );
    expect(forged.isError).toBe(true);
    expect(waitForCheckout).toHaveBeenCalledTimes(1);
  });

  it("tells the agent when the link expired or is not paid yet", async () => {
    const { CheckoutExpiredError, TimeoutError } = await import("@webhooks-cc/sdk");
    const waitForCheckout = vi
      .fn()
      .mockRejectedValueOnce(new CheckoutExpiredError(CHECKOUT))
      .mockRejectedValueOnce(new TimeoutError(45_000));
    const handlers = tools({ billing: { waitForCheckout } as unknown as WebhooksCC["billing"] });
    expect((await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text).toContain(
      "expired"
    );
    expect((await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text).toContain(
      "Not paid yet"
    );
  });
});
