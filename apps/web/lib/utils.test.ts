import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("lets a later class replace an earlier one in the same group", () => {
    expect(cn("p-4", "p-2")).toBe("p-2");
    expect(cn("shadow-lg", "shadow-xs")).toBe("shadow-xs");
  });

  it("keeps a border width next to a border color", () => {
    expect(cn("border-b border-border")).toBe("border-b border-border");
  });
});
