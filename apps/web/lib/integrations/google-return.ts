/**
 * The way back from connecting a Google account in the dashboard. The
 * callback (app/api/integrations/google/callback) returns the browser to the
 * page it started on with `?google=<outcome>`; the Sheets editor that started
 * it adds `?sheets=<destination id, or "new">`, so the destinations section
 * opens that editor again and it says how the connection went. Client-safe:
 * no server imports.
 */

export const GOOGLE_OUTCOME_PARAM = "google";
export const SHEETS_EDITOR_PARAM = "sheets";

export const GOOGLE_OUTCOMES = ["connected", "scope", "cancelled", "expired", "failed"] as const;
export type GoogleOutcome = (typeof GOOGLE_OUTCOMES)[number];

export interface GoogleReturn {
  outcome: GoogleOutcome;
  /** The Sheets editor to open again: a destination's id, or "new". */
  editor: string;
}

/** What the address says about a connection that just came back, if anything. */
export function readGoogleReturn(search: string): GoogleReturn | null {
  const params = new URLSearchParams(search);
  const outcome = params.get(GOOGLE_OUTCOME_PARAM);
  if (!outcome || !(GOOGLE_OUTCOMES as readonly string[]).includes(outcome)) return null;
  const editor = params.get(SHEETS_EDITOR_PARAM);
  return {
    outcome: outcome as GoogleOutcome,
    editor: editor && /^[A-Za-z0-9-]{1,64}$/.test(editor) ? editor : "new",
  };
}

/** The address without the return's parameters, to put back once it was read. */
export function withoutGoogleReturn(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(GOOGLE_OUTCOME_PARAM);
  url.searchParams.delete(SHEETS_EDITOR_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where Google should send the browser back to: this page, with this editor named. */
export function googleReturnPath(href: string, editor: string): string {
  const url = new URL(href);
  url.searchParams.delete(GOOGLE_OUTCOME_PARAM);
  url.searchParams.set(SHEETS_EDITOR_PARAM, editor);
  return `${url.pathname}${url.search}`;
}

/** What the editor says about the outcome. */
export function googleOutcomeMessage(outcome: GoogleOutcome): {
  ok: boolean;
  text: string;
} {
  switch (outcome) {
    case "connected":
      return { ok: true, text: "Google account connected. Choose or create a spreadsheet below." };
    case "scope":
      return {
        ok: false,
        text: "Google did not give access to your spreadsheets: on Google's page, tick the box that allows access to the Drive files you choose, then connect again.",
      };
    case "cancelled":
      return { ok: false, text: "Connecting was cancelled at Google. Nothing was connected." };
    case "expired":
      return {
        ok: false,
        text: "That connection took too long, or finished in another browser than the one it started in. Connect again.",
      };
    case "failed":
      return { ok: false, text: "Google could not be connected. Try again in a moment." };
  }
}
