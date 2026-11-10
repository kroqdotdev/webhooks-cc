import { describe, expect, it } from "vitest";
import {
  drawName,
  hasWord,
  isDrawnName,
  nameProblem,
  nameShapeProblem,
  previewNameOf,
  UNAVAILABLE,
} from "./name-rules";

describe("preview names", () => {
  it("takes lowercase letters, digits and single hyphens, 3 to 40 long", () => {
    expect(nameShapeProblem("acme-shop")).toBeNull();
    expect(nameShapeProblem("ab")).toMatch(/3 to 40/);
    expect(nameShapeProblem("Acme")).toMatch(/lowercase/);
    expect(nameShapeProblem("-acme")).toMatch(/starting and ending/);
    expect(nameShapeProblem("a".repeat(41))).toMatch(/3 to 40/);
    expect(nameShapeProblem("acme--shop")).toMatch(/two hyphens/);
  });

  it("keeps names ending in -free for free previews", () => {
    expect(nameShapeProblem("acme-free")).toMatch(/free previews/);
    expect(nameShapeProblem("freelance")).toBeNull();
  });

  it("refuses service, example, brand and lure names however they are written", () => {
    expect(nameProblem("tunnel")).toBe(UNAVAILABLE);
    expect(nameProblem("acme")).toBe(UNAVAILABLE);
    expect(nameProblem("pay-pal-help")).toBe(UNAVAILABLE);
    expect(nameProblem("g00gle-drive")).toBe(UNAVAILABLE);
    expect(nameProblem("1cloud-sync")).toBe(UNAVAILABLE);
    expect(nameProblem("my-webhooks-demo")).toBe(UNAVAILABLE);
    expect(nameProblem("verify-account")).toBe(UNAVAILABLE);
    expect(nameProblem("nordic-bakery")).toBeNull();
    expect(hasWord("groups", "ups")).toBe(true);
  });

  it("draws names it recognises, with the suffix only for free previews", () => {
    for (let i = 0; i < 50; i++) {
      const paid = drawName(false);
      const free = drawName(true);
      expect(isDrawnName(paid, false)).toBe(true);
      expect(isDrawnName(paid, true)).toBe(false);
      expect(isDrawnName(free, true)).toBe(true);
      expect(free.endsWith("-free")).toBe(true);
      expect(nameProblem(paid)).toBeNull();
    }
    expect(isDrawnName("acme-shop-1234", false)).toBe(false);
  });

  it("reads the name out of a preview address", () => {
    expect(previewNameOf("https://acme-shop.sharehooks.cc/x?y=1", "sharehooks.cc")).toBe(
      "acme-shop"
    );
    expect(previewNameOf("acme-shop.sharehooks.cc", "sharehooks.cc")).toBe("acme-shop");
    expect(previewNameOf("https://webhooks.cc/", "sharehooks.cc")).toBeNull();
    expect(previewNameOf("https://a.b.sharehooks.cc/", "sharehooks.cc")).toBeNull();
    expect(previewNameOf("not a url", "sharehooks.cc")).toBeNull();
  });
});
