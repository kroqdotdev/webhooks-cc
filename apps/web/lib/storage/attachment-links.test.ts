import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  publicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://webhooks.cc" }),
}));

const { attachmentLink, verifyAttachmentLink, LINK_LIFETIME_MS } =
  await import("./attachment-links");

const ID = "11111111-2222-4333-8444-555555555555";

describe("attachment links", () => {
  beforeAll(() => {
    process.env.SIGNING_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  });

  it("signs a link that verifies for that attachment only", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    const url = new URL(attachmentLink(ID, 2, now)!);
    expect(url.origin + url.pathname).toBe(`https://webhooks.cc/api/attachments/${ID}/2`);
    const e = url.searchParams.get("e");
    const s = url.searchParams.get("s");
    expect(Number(e) * 1000).toBe(Math.floor((now + LINK_LIFETIME_MS) / 1000) * 1000);
    expect(verifyAttachmentLink(ID, 2, e, s, now)).toBe(true);
    expect(verifyAttachmentLink(ID, 1, e, s, now)).toBe(false);
    expect(verifyAttachmentLink(ID.replace("1", "9"), 2, e, s, now)).toBe(false);
    expect(verifyAttachmentLink(ID, 2, String(Number(e) + 1), s, now)).toBe(false);
  });

  it("refuses expired, malformed and keyless links", () => {
    const url = new URL(attachmentLink(ID, 0, 0)!);
    expect(
      verifyAttachmentLink(ID, 0, url.searchParams.get("e"), url.searchParams.get("s"), Date.now())
    ).toBe(false);
    expect(verifyAttachmentLink(ID, 0, "abc", "x")).toBe(false);
    expect(verifyAttachmentLink(ID, 0, null, null)).toBe(false);
    const saved = process.env.SIGNING_SECRET_KEY;
    delete process.env.SIGNING_SECRET_KEY;
    expect(attachmentLink(ID, 0, Date.now())).toBeNull();
    process.env.SIGNING_SECRET_KEY = saved;
  });
});
