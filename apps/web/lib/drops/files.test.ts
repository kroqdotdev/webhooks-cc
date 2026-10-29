import { describe, expect, it } from "vitest";
import { buildCsv, buildJson, buildXml, cleanPrefix, dropFileName, xmlName } from "./files";

describe("file drop files", () => {
  it("names a file after the request, stably, with a clean prefix", () => {
    const first = {
      id: "3f2a9c1e-0000-4000-8000-000000000000",
      receivedAt: "2026-10-29T17:33:26.123Z",
    };
    expect(dropFileName("orders/", first, "csv", false)).toBe(
      "orders-20261029-173326-3f2a9c1e.csv"
    );
    expect(dropFileName(null, first, "json", true)).toBe("20261029-173326-3f2a9c1e-batch.json");
    expect(cleanPrefix("../../etc/passwd")).toBe("etc-passwd");
    expect(cleanPrefix("a".repeat(100))).toHaveLength(60);
  });

  it("writes CSV with quoting and formula cells kept as text", () => {
    const csv = buildCsv(
      ["Subject", "Total", "Note"],
      [
        ['Order "42", paid', "-12.50", '=HYPERLINK("x")'],
        ["Line\nbreak", "+45 1234", "-1+cmd|' /C calc'!A0"],
      ]
    ).toString("utf8");
    expect(csv).toBe(
      'Subject,Total,Note\r\n"Order ""42"", paid",-12.50,"\'=HYPERLINK(""x"")"\r\n"Line\nbreak",\'+45 1234,\'-1+cmd|\' /C calc\'!A0\r\n'
    );
  });

  it("writes XML with safe element names and escaped values", () => {
    const xml = buildXml(
      ["Order #", "2nd line", "xmlish"],
      [["<b>&</b>\u0001", "a", "b"]]
    ).toString("utf8");
    expect(xml).toContain("<Order>&lt;b&gt;&amp;&lt;/b&gt;</Order>");
    expect(xml).toContain("<_2nd_line>a</_2nd_line>");
    expect(xml).toContain("<_xmlish>b</_xmlish>");
    expect(xmlName("")).toBe("field");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("writes one JSON document, or an array for a batch", () => {
    expect(JSON.parse(buildJson([{ a: 1 }], false).toString())).toEqual({ a: 1 });
    expect(JSON.parse(buildJson([{ a: 1 }, { a: 2 }], true).toString())).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });
});
