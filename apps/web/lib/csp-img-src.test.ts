import { describe, expect, it } from "vitest";
import { imgSrcDirective } from "./csp-img-src";

describe("imgSrcDirective", () => {
  it("allows remote https images, on every page", () => {
    expect(imgSrcDirective()).toMatch(/^img-src 'self' data: blob: .* https:$/);
  });
});
