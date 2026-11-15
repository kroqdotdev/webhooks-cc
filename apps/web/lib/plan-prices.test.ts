import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_PRICES } from "./plan-prices";

// The prices a checkout link's review page shows (lib/billing/checkout-links.ts)
// and the dashboard's plan chooser and comparison read PLAN_PRICES. These
// pin it, and check the pages that state the prices inline say the same, so
// a price change in Polar moves them together.
const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
const dollars = (price: string | undefined) => {
  const match = price?.match(/^\$(\d+) a (month|year)$/);
  if (!match) throw new Error(`not a price: ${price}`);
  return match[1];
};

describe("PLAN_PRICES", () => {
  it("is what the plans cost", () => {
    expect(PLAN_PRICES).toEqual({
      pro: { month: "$8 a month" },
      business: { month: "$29 a month", year: "$290 a year" },
    });
  });

  it("matches the prices the dashboard and the pricing page state inline", () => {
    const pro = dollars(PLAN_PRICES.pro.month);
    const business = dollars(PLAN_PRICES.business.month);
    const businessYear = dollars(PLAN_PRICES.business.year);

    // Manage subscription (Account, Plan).
    const dialog = read("components/billing/manage-subscription-dialog.tsx");
    expect(dialog).toContain(`"$${pro}.00/month"`);
    expect(dialog).toContain(`"$${business}.00/month"`);
    expect(dialog).toContain(`"$${businessYear}.00/year"`);

    // The pricing page's plans and its questions.
    const plans = read("components/landing/pricing-plans.tsx");
    expect(plans).toMatch(new RegExp(`\\$${pro}\\s*\\n`));
    expect(plans).toMatch(new RegExp(`\\$${business}\\s*\\n`));
    expect(plans).toContain(`or $${businessYear} a year`);
    const faq = read("lib/pricing-faq.ts");
    expect(faq).toContain(`Pro ($${pro}/month)`);
    expect(faq).toContain(`Business ($${business}/month or $${businessYear}/year)`);
  });
});
