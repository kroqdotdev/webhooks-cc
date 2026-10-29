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

function sampleRequest(template: LayoutTemplate): RequestRecord {
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
      text: sample.text,
      html: null,
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

  it.each(LAYOUT_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s reads its sample as its page shows",
    (_id, template) => {
      const request = sampleRequest(template);
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
    }
  );

  it("do not match each other's samples", () => {
    for (const template of LAYOUT_TEMPLATES) {
      const others = LAYOUT_TEMPLATES.filter(
        (other) => other.id !== template.id && other.id !== "form-responses"
      ).map((other) => other.layout);
      expect(chooseLayout(others, 50, sampleRequest(template))?.id ?? null).toBeNull();
    }
  });
});
