/**
 * What a superseded checkout link's page says happened (app/checkout/[id]):
 * the purchase was undone as a duplicate by the time it was paid. It never
 * promises a refund, since refunds go through a queue a person can hold
 * (lib/billing/refunds.ts): a subscription that charged was ended and its
 * refund is under review; monthly request or page blocks are kept as
 * one-time blocks; a second overage subscription charged nothing. Monthly
 * blocks and an unknown kind never say a subscription ended: a top-up is
 * an order, and nothing ended for it.
 */
export function supersededExplanation(
  kind: string | null | undefined,
  resource: string | null | undefined
): string {
  const already =
    "By the time this payment went through, the account already had what it buys (or what it added to had ended), so it was undone.";
  switch (kind) {
    case "plan":
    case "team_plan":
      return `${already} The new subscription was ended, and a refund of what it charged is under review.`;
    case "overage":
      return `${already} The second overage subscription was ended before it charged anything, so nothing was or will be charged for it.`;
    case "monthly_blocks":
      if (resource === "domains") {
        return `${already} What it charged for the extra domains is under review for a refund.`;
      }
      return `${already} Nothing it added charges again, and the blocks it paid for stay on the account as one-time blocks.`;
    default:
      return `${already} Nothing it bought charges again, and what it charged is under review for a refund.`;
  }
}
