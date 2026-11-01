import { describe, expect, it } from "vitest";
import type { ParsedEmail } from "@webhooks-cc/sdk/email";
import { clipText, fitAttachment, fitParsed, MAX_PARSED_BYTES } from "./fit";

const EMOJI = String.fromCodePoint(0x1f4e6);

function parsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    status: "matched",
    layout: { id: "orders", name: "Orders" },
    fields: {},
    lineItems: [],
    lineItemColumns: [],
    attachments: [],
    pages: 0,
    ...overrides,
  };
}

describe("clipText", () => {
  it("never ends in half a surrogate pair", () => {
    const text = "a".repeat(9) + EMOJI;
    expect(clipText(text, 10)).toBe("a".repeat(9));
    expect(clipText(text, 11)).toBe(text);
    expect(clipText("short", 10)).toBe("short");
  });
});

describe("fitAttachment", () => {
  it("cuts rows and text to the attachment's budget and says so", () => {
    const rows = Array.from({ length: 100 }, () => ["x".repeat(2000)]);
    const fitted = fitAttachment(
      {
        index: 0,
        filename: "big.csv",
        format: "csv",
        pages: 1,
        sheets: [{ name: null, rows, rowCount: 100, truncated: false }],
        text: "t".repeat(10_000),
      },
      50_000
    );
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThan(60_000);
    // Cells are cut to 1,000 characters.
    expect(fitted.sheets![0].rows[0][0]).toHaveLength(1000);
    expect(fitted.sheets![0].truncated).toBe(true);
    expect(fitted.sheets![0].rowCount).toBe(100);
    expect(fitted.truncated).toBe(true);
  });
});

describe("fitParsed", () => {
  it("keeps 30 line item columns with short names", () => {
    const columns = Array.from({ length: 40 }, (_, i) => `${"k".repeat(200)}${i}`);
    const row = Object.fromEntries(columns.map((name) => [name, "v"]));
    const fitted = fitParsed(parsed({ lineItems: [row], lineItemColumns: columns }));
    expect(fitted.lineItemColumns).toHaveLength(30);
    expect(Object.keys(fitted.lineItems[0])).toEqual(fitted.lineItemColumns);
    expect(fitted.lineItemColumns.every((name) => name.length <= 100)).toBe(true);
  });

  it("leaves a small result as it is", () => {
    const small = parsed({ fields: { order: "1" }, lineItems: [{ sku: "A-1" }] });
    expect(fitParsed(small)).toEqual(small);
  });

  it("keeps a result with many files and line items within the budget", () => {
    const sheet = {
      name: null,
      rows: Array.from({ length: 1000 }, () => ["c".repeat(500)]),
      rowCount: 1000,
      truncated: false,
    };
    const big = parsed({
      lineItems: Array.from({ length: 1000 }, (_, i) => ({ sku: `S-${i}`, note: "n".repeat(900) })),
      attachments: Array.from({ length: 20 }, (_, index) => ({
        index,
        filename: `f${index}.csv`,
        format: "csv",
        pages: 1,
        sheets: [sheet],
      })),
    });
    const fitted = fitParsed(big);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_PARSED_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(fitted.attachments).toHaveLength(20);
    expect(fitted.attachments[0].sheets![0].rowCount).toBe(1000);
    expect(fitted.lineItems.length).toBeGreaterThan(0);
    expect(fitted.lineItems[0].sku).toBe("S-0");
  });
});
