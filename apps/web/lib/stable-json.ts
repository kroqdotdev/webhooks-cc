/**
 * JSON with object keys sorted, for comparing a draft with its saved copy.
 * Postgres jsonb does not keep key order, so a saved layout or rule comes
 * back with the same values in a different order; plain JSON.stringify would
 * call that a change and leave the form "unsaved" after a successful save.
 * Array order is kept: it means something (layout and rule order).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      // JSON.stringify drops undefined members; dropping them here keeps
      // { a: undefined } equal to {}.
      if (inner !== undefined) sorted[key] = sortKeys(inner);
    }
    return sorted;
  }
  return value;
}
