import { describe, expect, it } from "vitest";
import {
  describeAnswer,
  describeRetryWindow,
  describeSenderSource,
  formatAbout,
  formatCappedCount,
  formatClock,
  formatIn,
  formatSenderLag,
  formatTries,
  isConnectionError,
  isTimeoutError,
  leadVerb,
  senderTimeFromRecord,
  targetOfUrl,
} from "./display";

const NOON = Date.UTC(2026, 9, 10, 12, 0, 0);

describe("formatClock", () => {
  it("writes ISO UTC when asked, with or without milliseconds", () => {
    const at = Date.UTC(2026, 9, 10, 15, 25, 9, 874);
    expect(formatClock(at, { utc: true })).toBe("2026-10-10T15:25:09.874Z");
    expect(formatClock(at, { utc: true, wholeSeconds: true })).toBe("2026-10-10T15:25:09Z");
  });

  it("writes local time with milliseconds, and the date only when it is not today", () => {
    const today = new Date(2026, 9, 10, 17, 25, 9, 874).getTime();
    const now = new Date(2026, 9, 10, 18, 0, 0).getTime();
    expect(formatClock(today, { now })).toBe("17:25:09.874");
    expect(formatClock(today, { now, wholeSeconds: true })).toBe("17:25:09");
    const earlier = new Date(2026, 9, 8, 17, 37, 12, 410).getTime();
    expect(formatClock(earlier, { now })).toBe("Oct 8, 17:37:12.410");
  });
});

describe("formatAbout and formatIn", () => {
  it("rounds to the minute", () => {
    expect(formatAbout(new Date(2026, 9, 10, 17, 33, 40).getTime())).toBe("about 17:33");
    expect(formatAbout(Date.UTC(2026, 9, 10, 15, 33, 40), true)).toBe("about 15:33 UTC");
  });

  it("says how far off a moment is", () => {
    expect(formatIn(NOON + 8 * 60_000, NOON)).toBe("in 8 min");
    expect(formatIn(NOON + 30_000, NOON)).toBe("in 30 s");
    expect(formatIn(NOON - 1000, NOON)).toBe("now");
    expect(formatIn(NOON + 3 * 3600_000, NOON)).toBe("in 3 h");
  });
});

describe("answers", () => {
  it("tells a timeout from a connection failure", () => {
    expect(isTimeoutError("No answer within 15 s.")).toBe(true);
    expect(isConnectionError("No answer within 15 s.")).toBe(false);
    expect(isConnectionError("The connection was refused.")).toBe(true);
    expect(isConnectionError("The name could not be resolved.")).toBe(true);
    expect(isConnectionError("TLS certificate problem (CERT_HAS_EXPIRED).")).toBe(true);
  });

  it("labels what the destination answered", () => {
    expect(describeAnswer(200, null, 1)).toEqual({ label: "200", kind: "status" });
    expect(describeAnswer(null, "No answer within 15 s.", 2)).toEqual({
      label: "No answer",
      kind: "timeout",
    });
    expect(describeAnswer(null, "The connection was refused.", 1)).toEqual({
      label: "Unreachable",
      kind: "unreachable",
    });
    expect(describeAnswer(null, null, 0)).toEqual({ label: "...", kind: "none" });
    expect(describeAnswer(null, "The request is too large to forward (over 10 MB).", 1)).toEqual({
      label: "Not sent",
      kind: "refused",
    });
  });
});

describe("sender lag", () => {
  it("reads milliseconds from a body field and whole seconds from a header", () => {
    expect(
      formatSenderLag({ at: NOON, source: "publishedAt", wholeSeconds: false }, NOON + 197)
    ).toBe("197 ms");
    expect(
      formatSenderLag({ at: NOON, source: "Stripe-Signature", wholeSeconds: true }, NOON + 640)
    ).toBe("within 1 s");
    expect(
      formatSenderLag({ at: NOON, source: "Stripe-Signature", wholeSeconds: true }, NOON + 3400)
    ).toBe("about 3 s");
    expect(
      formatSenderLag({ at: NOON, source: "publishedAt", wholeSeconds: false }, NOON - 35)
    ).toBe("-35 ms");
  });

  it("rebuilds a SenderTime from the stored columns", () => {
    expect(senderTimeFromRecord(NOON, "publishedAt")).toEqual({
      at: NOON,
      source: "publishedAt",
      wholeSeconds: false,
    });
    expect(senderTimeFromRecord(NOON, "Stripe-Signature")?.wholeSeconds).toBe(true);
    expect(senderTimeFromRecord(NOON, "Date")?.wholeSeconds).toBe(true);
    expect(senderTimeFromRecord(null, "Date")).toBeNull();
  });

  it("names the source under the Sent stop", () => {
    expect(describeSenderSource("publishedAt")).toBe("from publishedAt");
    expect(describeSenderSource("Stripe-Signature")).toBe("sender's clock, from Stripe-Signature");
    expect(describeSenderSource("Date")).toBe("from the Date header");
  });
});

describe("words", () => {
  it("caps counts the summary stopped counting", () => {
    expect(formatCappedCount(1284)).toBe("1,284");
    expect(formatCappedCount(100_000)).toBe("100,000+");
  });

  it("counts tries and names retry windows", () => {
    expect(formatTries(1)).toBe("1 try");
    expect(formatTries(9)).toBe("9 tries");
    expect(describeRetryWindow(0)).toBe("never retried");
    expect(describeRetryWindow(3600)).toBe("retried for 1 hour");
    expect(describeRetryWindow(86400)).toBe("retried for 1 day");
  });

  it("names the target the way the lead line does", () => {
    expect(targetOfUrl("https://api.example.com/hooks/inbound", "as_received")).toBe(
      "api.example.com/hooks/inbound"
    );
    expect(targetOfUrl("https://api.example.com/", "json")).toBe("api.example.com");
    expect(targetOfUrl("https://hooks.slack.com/services/T0/B0/x", "chat")).toBe("hooks.slack.com");
    expect(targetOfUrl("not a url", "json")).toBeNull();
    expect(leadVerb("chat")).toBe("Posted as a message to");
  });
});
