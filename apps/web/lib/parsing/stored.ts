import type { Layout } from "@webhooks-cc/sdk/email";

/** A stored list as layouts; anything malformed is left out. */
export function storedLayouts(value: unknown): Layout[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (layout): layout is Layout =>
      !!layout &&
      typeof layout === "object" &&
      typeof (layout as Layout).id === "string" &&
      typeof (layout as Layout).name === "string"
  );
}
