import { describe, expect, it } from "vitest";
import { stableStringify } from "./stable-json";

describe("stableStringify", () => {
  it("ignores object key order, as jsonb does", () => {
    const sent = [{ field: "from", name: "Shop", op: "contains", value: "shopify" }];
    const saved = [{ op: "contains", name: "Shop", field: "from", value: "shopify" }];
    expect(stableStringify(saved)).toBe(stableStringify(sent));
  });

  it("keeps array order", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("treats undefined members like JSON does", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});
