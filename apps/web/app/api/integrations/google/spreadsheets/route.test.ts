import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sheetTitles: vi.fn(),
  readFirstRow: vi.fn(),
  writeHeader: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: vi.fn(async () => ({ success: true, userId: "u1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitWithInfo: vi.fn(async () => ({ response: null })),
  applyRateLimitHeaders: (response: Response) => response,
}));
vi.mock("@/lib/supabase/google-connections", () => ({
  googleRefreshToken: vi.fn(async () => "refresh"),
}));
vi.mock("@/lib/integrations/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/google")>()),
  googleConfig: () => ({ clientId: "c", clientSecret: "s" }),
  accessToken: vi.fn(async () => "token"),
  sheetTitles: mocks.sheetTitles,
  readFirstRow: mocks.readFirstRow,
  writeHeader: mocks.writeHeader,
}));

import { GoogleError } from "@/lib/integrations/google";
import { GET, POST } from "./route";

const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789";

beforeEach(() => {
  mocks.sheetTitles.mockReset().mockResolvedValue(["Ark1", "Orders"]);
  mocks.readFirstRow.mockReset().mockResolvedValue([]);
  mocks.writeHeader.mockReset().mockResolvedValue(undefined);
});

function write(sheet: string) {
  return POST(
    new Request("https://webhooks.cc/api/integrations/google/spreadsheets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "c1", spreadsheetId: SHEET, sheet, headers: ["A"] }),
    })
  );
}

describe("a spreadsheet's tabs", () => {
  it("are listed for choosing the one rows go to", async () => {
    const response = await GET(
      new Request(
        `https://webhooks.cc/api/integrations/google/spreadsheets?connectionId=c1&spreadsheetId=${SHEET}`
      )
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tabs: ["Ark1", "Orders"] });
  });

  it("name the missing tab instead of passing on Google's parse error as a 502", async () => {
    const response = await write("Sheet1");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'The spreadsheet has no tab named "Sheet1". Its tabs: Ark1, Orders.',
      tabs: ["Ark1", "Orders"],
    });
    expect(mocks.writeHeader).not.toHaveBeenCalled();

    expect((await write("Ark1")).status).toBe(200);
    expect(mocks.writeHeader).toHaveBeenCalledWith("token", SHEET, "Ark1", ["A"]);
  });

  it("answer 400 for what the owner can fix and 502 only when Google fails", async () => {
    mocks.sheetTitles.mockRejectedValueOnce(
      new GoogleError("The caller does not have permission", 403)
    );
    expect((await write("Ark1")).status).toBe(400);
    mocks.sheetTitles.mockRejectedValueOnce(new GoogleError("Internal error", 500));
    expect((await write("Ark1")).status).toBe(502);
    mocks.sheetTitles.mockRejectedValueOnce(new GoogleError("Quota", 429));
    expect((await write("Ark1")).status).toBe(502);
  });
});
