// publicEnv() validates the whole public schema on first use and is
// memoized (the redirect URI is the app URL's callback).
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateSessionRequest: vi.fn(),
  listGoogleConnections: vi.fn(),
  exchangeCode: vi.fn(),
  saveGoogleConnection: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateSessionRequest,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitWithInfo: vi.fn(async () => ({ response: null })),
  applyRateLimitHeaders: (response: Response) => response,
}));
vi.mock("@/lib/integrations/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/google")>()),
  exchangeCode: mocks.exchangeCode,
  googleConfig: () => ({ clientId: "client-id", clientSecret: "s" }),
}));
vi.mock("@/lib/supabase/google-connections", () => ({
  listGoogleConnections: mocks.listGoogleConnections,
  saveGoogleConnection: mocks.saveGoogleConnection,
}));
vi.mock("@/lib/audit", () => ({ auditUserAction: vi.fn() }));

import { openPickState, openState, pickedFileId, sealPickState } from "@/lib/integrations/google";
import { POST as pick } from "./route";
import { GET as callback } from "../callback/route";
import { GET as picked } from "../picked/route";

const NONCE = "n".repeat(43);
const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-xy";

beforeEach(() => {
  vi.stubEnv("SIGNING_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
  vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
  mocks.authenticateSessionRequest.mockReset().mockResolvedValue({ success: true, userId: "u1" });
  mocks.listGoogleConnections
    .mockReset()
    .mockResolvedValue([{ id: "conn-1", email: "me@example.com", createdAt: 0 }]);
  mocks.exchangeCode.mockReset();
  mocks.saveGoogleConnection.mockReset();
});

function start(body: unknown, site = "webhooks") {
  return pick(
    new Request("https://webhooks.cc/api/integrations/google/pick", {
      method: "POST",
      headers: { "content-type": "application/json", "x-whk-site": site },
      body: JSON.stringify(body),
    })
  );
}

describe("choosing a spreadsheet from Drive", () => {
  it("opens Google's picker page for the connection's account, spreadsheets only", async () => {
    const response = await start({ connectionId: "conn-1", nonce: NONCE }, "mailhooks");
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("mimetypes")).toBe("application/vnd.google-apps.spreadsheet");
    expect(url.searchParams.get("login_hint")).toBe("me@example.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://webhooks.cc/api/integrations/google/callback"
    );
    const state = url.searchParams.get("state")!;
    expect(openPickState(state)).toMatchObject({ site: "mailhooks", nonce: NONCE });
    // A pick's state never passes for a connection's.
    expect(openState(state)).toBeNull();
  });

  it("refuses another account's connection and a malformed nonce", async () => {
    expect((await start({ connectionId: "theirs", nonce: NONCE })).status).toBe(404);
    expect((await start({ connectionId: "conn-1", nonce: "short" })).status).toBe(400);
  });

  it("goes from the callback to the picked page of the site it started on, saving nothing", async () => {
    const state = encodeURIComponent(
      sealPickState({ site: "mailhooks", nonce: NONCE, expires: Date.now() + 60_000 })
    );
    const response = await callback(
      new Request(
        `https://webhooks.cc/api/integrations/google/callback?state=${state}&picked_file_ids=${FILE},other&code=abc`
      )
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://mailhooks.cc/api/integrations/google/picked?n=${NONCE}&file=${FILE}`
    );
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.saveGoogleConnection).not.toHaveBeenCalled();

    const cancelled = await callback(
      new Request(
        `https://webhooks.cc/api/integrations/google/callback?state=${state}&error=access_denied`
      )
    );
    expect(cancelled.headers.get("location")).toBe(
      `https://mailhooks.cc/api/integrations/google/picked?n=${NONCE}&error=cancelled`
    );
  });

  it("tells the dashboard when a pick took too long, rather than dropping it", async () => {
    const sealed = sealPickState({ site: "webhooks", nonce: NONCE, expires: Date.now() - 1 });
    expect(openPickState(sealed)).toMatchObject({ nonce: NONCE, expired: true });
    const response = await callback(
      new Request(
        `https://webhooks.cc/api/integrations/google/callback?state=${encodeURIComponent(sealed)}&picked_file_ids=${FILE}`
      )
    );
    // The file is not passed on from an expired pick.
    expect(response.headers.get("location")).toBe(
      `https://webhooks.cc/api/integrations/google/picked?n=${NONCE}&error=expired`
    );
  });

  it("takes only a file id that looks like one", () => {
    expect(pickedFileId(`${FILE},second`)).toBe(FILE);
    expect(pickedFileId("<script>")).toBeNull();
    expect(pickedFileId(null)).toBeNull();
  });

  it("hands the pick to the dashboard with only checked values in the page's script", async () => {
    const page = await (
      await picked(
        new Request(`https://mailhooks.cc/api/integrations/google/picked?n=${NONCE}&file=${FILE}`)
      )
    ).text();
    expect(page).toContain(`var message = {"nonce":"${NONCE}","file":"${FILE}"};`);
    // Run the page's script: it posts the pick on the dashboard's channel and closes.
    const posted: unknown[] = [];
    let closed = false;
    class FakeChannel {
      constructor(readonly name: string) {}
      postMessage(data: unknown) {
        posted.push({ name: this.name, data });
      }
      close() {}
    }
    // The page has exactly one script, which our own route wrote.
    const script = page.slice(
      page.indexOf("<script>") + "<script>".length,
      page.indexOf("</script>")
    );
    new Function("BroadcastChannel", "history", "location", "window", script)(
      FakeChannel,
      { replaceState() {} },
      { pathname: "/api/integrations/google/picked" },
      {
        close() {
          closed = true;
        },
      }
    );
    expect(posted).toEqual([{ name: "whcc-drive-pick", data: { nonce: NONCE, file: FILE } }]);
    expect(closed).toBe(true);

    const planted = await (
      await picked(
        new Request(
          "https://mailhooks.cc/api/integrations/google/picked?n=</script><script>alert(1)//&file=</script>"
        )
      )
    ).text();
    expect(planted).toContain("var message = null;");
    expect(planted).not.toContain("alert(1)");
  });
});
