import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckoutReview, type CheckoutReviewData } from "./checkout-review";

const review: CheckoutReviewData = {
  id: "11111111-2222-4333-8444-555555555555",
  status: "open",
  summary: "Teams for the team, 3 seats, billed monthly.",
  price: "3 × $12/seat/mo = $36/mo",
  email: "owner@example.com",
  teamName: "Acme",
  requester: { kind: "key", name: "deploy", prefix: "whcc_ab12" },
  unavailable: null,
  country: "DK",
  network: "same",
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
};

const render = (data: CheckoutReviewData, opening = false) =>
  renderToStaticMarkup(<CheckoutReview review={data} opening={opening} onContinue={vi.fn()} />);

describe("CheckoutReview", () => {
  it("shows what the person decides on before anything is made", () => {
    const html = render(review);
    expect(html).toContain("owner@example.com");
    expect(html).toContain("Acme");
    expect(html).toContain(review.summary);
    expect(html).toContain("$36/mo");
    // The name the key chose stands apart, in its own element, never quoted.
    expect(html).toContain(
      'An API key named <span class="font-mono text-foreground" data-testid="checkout-requester-name">deploy</span>'
    );
    expect(html).toContain("whcc_ab12...");
    expect(html).not.toContain("&quot;");
    expect(html).toContain("Denmark");
    expect(html).toContain("5 minutes ago");
    expect(html).toContain("Continue to payment");
    // Same network: no warning.
    expect(html).not.toContain('role="alert"');
  });

  it("warns when the link was made from another network, as the approval page does", () => {
    const html = render({ ...review, network: "different", teamName: null });
    expect(html).toContain('role="alert"');
    expect(html).toContain("This checkout link came from a different network than this browser.");
    expect(html).toContain("Pay for it only if you started it yourself");
    expect(html).toContain("your account");
    expect(render({ ...review, network: "unknown" })).toContain('role="note"');
  });

  it("names an agent, a key without a name, and a session", () => {
    expect(
      render({ ...review, requester: { kind: "agent", name: "Claude Code", prefix: null } })
    ).toContain(
      'A connected agent named <span class="font-mono text-foreground" data-testid="checkout-requester-name">Claude Code</span>'
    );
    expect(
      render({ ...review, requester: { kind: "key", name: null, prefix: "whcc_ab12" } })
    ).toContain("An API key <span");
    expect(
      render({ ...review, requester: { kind: "session", name: null, prefix: null } })
    ).toContain("A signed-in session");
  });

  it("holds the button while the checkout is being made", () => {
    const html = render(review, true);
    expect(html).toContain("Opening the checkout...");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
