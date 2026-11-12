import { describe, expect, it } from "vitest";
import {
  buildSlackJsonPayload,
  buildSlackTextPayload,
  explainSlackAnswer,
  explainSlackFailure,
  parseSlackWebhookUrl,
  slackCurl,
  slackFormBody,
} from "./slack";

// Slack's own placeholder shape: no workspace or webhook has these ids.
const URL_OK = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";

function problemOf(input: string): string {
  const result = parseSlackWebhookUrl(input);
  if (result.ok) throw new Error("expected a problem");
  return result.problem;
}

describe("parseSlackWebhookUrl", () => {
  it("reads an incoming webhook URL", () => {
    expect(parseSlackWebhookUrl(` ${URL_OK}/ `)).toEqual({ ok: true, url: URL_OK });
  });

  it("says what is wrong with anything else", () => {
    expect(problemOf("")).toMatch(/Paste/);
    expect(problemOf("hooks.slack.com/services/T0/B0/x")).toMatch(/not a URL/);
    expect(problemOf(URL_OK.replace("https", "http"))).toMatch(/https/);
    expect(problemOf("https://hooks.slack.com.evil.example/services/T0/B0/x")).toMatch(
      /on hooks\.slack\.com\.evil\.example/
    );
    expect(problemOf("https://slack.com/services/T0/B0/x")).toMatch(/on slack\.com/);
    expect(problemOf("https://user:pw@hooks.slack.com/services/T0/B0/x")).toMatch(/user name/);
    expect(problemOf("https://discord.com/api/webhooks/1/abc")).toMatch(/Discord webhook tester/);
    expect(problemOf("https://hooks.slack-gov.com/services/T0/B0/x")).toMatch(/GovSlack/);
    expect(problemOf("https://hooks.slack.com/triggers/T0/123/abc")).toMatch(/workflow webhook/);
    expect(problemOf("https://hooks.slack.com/workflows/T0/A0/123/abc")).toMatch(
      /workflow webhook/
    );
    expect(problemOf("https://hooks.slack.com/services/T0/B0")).toMatch(/three parts/);
    expect(problemOf("https://hooks.slack.com/services/T0/B0/x/y")).toMatch(/three parts/);
    expect(problemOf(`${URL_OK}?payload=1`)).toMatch(/nothing after/);
  });
});

describe("the message", () => {
  it("is the text as written", () => {
    expect(buildSlackTextPayload("Hello, *world*")).toEqual({
      ok: true,
      payload: { text: "Hello, *world*" },
    });
    expect(buildSlackTextPayload("  ")).toEqual({ ok: false, problem: "Write a message to send." });
  });

  it("is the person's own JSON when they write it", () => {
    const blocks = { blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hi" } }] };
    expect(buildSlackJsonPayload(JSON.stringify(blocks))).toEqual({ ok: true, payload: blocks });
    const problem = (json: string) => {
      const built = buildSlackJsonPayload(json);
      return built.ok ? "" : built.problem;
    };
    expect(problem("")).toMatch(/Paste the JSON/);
    expect(problem("{text: 'x'}")).toMatch(/not valid JSON/);
    expect(problem('["text"]')).toMatch(/should be an object/);
    expect(problem('{"channel":"#general"}')).toMatch(/"text", "blocks" or "attachments"/);
  });

  it("travels as the form field `payload`, which needs no preflight", () => {
    const body = slackFormBody({ text: "a & b = c" });
    expect(body.toString()).toBe("payload=%7B%22text%22%3A%22a+%26+b+%3D+c%22%7D");
    expect(JSON.parse(body.get("payload") ?? "")).toEqual({ text: "a & b = c" });
  });

  it("is shown as the JSON request Slack documents", () => {
    expect(slackCurl(URL_OK, { text: "it's here" })).toBe(
      [
        "curl -i -X POST \\",
        "  -H 'Content-type: application/json' \\",
        `  -d '{"text":"it'\\''s here"}' \\`,
        `  '${URL_OK}'`,
      ].join("\n")
    );
  });
});

describe("explainSlackAnswer", () => {
  it("reports a posted message", () => {
    expect(explainSlackAnswer({ status: 200, body: "ok" })).toEqual({
      outcome: "ok",
      title: "Message posted",
      detail: 'Slack answered "ok": the message is in the channel this webhook was made for.',
    });
  });

  it("explains Slack's error words", () => {
    const explain = (status: number, body: string) => explainSlackAnswer({ status, body });
    expect(explain(400, "invalid_payload").title).toBe("invalid_payload (400)");
    expect(explain(400, "invalid_payload\n").detail).toMatch(/could not read the message/);
    expect(explain(404, "no_team").detail).toMatch(/no workspace/);
    expect(explain(404, "channel_not_found").detail).toMatch(/no longer exists/);
    expect(explain(410, "channel_is_archived").detail).toMatch(/archived/);
    expect(explain(403, "action_prohibited").detail).toMatch(/admin/);
    expect(explain(404, "no_service").detail).toMatch(/disabled, removed or invalid/);
    expect(explain(400, "no_text").detail).toMatch(/"text"/);
    expect(explain(500, "rollup_error").title).toBe("rollup_error (500)");
  });

  it("points to the documented request when the body may be to blame", () => {
    const explain = (status: number, body: string) => explainSlackAnswer({ status, body });
    // The browser sends a form field Slack's documentation does not describe.
    expect(explain(400, "invalid_payload").detail).toMatch(/curl command below/);
    expect(explain(400, "no_text").detail).toMatch(/curl command below/);
    expect(explain(404, "no_service").detail).not.toMatch(/curl/);
    expect(explain(410, "channel_is_archived").detail).not.toMatch(/curl/);
  });

  it("explains a rate limit, a server error and an answer it does not know", () => {
    const explain = (status: number, body: string) => explainSlackAnswer({ status, body });
    expect(explain(429, "").detail).toMatch(/one message a second/);
    expect(explain(503, "<html>down</html>").title).toBe("Slack had a problem (503)");
    expect(explain(400, "something_new")).toEqual({
      outcome: "failed",
      title: "Slack answered 400",
      detail: 'Slack did not post the message and answered "something_new".',
    });
    // A property every object has is not an error word.
    expect(explain(400, "constructor").title).toBe("Slack answered 400");
  });

  it("says plainly when the answer could not be read", () => {
    const failure = explainSlackFailure();
    expect(failure.outcome).toBe("unreadable");
    expect(failure.detail).toMatch(/may still have been posted/);
  });
});
