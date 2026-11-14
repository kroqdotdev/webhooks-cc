import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  accessToken,
  createSpreadsheet,
  googleConfig,
  GoogleError,
  readFirstRow,
  sheetTitles,
  writeHeader,
} from "@/lib/integrations/google";
import { MAX_COLUMNS } from "@/lib/integrations/sheets";
import { parseJsonBody } from "@/lib/request-validation";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability";
import { googleRefreshToken } from "@/lib/supabase/google-connections";

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * A Google refusal as our answer: what the owner can fix (a tab that is not
 * there, a file the app may not use) is a 400 with Google's reason; Google
 * failing is a 502; a grant that is gone asks for the account again.
 */
function googleFailure(error: GoogleError): { body: { error: string }; status: number } {
  if (error.reconnect) {
    return {
      body: { error: "Google no longer accepts this connection. Connect it again." },
      status: 409,
    };
  }
  const ownerFixable =
    error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 429;
  return { body: { error: error.message }, status: ownerFixable ? 400 : 502 };
}

/**
 * GET /api/integrations/google/spreadsheets?connectionId=&spreadsheetId=:
 * the spreadsheet's tabs, for choosing the one rows go to. Any key of the
 * account may read them.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const rateLimit = await checkRateLimitWithInfo(request, "google-sheets-tabs", 60);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const config = googleConfig();
  if (!config) return reply({ error: "Google Sheets is not set up on this server." }, 503);
  const params = new URL(request.url).searchParams;
  const spreadsheetId = params.get("spreadsheetId") ?? "";
  if (!SPREADSHEET_ID.test(spreadsheetId)) {
    return reply({ error: "That is not a Google Sheets id." }, 400);
  }
  try {
    const refreshToken = await googleRefreshToken(auth.userId, params.get("connectionId") ?? "");
    if (!refreshToken) return reply({ error: "Connect a Google account first." }, 404);
    const token = await accessToken(config, refreshToken);
    return reply({ tabs: await sheetTitles(token, spreadsheetId) });
  } catch (error) {
    if (error instanceof GoogleError) {
      const failure = googleFailure(error);
      return reply(failure.body, failure.status);
    }
    reportError("Failed to list a spreadsheet's tabs", error);
    return reply({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/integrations/google/spreadsheets {connectionId, title, sheet,
 * headers}: creates a spreadsheet in that Google account with the header
 * row, for a Sheets destination. With `spreadsheetId` instead of a title it
 * writes the header row of an existing one, when the owner asks. Any key of
 * the account may: the app reaches only spreadsheets it created or the
 * person picked for it (drive.file), and a first row holding anything but
 * the destination's own earlier headers is left as it is.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const rateLimit = await checkRateLimitWithInfo(request, "google-sheets", 20);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const config = googleConfig();
  if (!config) return reply({ error: "Google Sheets is not set up on this server." }, 503);
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = (parsed.data ?? {}) as Record<string, unknown>;
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const sheet =
    typeof body.sheet === "string" && body.sheet.trim()
      ? body.sheet.trim().slice(0, 100)
      : "Sheet1";
  const headers = Array.isArray(body.headers)
    ? body.headers
        .filter((h): h is string => typeof h === "string")
        .slice(0, MAX_COLUMNS)
        .map((h) => h.slice(0, 200))
    : [];
  try {
    const refreshToken = await googleRefreshToken(auth.userId, connectionId);
    if (!refreshToken) return reply({ error: "Connect a Google account first." }, 404);
    const token = await accessToken(config, refreshToken);
    if (typeof body.spreadsheetId === "string") {
      if (!SPREADSHEET_ID.test(body.spreadsheetId)) {
        return reply({ error: "That is not a Google Sheets id." }, 400);
      }
      // Google answers a tab that is not there with a parse error; say what is.
      const tabs = await sheetTitles(token, body.spreadsheetId);
      if (!tabs.includes(sheet)) {
        return reply(
          {
            error: `The spreadsheet has no tab named "${sheet}". Its tabs: ${tabs.join(", ")}.`,
            tabs,
          },
          400
        );
      }
      // An existing sheet's first row is written only when it is empty or
      // still holds this destination's earlier headers: someone's own data
      // or header row is never overwritten.
      // A key cannot vouch for what row 1 held (it could name the person's
      // own header row): with one, only an empty first row is written.
      const previous =
        !auth.keyId && Array.isArray(body.previousHeaders)
          ? body.previousHeaders.filter((h): h is string => typeof h === "string")
          : [];
      const first = (await readFirstRow(token, body.spreadsheetId, sheet)).filter(
        (cell, i, row) => cell !== "" || row.slice(i).some((c) => c !== "")
      );
      const same = (a: string[], b: string[]) =>
        a.length === b.length && a.every((value, i) => value === b[i]);
      if (first.length > 0 && !same(first, previous) && !same(first, headers)) {
        return reply({ id: body.spreadsheetId, headerWritten: false });
      }
      await writeHeader(token, body.spreadsheetId, sheet, headers);
      return reply({ id: body.spreadsheetId, headerWritten: true });
    }
    const title =
      typeof body.title === "string" && body.title.trim() ? body.title.trim() : "webhooks.cc";
    const created = await createSpreadsheet(token, title, sheet, headers);
    return reply(created, 201);
  } catch (error) {
    if (error instanceof GoogleError) {
      const failure = googleFailure(error);
      return reply(failure.body, failure.status);
    }
    reportError("Failed to create a spreadsheet", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
