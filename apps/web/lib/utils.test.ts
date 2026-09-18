import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps the strong border width next to the line color", () => {
    expect(cn("border-strong border-line")).toBe("border-strong border-line");
    expect(cn("border-b-strong", "border-line")).toBe("border-b-strong border-line");
    expect(cn("divide-y-strong divide-line")).toBe("divide-y-strong divide-line");
  });

  it("lets the strong width replace a primitive's default width", () => {
    expect(cn("border border-input", "border-strong border-line")).toBe(
      "border-strong border-line"
    );
  });

  it("lets caps replace a primitive's tracking and casing", () => {
    expect(cn("font-semibold tracking-tight", "font-bold caps")).toBe("font-bold caps");
    expect(cn("uppercase", "caps-wide")).toBe("caps-wide");
    expect(cn("caps", "clean:uppercase")).toBe("caps clean:uppercase");
  });

  it("treats raised shadows as shadows", () => {
    expect(cn("shadow-lg", "shadow-raised")).toBe("shadow-raised");
    expect(cn("shadow-raised-sm", "shadow-none")).toBe("shadow-none");
  });
});
