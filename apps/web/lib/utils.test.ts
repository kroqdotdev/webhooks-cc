import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps a shadow colour next to a tinted shadow", () => {
    expect(cn("shadow-float", "shadow-primary/20")).toBe("shadow-float shadow-primary/20");
  });

  it("treats the tinted shadows as shadows", () => {
    expect(cn("shadow-lg", "shadow-float")).toBe("shadow-float");
    expect(cn("shadow-surface", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-float-lg", "shadow-surface")).toBe("shadow-surface");
  });
});
