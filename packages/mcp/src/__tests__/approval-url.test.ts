import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type WebhooksCC } from "@webhooks-cc/sdk";
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
    for (const call of [{ urlElicitation: false }, undefined]) {
      const result = await handlers.remove_domain({ id: "d1" }, call);
      expect(result.approval).toBeUndefined();
      expect(result.content[0].text).toContain(pending.url);
      expect(result.content[0].text).toContain("ABCD-EFGH");
      expect(result.content[0].text).toContain(pending.summary);
      expect(result.content[0].text).toContain(`wait_for_approval with id ${ID}`);
      // Plain text for the SDK too: no input request.
      expect(sdkToolResult(result)).toEqual({ content: result.content });
    }
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

  it.each(["decline", "cancel"])(
    "hands the agent the link, code and summary when the client answers %s",
    async (urlAnswer) => {
      const wait = vi.fn();
      const { wait: _unused, ...view } = pending;
      void _unused;
      const get = vi.fn(async () => ({ approval: view }));
      const handlers = tools({ approvals: { wait, get } as unknown as WebhooksCC["approvals"] });
      const closed = await handlers.create_api_key(
        { name: "ci" },
        { urlElicitation: true, requestState: ID, urlAnswer }
      );
      const text = closed.content[0].text;
      expect(get).toHaveBeenCalledWith(ID, { timeout: 5_000 });
      expect(text).toContain(pending.url);
      expect(text).toContain("ABCD-EFGH");
      expect(text).toContain(pending.summary);
      expect(text).toContain(`wait_for_approval with id ${ID}`);
      expect(closed.approval).toBeUndefined();
      expect(wait).not.toHaveBeenCalled();
    }
  );

  it("answers a declined request with what the approval already granted or why it ended", async () => {
    const { wait: _unused, ...view } = pending;
    void _unused;
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        approval: { ...view, status: "completed" },
        result: { key: "whcc_test", name: "ci", expiresAt: "2027-01-01T00:00:00.000Z" },
      })
      .mockResolvedValueOnce({ approval: { ...view, status: "denied" } })
      .mockResolvedValueOnce({ approval: { ...view, status: "expired" } })
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new NotFoundError("Approval not found"));
    const handlers = tools({ approvals: { get } as unknown as WebhooksCC["approvals"] });
    const call = { urlElicitation: true, requestState: ID, urlAnswer: "decline" };
    expect((await handlers.create_api_key({}, call)).content[0].text).toContain("whcc_test");
    expect((await handlers.create_api_key({}, call)).content[0].text).toContain("refused");
    expect((await handlers.create_api_key({}, call)).content[0].text).toContain("expired");
    // Unreadable for now: never an error, and wait_for_approval shows the link.
    const failed = await handlers.create_api_key({}, call);
    expect(failed.isError).toBeUndefined();
    expect(failed.content[0].text).toContain(`wait_for_approval with id ${ID}`);
    // Not found for this connection: asking again would loop, so it says so.
    const missing = await handlers.create_api_key({}, call);
    expect(missing.content[0].text).toContain("was not found");
    expect(missing.content[0].text).not.toContain("call wait_for_approval");
  });

  it("shows the link and code when a wait times out, since the client may have shown them only to the person", async () => {
    const { TimeoutError } = await import("@webhooks-cc/sdk");
    const { wait: _unused, ...view } = pending;
    void _unused;
    const wait = vi.fn().mockRejectedValue(new TimeoutError(45_000));
    const get = vi.fn(async () => ({ approval: view }));
    const handlers = tools({ approvals: { wait, get } as unknown as WebhooksCC["approvals"] });
    const retried = await handlers.remove_domain(
      { id: "d1" },
      { urlElicitation: true, requestState: ID, urlAnswer: "accept" }
    );
    expect(retried.content[0].text).toContain("Not answered yet.");
    expect(retried.content[0].text).toContain(pending.url);
    expect(retried.content[0].text).toContain("ABCD-EFGH");
    const waited = await handlers.wait_for_approval({ id: ID, timeout: "1s" });
    expect(waited.content[0].text).toContain(pending.url);
  });

  it("refuses state it did not make", async () => {
    const wait = vi.fn();
    const get = vi.fn();
    const handlers = tools({ approvals: { wait, get } as unknown as WebhooksCC["approvals"] });
    const forged = await handlers.remove_domain(
      { id: "d1" },
      { urlElicitation: true, requestState: "../../api/keys", urlAnswer: "decline" }
    );
    expect(forged.isError).toBe(true);
    expect(wait).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
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
    url: `https://webhooks.cc/checkout/${CHECKOUT}`,
    createdAt: "2026-11-14T12:00:00.000Z",
    expiresAt: "2026-11-14T13:00:00.000Z",
    paidAt: null,
    bought: null,
    matches: null,
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
    expect(result.content[0].text).toContain("signed in to webhooks.cc as the account's owner");
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
    // Our page, opened signed in; never Polar's checkout.
    expect(JSON.stringify(sdk.inputRequests)).toContain(link.url);
    expect(JSON.stringify(sdk.inputRequests)).toContain("signed in to webhooks.cc");

    const done = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true, requestState: CHECKOUT, urlAnswer: "accept" }
    );
    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(waitForCheckout).toHaveBeenCalledWith(CHECKOUT, { timeout: 45_000 });
    expect(done.content[0].text).toContain("Paid: The Pro plan");

    const forged = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true, requestState: "../../api/keys" }
    );
    expect(forged.isError).toBe(true);
    expect(waitForCheckout).toHaveBeenCalledTimes(1);
  });

  it.each(["decline", "cancel"])(
    "hands the agent the checkout link when the client answers %s",
    async (urlAnswer) => {
      const getCheckout = vi.fn(async () => link);
      const waitForCheckout = vi.fn();
      const handlers = tools({
        billing: { getCheckout, waitForCheckout } as unknown as WebhooksCC["billing"],
      });
      const closed = await handlers.create_checkout(
        { kind: "plan", plan: "pro" },
        { urlElicitation: true, requestState: CHECKOUT, urlAnswer }
      );
      const text = closed.content[0].text;
      expect(getCheckout).toHaveBeenCalledWith(CHECKOUT);
      expect(text).toContain(link.url);
      expect(text).toContain(link.summary);
      expect(text).toContain(`wait_for_checkout with id ${CHECKOUT}`);
      expect(waitForCheckout).not.toHaveBeenCalled();
    }
  );

  it("answers a declined checkout that is no longer open as a wait would", async () => {
    const getCheckout = vi.fn(async () => ({ ...link, status: "paid", url: null }));
    const waitForCheckout = vi.fn(async () => ({ ...link, status: "paid", url: null }));
    const handlers = tools({
      billing: { getCheckout, waitForCheckout } as unknown as WebhooksCC["billing"],
    });
    const closed = await handlers.create_checkout(
      { kind: "plan", plan: "pro" },
      { urlElicitation: true, requestState: CHECKOUT, urlAnswer: "cancel" }
    );
    expect(closed.content[0].text).toContain("Paid: The Pro plan");
  });

  it("tells the agent when the link expired, was superseded or is not paid yet", async () => {
    const { CheckoutExpiredError, CheckoutSupersededError, TimeoutError } =
      await import("@webhooks-cc/sdk");
    const waitForCheckout = vi
      .fn()
      .mockRejectedValueOnce(new CheckoutSupersededError(CHECKOUT))
      .mockRejectedValueOnce(new CheckoutExpiredError(CHECKOUT))
      .mockRejectedValueOnce(new TimeoutError(45_000))
      .mockResolvedValueOnce({
        ...link,
        kind: "team_plan",
        status: "paid",
        url: null,
        bought: { product: "prod_teams", seats: 5, units: null, amount: 0, currency: "usd" },
        matches: false,
      })
      .mockResolvedValueOnce({
        ...link,
        kind: "team_plan",
        status: "paid",
        url: null,
        // The order came first: the seats are not known yet.
        bought: { product: "prod_teams", seats: null, units: null, amount: 0, currency: "usd" },
        matches: null,
      });
    const handlers = tools({ billing: { waitForCheckout } as unknown as WebhooksCC["billing"] });
    const superseded = (await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text;
    // Refunds are reviewed: the agent is told never to promise one.
    expect(superseded).toContain("a refund of what it charged is under review");
    expect(superseded).not.toMatch(/goes back|back to their card/);
    expect((await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text).toContain(
      "expired"
    );
    expect((await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text).toContain(
      "Not paid yet"
    );
    expect((await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text).toContain(
      "What was bought differs from what the link asked for (5 seats)"
    );
    // Not known yet is no mismatch.
    const unknown = (await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text;
    expect(unknown).toContain("Paid:");
    expect(unknown).not.toContain("differs");
  });

  it("never lets the agent say nothing was charged for a link that may have been paid", async () => {
    const { CheckoutExpiredError } = await import("@webhooks-cc/sdk");
    const waitForCheckout = vi
      .fn()
      .mockRejectedValueOnce(new CheckoutExpiredError(CHECKOUT, undefined, "unsettled"));
    const handlers = tools({ billing: { waitForCheckout } as unknown as WebhooksCC["billing"] });
    const text = (await handlers.wait_for_checkout({ id: CHECKOUT })).content[0].text;
    expect(text).toContain("if the person paid, it is still applied");
    expect(text).toContain("has been alerted");
    expect(text).toContain("Do not tell them nothing was charged");
    expect(text).toContain(`wait_for_checkout with id ${CHECKOUT}`);
  });
});
