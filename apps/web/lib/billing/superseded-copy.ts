/**
 * What a superseded checkout link's page says happened (app/checkout/[id]):
 * the purchase was undone as a duplicate by the time it was paid. It never
 * promises a refund, since refunds go through a queue a person can hold
 * (lib/billing/refunds.ts): a subscription that charged was ended and its
 * refund is under review; monthly request or page blocks are kept as
 * one-time blocks; a second overage subscription charged nothing.
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
      return `${already} The subscription was ended, and the blocks it paid for stay on the account as one-time blocks.`;
    default:
      return `${already} The subscription was ended, and a refund of what it charged is under review.`;
  }
}
