import type { ParsedEmail } from "@webhooks-cc/sdk/email";
/**
 * The arithmetic of field alerts, apart from the database so it can be
 * tested on its own. An email's outcome is true when every required field
 * was found. The checker keeps how many emails in a row missed one (streak)
 * and the last RECENT outcomes, oldest first, as a string of 1s and 0s.
 */

export const RECENT = 20;
/** The share rule needs at least this many outcomes, so two misses out of two do not alarm. */
export const MIN_SHARE_SAMPLE = 5;

export interface FieldState {
  streak: number;
  recent: string;
}

export interface FieldRules {
  fieldFailures: number | null;
  fieldFailureShare: number | null;
}

export function nextFieldState(state: FieldState, outcomes: boolean[]): FieldState {
  let { streak, recent } = state;
  for (const ok of outcomes) {
    streak = ok ? 0 : streak + 1;
    recent = (recent + (ok ? "1" : "0")).slice(-RECENT);
  }
  return { streak, recent };
}

/** Percent of recent outcomes that missed a field, or null with too few outcomes. */
export function missShare(recent: string): number | null {
  if (recent.length < MIN_SHARE_SAMPLE) return null;
  const misses = [...recent].filter((bit) => bit === "0").length;
  return Math.round((misses / recent.length) * 100);
}

/** Whether the state calls for an open alert under the rules. */
export function fieldAlertDue(rules: FieldRules, state: FieldState): boolean {
  if (rules.fieldFailures !== null && state.streak >= rules.fieldFailures) return true;
  const share = missShare(state.recent);
  return rules.fieldFailureShare !== null && share !== null && share >= rules.fieldFailureShare;
}

/** The fields an email must have: the required list (only names the endpoint has), or all. */
export function requiredFieldNames(
  allFields: readonly string[],
  required: readonly string[] | null
): string[] {
  if (!required) return [...allFields];
  const known = new Set(allFields);
  return required.filter((name) => known.has(name));
}

/** The required fields an email's values lack. */
export function missingFields(
  values: Record<string, string | null> | null,
  required: readonly string[]
): string[] {
  return required.filter((name) => values?.[name] === null || values?.[name] === undefined);
}

/** Shown as the missing "field" when no layout matched or the parse failed. */
export const NO_LAYOUT = "(no layout matched)";
export const PARSE_FAILED = "(parse failed)";

/**
 * What an email on an endpoint with layouts lacks: a layout, or one of the
 * required fields among the endpoint's email fields and its layout's fields
 * (every one of them when no fields are named).
 */
export function layoutMissing(
  parse: "none" | "pending" | "failed" | ParsedEmail,
  emailValues: Record<string, string | null> | null,
  emailFieldNames: readonly string[],
  requiredNames: readonly string[] | null
): string[] {
  if (parse === "pending" || parse === "none") return [];
  if (parse === "failed") return [PARSE_FAILED];
  if (parse.status !== "matched") return [NO_LAYOUT];
  const values = { ...(emailValues ?? {}), ...parse.fields };
  const required = requiredFieldNames(
    [...new Set([...emailFieldNames, ...Object.keys(parse.fields)])],
    requiredNames
  );
  return missingFields(values, required);
}
