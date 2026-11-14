import { describe, expect, test } from "vitest";
import {
  GOOGLE_OUTCOMES,
  googleOutcomeMessage,
  googleReturnPath,
  readGoogleReturn,
  withoutGoogleReturn,
} from "./google-return";

describe("the way back from connecting a Google account", () => {
  test("names the page and the editor to open again", () => {
    expect(
      googleReturnPath("https://webhooks.cc/dashboard/settings?slug=acme&google=failed", "new")
    ).toBe("/dashboard/settings?slug=acme&sheets=new");
    expect(googleReturnPath("https://webhooks.cc/dashboard?x=1#top", "d-1")).toBe(
      "/dashboard?x=1&sheets=d-1"
    );
  });

  test("reads the outcome and the editor, and nothing else", () => {
    expect(readGoogleReturn("?slug=acme&google=connected&sheets=new")).toEqual({
      outcome: "connected",
      editor: "new",
    });
    expect(readGoogleReturn("?google=scope&sheets=3f1c-ab")).toEqual({
      outcome: "scope",
      editor: "3f1c-ab",
    });
    // Without the editor (an older start): a new Sheets editor.
    expect(readGoogleReturn("?google=expired")).toEqual({ outcome: "expired", editor: "new" });
    expect(readGoogleReturn("?google=pwned&sheets=new")).toBeNull();
    expect(readGoogleReturn("?sheets=new")).toBeNull();
    expect(readGoogleReturn("?google=failed&sheets=../../x")).toEqual({
      outcome: "failed",
      editor: "new",
    });
  });

  test("tidies the address afterwards", () => {
    expect(
      withoutGoogleReturn(
        "https://webhooks.cc/dashboard/settings?slug=acme&google=connected&sheets=new#d"
      )
    ).toBe("/dashboard/settings?slug=acme#d");
  });

  test("says something for every outcome the callback sends", () => {
    for (const outcome of GOOGLE_OUTCOMES) {
      expect(googleOutcomeMessage(outcome).text.length).toBeGreaterThan(10);
    }
    expect(googleOutcomeMessage("connected").ok).toBe(true);
    expect(googleOutcomeMessage("scope").ok).toBe(false);
  });
});
