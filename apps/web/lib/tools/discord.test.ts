import { describe, expect, it } from "vitest";
import {
  buildDiscordPayload,
  discordCurl,
  discordExecuteUrl,
  discordFieldErrors,
  displayDiscordBody,
  explainDiscordAnswer,
  explainDiscordFailure,
  parseDiscordWebhookUrl,
  type DiscordMessageInput,
} from "./discord";

// Made up: no webhook has this id or token.
const ID = "123456789012345678";
const TOKEN = "abcDEF123_-xyz";
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

function parsed(input: string) {
  const result = parseDiscordWebhookUrl(input);
  if (!result.ok) throw new Error(result.problem);
  return result;
}

function problemOf(input: string): string {
  const result = parseDiscordWebhookUrl(input);
  if (result.ok) throw new Error("expected a problem");
  return result.problem;
}

describe("parseDiscordWebhookUrl", () => {
  it("reads a webhook URL as Discord copies it", () => {
    expect(parsed(`  ${URL_OK}\n`)).toEqual({
      ok: true,
      id: ID,
      token: TOKEN,
      url: URL_OK,
      threadId: null,
    });
  });

  it("sends every Discord host and API version through discord.com", () => {
    for (const input of [
      `https://discordapp.com/api/webhooks/${ID}/${TOKEN}`,
      `https://canary.discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://ptb.discord.com/api/v10/webhooks/${ID}/${TOKEN}/`,
      `https://DISCORD.com/api/webhooks/${ID}/${TOKEN}?wait=true`,
    ]) {
      expect(parsed(input).url).toBe(URL_OK);
    }
  });

  it("keeps a thread id and nothing else from the query", () => {
    const webhook = parsed(`${URL_OK}?thread_id=998877665544332211&wait=false`);
    expect(webhook.threadId).toBe("998877665544332211");
    expect(discordExecuteUrl(webhook)).toBe(`${URL_OK}?wait=true&thread_id=998877665544332211`);
    expect(discordExecuteUrl(parsed(URL_OK))).toBe(`${URL_OK}?wait=true`);
    expect(problemOf(`${URL_OK}?thread_id=general`)).toMatch(/thread_id/);
  });

  it("says what is wrong with anything else", () => {
    expect(problemOf("")).toMatch(/Paste/);
    expect(problemOf("not a url")).toMatch(/not a URL/);
    expect(problemOf(`http://discord.com/api/webhooks/${ID}/${TOKEN}`)).toMatch(/https/);
    expect(problemOf(`https://discord.com.evil.example/api/webhooks/${ID}/${TOKEN}`)).toMatch(
      /not Discord/
    );
    expect(problemOf(`https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`)).toMatch(
      /user name/
    );
    expect(problemOf(`https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`)).toMatch(/port/);
    expect(problemOf("https://hooks.slack.com/services/T0/B0/x")).toMatch(/Slack webhook tester/);
    expect(problemOf("https://discord.com/channels/1/2")).toMatch(/link to a channel/);
    expect(problemOf("https://discord.com/api/users/@me")).toMatch(/not a webhook URL/);
    expect(problemOf(`https://discord.com/api/webhooks/${ID}`)).toMatch(/token.*missing/);
    expect(problemOf(`https://discord.com/api/webhooks/my-hook/${TOKEN}`)).toMatch(/long number/);
    expect(problemOf(`https://discord.com/api/webhooks/${ID}/to%20ken`)).toMatch(/token/);
    expect(problemOf(`${URL_OK}/slack`)).toMatch(/Remove \/slack/);
    expect(problemOf(`${URL_OK}/github`)).toMatch(/Remove \/github/);
    expect(problemOf(`${URL_OK}/messages/1`)).toMatch(/after the token/);
  });
});

const MESSAGE: DiscordMessageInput = {
  content: "Hello",
  username: "",
  embed: null,
  allowMentions: false,
};

function payloadOf(input: DiscordMessageInput) {
  const built = buildDiscordPayload(input);
  if (!built.ok) throw new Error(built.problems.join(" "));
  return built.payload;
}

function problemsOf(input: DiscordMessageInput): string[] {
  const built = buildDiscordPayload(input);
  return built.ok ? [] : built.problems;
}

describe("buildDiscordPayload", () => {
  it("sends the content and pings no one unless asked", () => {
    expect(payloadOf(MESSAGE)).toEqual({ content: "Hello", allowed_mentions: { parse: [] } });
    expect(payloadOf({ ...MESSAGE, allowMentions: true })).toEqual({ content: "Hello" });
  });

  it("adds the name and one embed", () => {
    expect(
      payloadOf({
        ...MESSAGE,
        username: " Deploy bot ",
        embed: {
          title: "Build passed",
          description: "main is green",
          url: "https://example.com/builds/1",
          color: "#5865F2",
        },
      })
    ).toEqual({
      content: "Hello",
      username: "Deploy bot",
      embeds: [
        {
          title: "Build passed",
          description: "main is green",
          url: "https://example.com/builds/1",
          color: 0x5865f2,
        },
      ],
      allowed_mentions: { parse: [] },
    });
  });

  it("sends an embed alone", () => {
    const payload = payloadOf({
      ...MESSAGE,
      content: "   ",
      embed: { title: "Only an embed", description: "", url: "", color: "" },
    });
    expect(payload).not.toHaveProperty("content");
    expect(payload.embeds).toEqual([{ title: "Only an embed" }]);
  });

  it("refuses what Discord would refuse", () => {
    expect(problemsOf({ ...MESSAGE, content: " " })).toEqual([
      "Write a message or add an embed. Discord refuses an empty message.",
    ]);
    expect(problemsOf({ ...MESSAGE, content: "x".repeat(2001) })[0]).toMatch(
      /2,001 characters; Discord takes up to 2,000/
    );
    // An emoji is one character, however many code units it takes.
    expect(problemsOf({ ...MESSAGE, content: "\u{1F600}".repeat(2000) })).toEqual([]);
    const embed = { title: "", description: "", url: "", color: "" };
    expect(problemsOf({ ...MESSAGE, embed })).toContain(
      "The embed needs a title or a description."
    );
    expect(problemsOf({ ...MESSAGE, embed: { ...embed, title: "t".repeat(257) } })[0]).toMatch(
      /embed title is 257/
    );
    expect(
      problemsOf({ ...MESSAGE, embed: { ...embed, description: "d".repeat(4097) } })[0]
    ).toMatch(/embed description is 4,097/);
    expect(problemsOf({ ...MESSAGE, embed: { ...embed, title: "t", url: "example.com" } })).toEqual(
      ["The embed link should be a full URL starting with http:// or https://."]
    );
    expect(problemsOf({ ...MESSAGE, embed: { ...embed, title: "t", color: "blue" } })[0]).toMatch(
      /six hex digits/
    );
  });
});

describe("discordCurl", () => {
  it("quotes the body for a shell", () => {
    const curl = discordCurl(parsed(URL_OK), { content: "it's here" });
    expect(curl).toBe(
      [
        "curl -i -X POST \\",
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"content":"it'\\''s here"}' \\`,
        `  '${URL_OK}?wait=true'`,
      ].join("\n")
    );
  });
});

describe("explainDiscordAnswer", () => {
  const send = (status: number, body: unknown = "") =>
    explainDiscordAnswer(
      { status, body: typeof body === "string" ? body : JSON.stringify(body) },
      "send"
    );

  it("reports a posted message", () => {
    const ok = send(200, { id: "111", channel_id: "222", content: "Hello" });
    expect(ok.outcome).toBe("ok");
    expect(ok.detail).toContain("as message 111 in channel 222");
    expect(send(204).title).toBe("Message posted");
  });

  it("reports a working URL without a post", () => {
    const check = explainDiscordAnswer(
      { status: 200, body: JSON.stringify({ name: "Alerts", channel_id: "222" }) },
      "check"
    );
    expect(check).toEqual({
      outcome: "ok",
      title: "The URL works",
      detail:
        '"Alerts" exists and the token is right. It posts to channel 222. Nothing was posted.',
    });
  });

  it("explains the answers people ask about", () => {
    expect(send(401, { message: "Invalid Webhook Token", code: 50027 }).title).toBe(
      "Invalid webhook token (401)"
    );
    const gone = send(404, { message: "Unknown Webhook", code: 10015 });
    expect(gone.title).toBe("Unknown webhook (404)");
    expect(gone.detail).toMatch(/deleted, or the URL is mistyped/);

    const limited = send(429, {
      message: "You are being rate limited.",
      retry_after: 1.37,
      global: false,
    });
    expect(limited.title).toBe("Rate limited (429)");
    expect(limited.detail).toContain("Wait 2 seconds and send again.");
    expect(send(429, { retry_after: 0.2, global: true }).detail).toContain(
      "this address may call its API"
    );
    expect(send(429, "<html>").detail).toContain("Wait a few seconds");
  });

  it("names the field Discord rejected", () => {
    const bad = send(400, {
      message: "Invalid Form Body",
      code: 50035,
      errors: {
        embeds: {
          "0": { url: { _errors: [{ code: "URL_TYPE", message: "Not a well formed URL." }] } },
        },
      },
    });
    expect(bad.title).toBe("Bad request (400)");
    expect(bad.detail).toBe(
      "Discord did not accept the message. embeds.0.url: Not a well formed URL."
    );
    expect(send(400, { username: ['Username cannot contain "discord"'] }).detail).toBe(
      'Discord did not accept the message. username: Username cannot contain "discord"'
    );
    expect(send(400, "<html>").detail).toContain("Discord could not read the request.");
    expect(
      discordFieldErrors({ a: { _errors: [{ message: "One." }, { message: "Two." }] } })
    ).toEqual(["a: One.", "a: Two."]);
  });

  it("explains an empty message, a forum channel and a server error", () => {
    expect(send(400, { message: "Cannot send an empty message", code: 50006 }).title).toBe(
      "Empty message (400)"
    );
    expect(send(400, { code: 220001 }).detail).toContain("?thread_id=");
    expect(send(400, { code: 50109, message: "The request body contains invalid JSON." })).toEqual({
      outcome: "failed",
      title: "Invalid JSON (400)",
      detail: "Discord did not accept the message. The request body contains invalid JSON.",
    });
    expect(send(502).title).toBe("Discord had a problem (502)");
    expect(send(403, { message: "Missing Access" }).detail).toContain("Missing Access");
    expect(send(418).title).toBe("Discord answered 418");
  });

  it("says when nothing came back", () => {
    expect(explainDiscordFailure(true).outcome).toBe("unreadable");
  });

  it("points to the curl command only when one is shown", () => {
    expect(explainDiscordFailure(true).detail).toContain("curl command below");
    expect(explainDiscordFailure(false).detail).not.toContain("curl");
  });
});

describe("displayDiscordBody", () => {
  it("hides the token and URL a webhook lookup returns", () => {
    const shown = displayDiscordBody(
      JSON.stringify({ id: ID, name: "Alerts", token: TOKEN, url: URL_OK })
    );
    expect(shown).not.toContain(TOKEN);
    expect(JSON.parse(shown)).toEqual({
      id: ID,
      name: "Alerts",
      token: "[hidden]",
      url: "[hidden]",
    });
    expect(displayDiscordBody("not json")).toBe("not json");
  });
});
