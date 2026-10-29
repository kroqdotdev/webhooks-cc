import { describe, expect, it } from "vitest";
import { parseSheetsConfig } from "./sheets";

const config = (header: string) => ({
  connectionId: "00000000-0000-4000-8000-000000000000",
  spreadsheetId: "a".repeat(44),
  sheet: "Orders",
  rows: "email",
  columns: [{ header, value: "{{ subject }}" }],
});

describe("parseSheetsConfig", () => {
  it("refuses a blank or whitespace header", () => {
    for (const header of ["", "   "]) {
      expect(parseSheetsConfig(config(header), { http: false, email: true })).toBe(
        "Column 1 needs a header and a value."
      );
    }
  });

  it("keeps a column with a header", () => {
    const parsed = parseSheetsConfig(config("Subject"), { http: false, email: true });
    expect(typeof parsed).toBe("object");
  });
});
