/**
 * What each paid plan costs, for display (Polar holds the charged prices).
 * Kept apart from lib/billing-api.ts, a client module, so the server's
 * checkout links can name the price too.
 */
export const PLAN_PRICES: Record<"pro" | "business", Partial<Record<"month" | "year", string>>> = {
  pro: { month: "$8 a month" },
  business: { month: "$29 a month", year: "$290 a year" },
};
