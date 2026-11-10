import { ENTITLEMENTS, type Entitlements } from "@/lib/entitlements";

/*
 * The words for a plan's sharing limits (whk share), read from the
 * entitlements so the pricing cards, the plan table and the Shares page say
 * what plan_entitlements holds.
 */

type SharePlan = "free" | "pro" | "business";

function limits(plan: SharePlan): Readonly<Entitlements> {
  return ENTITLEMENTS[plan];
}

/** "1 at a time", "3 at a time". */
export function sharesAtOnceText(slots: number): string {
  return `${slots} at a time`;
}

/** "Random names only", "3 names", "20 names". */
export function reservedNamesText(names: number): string {
  if (names <= 0) return "Random names only";
  return names === 1 ? "1 name" : `${names} names`;
}

/** "2 hours", "90 minutes", "No limit". */
export function sessionText(minutes: number | null): string {
  if (minutes === null) return "No limit";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

/** "1 GB a month". */
export function dataText(gb: number): string {
  return `${gb} GB a month`;
}

export interface ShareRow {
  label: string;
  free: string;
  pro: string;
  business: string;
}

/** Rows for a plan comparison table. */
export function shareComparisonRows(): ShareRow[] {
  const row = (label: string, value: (e: Readonly<Entitlements>) => string): ShareRow => ({
    label,
    free: value(limits("free")),
    pro: value(limits("pro")),
    business: value(limits("business")),
  });
  return [
    row("Shared previews at once", (e) => sharesAtOnceText(e.shareSlots)),
    row("Reserved preview names", (e) => reservedNamesText(e.reservedNames)),
    row("Preview session length", (e) => sessionText(e.shareSessionMinutes)),
    row("Preview data", (e) => dataText(e.shareDataGb)),
    row("Passwords on previews", (e) => (e.sharePasswords ? "Yes" : "No")),
  ];
}

/** A pricing card's lines about sharing. */
export function shareFeatureLines(plan: SharePlan): string[] {
  const e = limits(plan);
  if (plan === "free") {
    return [
      `Share localhost: ${e.shareSlots} preview at a time, ${sessionText(e.shareSessionMinutes)} each`,
    ];
  }
  const names = reservedNamesText(e.reservedNames).toLowerCase();
  return [
    `${e.shareSlots} shared previews at once, ${names} of your own`,
    `${dataText(e.shareDataGb)} of preview data, passwords on links`,
  ];
}
