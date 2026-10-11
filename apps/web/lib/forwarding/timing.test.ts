import { describe, expect, it } from "vitest";
import {
  checkSentField,
  describeSenderLag,
  formatDuration,
  parseTimestamp,
  senderTimestamp,
  valueAtPath,
} from "./timing";

const AT = Date.parse("2026-10-10T15:25:09.115Z");

describe("parseTimestamp", () => {
  it("reads RFC 3339 and ISO 8601 date-times", () => {
    expect(parseTimestamp("2026-10-10T15:25:09.115Z")).toEqual({ at: AT, wholeSeconds: false });
    expect(parseTimestamp("2026-10-10T17:25:09.115+02:00")).toEqual({
      at: AT,
      wholeSeconds: false,
    });
    expect(parseTimestamp("2026-10-10T17:25:09.115+0200")).toEqual({ at: AT, wholeSeconds: false });
    expect(parseTimestamp("2026-10-10 15:25:09.115123")).toEqual({ at: AT, wholeSeconds: false });
    expect(parseTimestamp("2026-10-10T15:25:09Z")).toEqual({ at: AT - 115, wholeSeconds: true });
  });

  it("reads epoch numbers in seconds, milliseconds, microseconds and nanoseconds", () => {
    expect(parseTimestamp(1_760_109_909)).toEqual({ at: 1_760_109_909_000, wholeSeconds: true });
    expect(parseTimestamp(1_760_109_909.115)).toEqual({
      at: 1_760_109_909_115,
      wholeSeconds: false,
    });
    expect(parseTimestamp("1760109909115")).toEqual({ at: 1_760_109_909_115, wholeSeconds: false });
    expect(parseTimestamp(1_760_109_909_115_000)).toEqual({
      at: 1_760_109_909_115,
      wholeSeconds: false,
    });
    expect(parseTimestamp(1_760_109_909_115_000_000)).toEqual({
      at: 1_760_109_909_115,
      wholeSeconds: false,
    });
  });

  it("refuses what is not a timestamp", () => {
    for (const value of ["", "soon", "2026-10-10", 42, -1, null, {}, "99999999999999999999999"]) {
      expect(parseTimestamp(value)).toBeNull();
    }
  });
});

describe("valueAtPath", () => {
  it("walks objects and arrays", () => {
    const json = { data: { events: [{ at: 1 }, { at: 2 }] }, "a.b": 3 };
    expect(valueAtPath(json, "data.events.1.at")).toBe(2);
    expect(valueAtPath(json, "data.missing")).toBeUndefined();
    expect(valueAtPath(json, "data.events.x")).toBeUndefined();
    expect(valueAtPath(json, "toString")).toBeUndefined();
  });
});

describe("senderTimestamp", () => {
  const body = JSON.stringify({ Application: "x", PublishTimestamp: "2026-10-10T15:25:09.115Z" });

  it("reads the field the owner named", () => {
    expect(senderTimestamp({ kind: "http", body }, "PublishTimestamp")).toEqual({
      at: AT,
      source: "PublishTimestamp",
      wholeSeconds: false,
    });
  });

  it("falls back to timestamp headers", () => {
    expect(
      senderTimestamp(
        { kind: "http", body, headers: { "webhook-timestamp": "1760109909" } },
        "Nope"
      )
    ).toEqual({ at: 1_760_109_909_000, source: "webhook-timestamp", wholeSeconds: true });
    expect(
      senderTimestamp(
        { kind: "http", headers: { "stripe-signature": "t=1760109909,v1=abc,v0=def" } },
        null
      )
    ).toEqual({ at: 1_760_109_909_000, source: "Stripe-Signature", wholeSeconds: true });
    expect(senderTimestamp({ kind: "http", body: "not json", headers: {} }, "x")).toBeNull();
  });

  it("uses an email's Date header", () => {
    expect(
      senderTimestamp({ kind: "email", emailDate: "Sat, 10 Oct 2026 15:25:09 +0000" }, "x")
    ).toEqual({ at: AT - 115, source: "Date", wholeSeconds: true });
  });
});

describe("describeSenderLag", () => {
  it("gives milliseconds for precise timestamps", () => {
    const sent = { at: AT, source: "PublishTimestamp", wholeSeconds: false };
    expect(describeSenderLag(sent, AT + 197)).toBe("197 ms after PublishTimestamp");
    expect(describeSenderLag(sent, AT + 1234)).toBe("1.23 s after PublishTimestamp");
    expect(describeSenderLag(sent, AT - 35)).toBe("35 ms before PublishTimestamp");
  });

  it("does not invent a fraction for whole seconds", () => {
    const sent = { at: AT - 115, source: "webhook-timestamp", wholeSeconds: true };
    expect(describeSenderLag(sent, AT + 197)).toBe("within 1 s of webhook-timestamp");
    expect(describeSenderLag(sent, AT + 3400)).toBe("about 3 s after webhook-timestamp");
  });
});

describe("formatDuration", () => {
  it("writes durations as the dashboard does", () => {
    expect(formatDuration(143)).toBe("143 ms");
    expect(formatDuration(640)).toBe("640 ms");
    expect(formatDuration(1640)).toBe("1.64 s");
    expect(formatDuration(15_000)).toBe("15.0 s");
    expect(formatDuration(150_000)).toBe("2 min 30 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(83_040_000)).toBe("23 h 4 min");
    expect(formatDuration(93_600_000)).toBe("1 d 2 h");
  });
});

describe("checkSentField", () => {
  it("accepts dotted paths and refuses empty parts", () => {
    expect(checkSentField("PublishTimestamp")).toBeNull();
    expect(checkSentField("data.sent_at")).toBeNull();
    expect(checkSentField("")).not.toBeNull();
    expect(checkSentField("a..b")).not.toBeNull();
    expect(checkSentField("x".repeat(129))).not.toBeNull();
  });
});
