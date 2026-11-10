import { beforeEach, describe, expect, it, vi } from "vitest";

const env: Record<string, string | undefined> = {
  EDGE_SECRET: "x".repeat(32),
  EDGE_URL: "http://127.0.0.1:4001",
  SHARE_PREVIEW_ORIGIN: "https://sharehooks.cc",
  WEB_RISK_API_KEY: "test-key",
};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

const reportError = vi.fn();
vi.mock("@/lib/observability", () => ({ reportError }));

const tellStaffOfReport = vi.fn(async () => undefined);
vi.mock("./reports", () => ({ tellStaffOfReport }));

// A tiny stand-in for the two abuse_reports calls the check makes.
const inserted: Record<string, unknown>[] = [];
let openReport: { id: string } | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: openReport, error: null }),
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({ single: async () => ({ data: { id: "report-1" }, error: null }) }),
          };
        },
      };
      return chain;
    },
  }),
}));

const { checkReputation, lastReputation, reputationUri } = await import("./reputation");

function webRisk(body: unknown, status = 200) {
  return vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;
}

describe("checkReputation", () => {
  beforeEach(() => {
    inserted.length = 0;
    openReport = null;
    reportError.mockClear();
    tellStaffOfReport.mockClear();
    env.WEB_RISK_API_KEY = "test-key";
  });

  it("asks Web Risk about the preview domain's apex for the three threat types", async () => {
    const fetcher = webRisk({});
    const result = await checkReputation(fetcher, Date.parse("2026-11-10T03:00:00Z"));
    expect(reputationUri()).toBe("https://sharehooks.cc/");
    const url = new URL(String((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://webrisk.googleapis.com/v1/uris:search");
    expect(url.searchParams.get("uri")).toBe("https://sharehooks.cc/");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.getAll("threatTypes")).toEqual([
      "MALWARE",
      "SOCIAL_ENGINEERING",
      "UNWANTED_SOFTWARE",
    ]);
    expect(result).toMatchObject({ threats: [], error: null, reportId: null });
    expect(lastReputation()?.checkedAt).toBe("2026-11-10T03:00:00.000Z");
    expect(inserted).toHaveLength(0);
  });

  it("opens one report and one error for a listing", async () => {
    const result = await checkReputation(
      webRisk({ threat: { threatTypes: ["SOCIAL_ENGINEERING"], expireTime: "x" } })
    );
    expect(result?.threats).toEqual(["SOCIAL_ENGINEERING"]);
    expect(result?.reportId).toBe("report-1");
    expect(inserted[0]).toMatchObject({
      source: "reputation",
      kind: "phishing",
      url: "https://sharehooks.cc/",
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(tellStaffOfReport).toHaveBeenCalledWith("report-1", "reputation");
  });

  it("opens nothing more while a reputation report is open", async () => {
    openReport = { id: "earlier" };
    const result = await checkReputation(webRisk({ threat: { threatTypes: ["MALWARE"] } }));
    expect(result?.reportId).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("records a failed call without a report", async () => {
    const result = await checkReputation(webRisk({ error: {} }, 403));
    expect(result?.error).toBe("Web Risk answered 403");
    expect(inserted).toHaveLength(0);
  });

  it("does nothing without a key", async () => {
    delete env.WEB_RISK_API_KEY;
    const fetcher = webRisk({});
    expect(await checkReputation(fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
