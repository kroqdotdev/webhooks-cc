import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("lets a later class replace an earlier one in the same group", () => {
    expect(cn("p-4", "p-2")).toBe("p-2");
  });

  it("treats the tinted shadows as shadows", () => {
    expect(cn("shadow-lg", "shadow-float")).toBe("shadow-float");
    expect(cn("shadow-surface", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-float-lg", "shadow-surface")).toBe("shadow-surface");
  });
});
