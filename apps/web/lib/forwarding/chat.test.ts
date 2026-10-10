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
