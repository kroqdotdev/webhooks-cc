import { describe, expect, it } from "vitest";
import { LAYOUT_TEMPLATES } from "@/lib/layout-templates";
import * as page from "./page";

describe("mailhooks.cc sender pages", () => {
  it("are prerendered for the catalogue's senders and never rendered for anything else", () => {
    // Rendered on demand, every made-up slug was cached as a year-long 404.
    expect(page.dynamicParams).toBe(false);
    expect(page.generateStaticParams()).toEqual(
      LAYOUT_TEMPLATES.map((template) => ({ sender: template.id }))
    );
  });
});
