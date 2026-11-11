import { describe, expect, it } from "vitest";
import {
  liveResponseBytes,
  liveResponseSummary,
  liveResponseText,
  readLiveResponse,
} from "./live-response";

describe("readLiveResponse", () => {
  it("is null without a response", () => {
    expect(readLiveResponse(undefined)).toBeNull();
    expect(readLiveResponse(null)).toBeNull();
    expect(readLiveResponse("x")).toBeNull();
    expect(readLiveResponse({ status: "200" })).toBeNull();
    expect(readLiveResponse({ status: 42 })).toBeNull();
  });

  it("keeps what is well formed and drops the rest", () => {
    expect(
      readLiveResponse({
        status: 201,
        headers: { "content-type": "application/json", "set-cookie": ["a=1", "b=2"], bad: 3 },
        body: '{"ok":true}',
        bodyTruncated: true,
        bodyEncoding: "something else",
        ms: 33.6,
      })
    ).toEqual({
      status: 201,
      headers: { "content-type": "application/json", "set-cookie": "a=1, b=2" },
      body: '{"ok":true}',
      bodyTruncated: true,
      bodyEncoding: "utf8",
      ms: 34,
      outcome: "answered",
    });
  });

  it("keeps an outcome without an answer", () => {
    expect(readLiveResponse({ status: 502, outcome: "offline" })?.outcome).toBe("offline");
    expect(readLiveResponse({ outcome: "timeout" })?.status).toBeNull();
    expect(readLiveResponse({ status: 200, outcome: "weird" })?.outcome).toBe("answered");
  });
});

describe("liveResponseText", () => {
  it("decodes base64 that is text, and refuses binary", () => {
    const word = `h${String.fromCharCode(0xe9)}llo`;
    const utf8 = btoa(String.fromCharCode(...new TextEncoder().encode(word)));
    const base = readLiveResponse({ status: 200, body: utf8, bodyEncoding: "base64" })!;
    expect(liveResponseText(base)).toBe(word);
    const binary = btoa(String.fromCharCode(0xff, 0xfe, 0x00));
    expect(liveResponseText({ ...base, body: binary })).toBeNull();
    expect(liveResponseBytes({ ...base, body: binary })).toBe(3);
  });

  it("returns text bodies as they are", () => {
    const r = readLiveResponse({ status: 200, body: "plain" })!;
    expect(liveResponseText(r)).toBe("plain");
    expect(liveResponseBytes(r)).toBe(5);
  });
});

describe("liveResponseSummary", () => {
  it("says what the app answered, or why the sender got an error", () => {
    expect(liveResponseSummary(readLiveResponse({ status: 200, ms: 12 })!)).toBe(
      "Your app answered 200 in 12 ms"
    );
    expect(liveResponseSummary(readLiveResponse({ status: 500 })!)).toBe("Your app answered 500");
    expect(liveResponseSummary(readLiveResponse({ status: 504, outcome: "timeout" })!)).toBe(
      "Your app did not answer within 25 seconds: the sender got 504"
    );
    expect(liveResponseSummary(readLiveResponse({ status: 502, outcome: "offline" })!)).toBe(
      "whk tunnel --live was not connected: the sender got 502"
    );
  });
});
