import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAILHOOKS_FEATURES, mailhooksFeature } from "./mailhooks-features";
import { servedOnMailhooks } from "./site";

const APP = path.resolve(__dirname, "../app");
const EM_DASH = String.fromCharCode(0x2014);

describe("mailhooks.cc feature pages", () => {
  it("has a page under app/mailhooks for each, served on mailhooks.cc", () => {
    for (const feature of MAILHOOKS_FEATURES) {
      expect(existsSync(path.join(APP, "mailhooks", feature.path, "page.tsx")), feature.path).toBe(
        true
      );
      expect(servedOnMailhooks(feature.path), feature.path).toBe(true);
    }
  });

  it("gives each page a title, description and path of its own", () => {
    for (const key of ["path", "name", "title", "description", "heading"] as const) {
      const values = MAILHOOKS_FEATURES.map((feature) => feature[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
    for (const feature of MAILHOOKS_FEATURES) {
      expect(feature.description.length, feature.path).toBeLessThanOrEqual(200);
      expect(feature.steps.length, feature.path).toBeGreaterThanOrEqual(3);
      expect(feature.faq.length, feature.path).toBeGreaterThanOrEqual(3);
      expect(feature.docs.path.startsWith("/docs/"), feature.path).toBe(true);
    }
  });

  it("writes no em dashes", () => {
    expect(JSON.stringify(MAILHOOKS_FEATURES)).not.toContain(EM_DASH);
  });

  it("finds a page by its path, and refuses one that does not exist", () => {
    expect(mailhooksFeature("/file-drops").name).toBe("File drops");
    expect(() => mailhooksFeature("/nope")).toThrow();
  });
});
