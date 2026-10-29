import { describe, expect, it } from "vitest";
import { attachmentFilename } from "./attachments";

describe("attachmentFilename", () => {
  it("cuts a long name without splitting a surrogate pair", () => {
    const name = `${"a".repeat(254)}${String.fromCodePoint(0x1f600)}tail`;
    const cut = attachmentFilename(
      { filename: name, contentType: "text/plain", size: 1, contentId: null, inline: false },
      0
    );
    expect(cut).toBe("a".repeat(254));
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  it("names an attachment without a name by its position", () => {
    expect(
      attachmentFilename(
        { filename: "  ", contentType: "text/plain", size: 1, contentId: null, inline: false },
        2
      )
    ).toBe("attachment-3");
  });
});
