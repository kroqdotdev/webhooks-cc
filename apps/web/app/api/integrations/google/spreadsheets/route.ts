import { authenticateSessionRequest } from "@/lib/api-auth";
import {
  accessToken,
  createSpreadsheet,
  googleConfig,
  GoogleError,
  readFirstRow,
  writeHeader,
} from "@/lib/integrations/google";
import { MAX_COLUMNS } from "@/lib/integrations/sheets";
import { parseJsonBody } from "@/lib/request-validation";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability";
import { googleRefreshToken } from "@/lib/supabase/google-connections";

/**
 * POST /api/integrations/google/spreadsheets {connectionId, title, sheet,
 * headers}: creates a spreadsheet in that Google account with the header
 * row, for a Sheets destination. With `spreadsheetId` instead of a title it
 * writes the header row of an existing one, when the owner asks. Takes a
 * session, never an API key: it writes to the person's Google Drive.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
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
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(body.spreadsheetId)) {
        return reply({ error: "That is not a Google Sheets id." }, 400);
      }
      // An existing sheet's first row is written only when it is empty or
      // still holds this destination's earlier headers: someone's own data
      // or header row is never overwritten.
      const previous = Array.isArray(body.previousHeaders)
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
      return reply(
        {
          error: error.reconnect
            ? "Google no longer accepts this connection. Connect it again."
            : error.message,
        },
        error.reconnect ? 409 : 502
      );
    }
    reportError("Failed to create a spreadsheet", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
