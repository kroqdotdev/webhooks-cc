import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatPayload, isDiscordUrl, isSlackUrl, truncatePreview, type ChatFields } from "./chat";

// The receiver's notifications and this chat format must say the same thing:
// both are checked against the vectors the Rust implementation wrote.
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../receiver-rs/src/handlers/notification_vectors.json", import.meta.url),
    "utf8"
  )
) as { name: string; fields: ChatFields; payload: Record<string, unknown> }[];

describe("chatPayload", () => {
  it("has vectors to check", () => {
    expect(vectors.length).toBeGreaterThan(5);
  });

  for (const vector of vectors) {
    it(`matches the receiver: ${vector.name}`, () => {
      expect(chatPayload(vector.fields)).toEqual(vector.payload);
    });
  }
});

describe("chat helpers", () => {
  it("recognises Slack and Discord webhook URLs", () => {
    expect(isSlackUrl("https://hooks.slack.com/services/T/B/x")).toBe(true);
    expect(isSlackUrl("https://hooks.slack.com.evil.example/x")).toBe(false);
    expect(isDiscordUrl("https://canary.discord.com/api/webhooks/1/a")).toBe(true);
    expect(isDiscordUrl("https://notdiscord.com/x")).toBe(false);
    expect(isDiscordUrl("not a url")).toBe(false);
  });

  it("truncates like the receiver's preview", () => {
    expect(truncatePreview("hello", 200)).toBe("hello");
    expect(truncatePreview("a".repeat(250), 200)).toBe(`${"a".repeat(197)}...`);
    expect(Array.from(truncatePreview("🎉".repeat(60), 50))).toHaveLength(50);
  });
});

describe("chat message with the sender's time", () => {
  const fields: ChatFields = {
    slug: "order-events",
    method: "POST",
    path: "/",
    ip: "203.0.113.9",
    receivedAt: "2026-10-10T15:25:09.312Z",
    preview: "{}",
    body: "{}",
    targetUrl: "https://hooks.slack.com/services/T/B/x",
  };

  it("says how long after the sender's timestamp it arrived", () => {
    const payload = chatPayload({
      ...fields,
      sent: {
        at: Date.parse("2026-10-10T15:25:09.115Z"),
        source: "PublishTimestamp",
        wholeSeconds: false,
      },
      receivedAtMs: Date.parse(fields.receivedAt),
    });
    expect(payload.text).toContain(
      "Received 2026-10-10T15:25:09.312Z (UTC), 197 ms after PublishTimestamp"
    );
    expect(payload.content).toContain("197 ms after PublishTimestamp");
  });

  it("escapes the source for Slack", () => {
    const payload = chatPayload({
      ...fields,
      sent: { at: Date.parse("2026-10-10T15:25:09.000Z"), source: "a<b>`c", wholeSeconds: false },
      receivedAtMs: Date.parse(fields.receivedAt),
    });
    expect(payload.text).toContain("312 ms after a&lt;b&gt;'c");
    expect(payload.content).toContain("312 ms after a<b>'c");
  });

  it("is the notification message without one", () => {
    expect(chatPayload({ ...fields, sent: null, receivedAtMs: 0 })).toEqual(chatPayload(fields));
  });
});
