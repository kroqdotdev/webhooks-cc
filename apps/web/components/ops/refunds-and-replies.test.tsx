import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefundHoldLines } from "./refunds-and-replies";

const render = (holdReason: string | null, lastError: string | null) =>
  renderToStaticMarkup(
    <dl>
      <RefundHoldLines refund={{ holdReason, lastError }} />
    </dl>
  );

describe("RefundHoldLines", () => {
  it("says a subscription still live in Polar is why, in place of the hold reason", () => {
    const html = render("manual", "subscription_live");
    expect(html).toContain("Still live in Polar: revoke it there, then approve");
    expect(html).not.toContain("Automatic refunds are off");
    expect(html).not.toContain("subscription_live");
    expect(html).not.toContain("Last error");
  });

  it("says so too for a row automatic refunds queued, which has no hold reason", () => {
    expect(render(null, "subscription_live")).toContain("Still live in Polar");
  });

  it("shows the hold reason and any other error once the flag is cleared", () => {
    const held = render("over_cap", null);
    expect(held).toContain("Above the automatic refund cap");
    expect(held).not.toContain("Still live in Polar");
    const failed = render("manual", "polar_unavailable");
    expect(failed).toContain("Automatic refunds are off");
    expect(failed).toContain("polar_unavailable");
  });
});
