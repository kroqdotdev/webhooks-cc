import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import { LAYOUT_TEMPLATES, layoutTemplate, type LayoutTemplate } from "./layout-templates";
import {
  chooseLayout,
  layoutFieldValues,
  layoutsProblems,
  lineItemsFromSheets,
  lineItemsFromText,
} from "./parsing/layouts";

/**
 * The sample as the receiver stores it: mail's text part keeps its CRLF line
 * endings, so every layout must read that as well as LF.
 */
function sampleRequest(template: LayoutTemplate, lineEnding = "\n"): RequestRecord {
  const { sample } = template;
  return {
    id: "r1",
    endpointId: "e1",
    method: "EMAIL",
    path: "acme@mailhooks.cc",
    headers: { subject: sample.subject },
    queryParams: {},
    ip: "192.0.2.1",
    size: 1,
    receivedAt: 0,
    kind: "email",
    email: {
      subject: sample.subject,
      text: sample.text.replace(/\n/g, lineEnding),
      html: sample.html ?? null,
      from: [sample.from],
      to: [{ name: null, address: "acme@mailhooks.cc" }],
      cc: [],
      replyTo: [],
      sender: [],
      date: null,
      messageId: null,
      inReplyTo: [],
      tag: null,
      textFromHtml: false,
      attachments: [],
      auth: null,
      smtp: null,
      parseError: false,
      truncated: {},
    },
  } as unknown as RequestRecord;
}

describe("layout templates", () => {
  it("have unique ids that are also their layouts' ids", () => {
    const ids = LAYOUT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of LAYOUT_TEMPLATES) {
      expect(template.layout.id).toBe(template.id);
      expect(template.id).toMatch(/^[a-z0-9-]+$/);
      expect(layoutTemplate(template.id)).toBe(template);
    }
    expect(LAYOUT_TEMPLATES.length).toBeGreaterThanOrEqual(10);
  });

  it("are valid layouts", () => {
    expect(layoutsProblems(LAYOUT_TEMPLATES.map((template) => template.layout))).toEqual([]);
  });

  it.each(
    LAYOUT_TEMPLATES.flatMap((template) => [
      [template.id, "LF", template] as const,
      [template.id, "CRLF", template] as const,
    ])
  )("%s reads its sample (%s line endings) as its page shows", (_id, ending, template) => {
    const request = sampleRequest(template, ending === "CRLF" ? "\r\n" : "\n");
    expect(chooseLayout([template.layout], 50, request)?.id).toBe(template.id);
    expect(layoutFieldValues(request, template.layout)).toEqual(template.result.fields);

    const spec = template.layout.lineItems;
    if (!spec) {
      expect(template.result.lineItems).toEqual([]);
    } else if (spec.from === "attachment") {
      // The parser is a separate binary: the sheet it would give stands in.
      const rows = [
        ["SKU", "Product", "Qty", "Revenue"],
        ["LS-01", "Linen shirt", "4", "156.00"],
        ["CT-02", "Canvas tote", "2", "48.00"],
      ];
      const parsed = lineItemsFromSheets(spec, [
        {
          parsed: {
            index: 0,
            filename: template.sample.attachment ?? "",
            format: "csv",
            pages: 1,
          },
          sheets: [{ name: null, rows, rowCount: rows.length, truncated: false }],
        },
      ]);
      expect(parsed.rows).toEqual(template.result.lineItems);
    } else {
      expect(lineItemsFromText(request, spec).rows).toEqual(template.result.lineItems);
    }
  });

  it("do not match each other's samples", () => {
    for (const template of LAYOUT_TEMPLATES) {
      const others = LAYOUT_TEMPLATES.filter(
        (other) => other.id !== template.id && other.id !== "form-responses"
      ).map((other) => other.layout);
      expect(chooseLayout(others, 50, sampleRequest(template))?.id ?? null).toBeNull();
    }
  });
});

describe("withTemplateLayout", () => {
  it("adds the template's layout at the end under a free id", async () => {
    const { withTemplateLayout } = await import("./layout-template-import");
    const first = withTemplateLayout([], "shopify-orders");
    expect(first?.layout.id).toBe("shopify-orders");
    const second = withTemplateLayout(first!.layouts, "shopify-orders");
    expect(second?.layouts.map((layout) => layout.id)).toEqual([
      "shopify-orders",
      "shopify-orders-2",
    ]);
    // The template itself is never changed.
    expect(layoutTemplate("shopify-orders")?.layout.id).toBe("shopify-orders");
  });

  it("refuses an unknown template and a full endpoint", async () => {
    const { withTemplateLayout } = await import("./layout-template-import");
    expect(withTemplateLayout([], "nope")).toBeNull();
    const full = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, name: `L${i}` }));
    expect(withTemplateLayout(full, "shopify-orders")).toBeNull();
  });
});
