import { describe, expect, it } from "vitest";
import { imgSrcDirective } from "./csp-img-src";

describe("imgSrcDirective", () => {
  it("allows remote https images on dashboard pages only", () => {
    expect(imgSrcDirective("/dashboard")).toMatch(/ https:$/);
    expect(imgSrcDirective("/dashboard/settings")).toMatch(/ https:$/);
    for (const path of ["/", "/docs/email-capture", "/dashboards-are-great", "/account"]) {
      expect(imgSrcDirective(path)).not.toMatch(/ https:$/);
    }
  });
});
