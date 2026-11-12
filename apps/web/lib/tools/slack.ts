import type { AnswerExplanation, ProviderAnswer } from "./answer";
import { curlCommand, shellQuote } from "./curl";

/**
 * The Slack webhook tester's logic: reading an incoming webhook URL,
 * building the message, and saying what Slack's answer means. Error names
 * and the rate limit are from Slack's documentation ("Sending messages using
 * incoming webhooks", the 2016 changelog on webhook errors, "Rate limits"),
 * the text lengths from chat.postMessage, and workflow webhook URLs from
 * Slack's help centre, all read 2026-11-12.
 *
 * How the browser sends it. Slack documents one request: the JSON as the
 * body, with `Content-type: application/json`. A page on another site may
 * only send that header after the browser has asked the server for
 * permission (a CORS preflight), and hooks.slack.com refuses it (checked
 * 2026-11-12: the OPTIONS request gets a 404 with no
 * Access-Control-Allow-Headers). So the tool sends the JSON as a form field
 * named `payload` (application/x-www-form-urlencoded), which needs no
 * preflight. Slack accepts that form, but its current documentation does not
 * describe it, so the page says so and always shows the documented request
 * as a curl command. Slack's answers carry `Access-Control-Allow-Origin: *`
 * (checked the same day), so the page may read them; if the browser cannot
 * read one after all, the tool says so instead of guessing.
 */

/** The only origin requests go to, and the only Slack origin the page's CSP allows. */
export const SLACK_HOOKS_ORIGIN = "https://hooks.slack.com";

export const SLACK_URL_EXAMPLE = "https://hooks.slack.com/services/T000/B000/XXXX";

/** Slack's advice for a message's text (chat.postMessage); longer text is cut off at 40,000. */
export const SLACK_TEXT_ADVISED_MAX = 4000;
export const SLACK_TEXT_MAX = 40000;

export type ParsedSlackWebhook = { ok: true; url: string } | { ok: false; problem: string };

function problem(text: string): ParsedSlackWebhook {
  return { ok: false, problem: text };
}

/** Reads a pasted Slack incoming webhook URL, or says what is wrong with it. */
export function parseSlackWebhookUrl(input: string): ParsedSlackWebhook {
  const text = input.trim();
  if (!text) return problem("Paste a Slack incoming webhook URL.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return problem(`This is not a URL. A Slack webhook URL looks like ${SLACK_URL_EXAMPLE}`);
  }
  if (url.protocol !== "https:") {
    return problem("A Slack webhook URL starts with https://.");
  }
  if (url.username || url.password || url.port) {
    return problem("A Slack webhook URL has no user name, password or port.");
  }

  const host = url.hostname.toLowerCase();
  if (/(^|\.)discord(app)?\.com$/.test(host)) {
    return problem("This is a Discord webhook URL. Use the Discord webhook tester for it.");
  }
  if (host === "hooks.slack-gov.com") {
    return problem(
      "This is a GovSlack webhook, which this tool does not send to. Use the curl command with your own URL instead."
    );
  }
  if (host !== "hooks.slack.com") {
    return problem(
      `This URL is on ${host}. A Slack incoming webhook URL is on hooks.slack.com and looks like ${SLACK_URL_EXAMPLE}`
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (/^\/(triggers|workflows)\//.test(path)) {
    return problem(
      "This is a workflow webhook, not an incoming webhook. It starts a workflow with the variables that workflow defines rather than posting a message, so this tester cannot send to it."
    );
  }
  if (!/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(path)) {
    return problem(
      `This is a Slack address, but not an incoming webhook URL. One has three parts after /services/: ${SLACK_URL_EXAMPLE}`
    );
  }
  if (url.search || url.hash) {
    return problem("A Slack webhook URL has nothing after its last part. Copy it again.");
  }

  return { ok: true, url: `${SLACK_HOOKS_ORIGIN}${path}` };
}

export type SlackPayload = Record<string, unknown>;

export type BuiltSlackPayload =
  { ok: true; payload: SlackPayload } | { ok: false; problem: string };

/** The message for plain text. */
export function buildSlackTextPayload(text: string): BuiltSlackPayload {
  if (!text.trim()) return { ok: false, problem: "Write a message to send." };
  return { ok: true, payload: { text } };
}

/** The message from JSON the person wrote themselves (blocks, attachments). */
export function buildSlackJsonPayload(json: string): BuiltSlackPayload {
  if (!json.trim()) return { ok: false, problem: "Paste the JSON to send." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "it could not be read";
    return { ok: false, problem: `This is not valid JSON: ${reason}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      problem: 'The JSON should be an object, such as {"text": "Hello"}.',
    };
  }
  const payload = parsed as SlackPayload;
  if (!("text" in payload) && !("blocks" in payload) && !("attachments" in payload)) {
    return {
      ok: false,
      problem: 'The JSON needs a "text", "blocks" or "attachments" field for Slack to post.',
    };
  }
  return { ok: true, payload };
}

/**
 * The request body the browser sends: the JSON as the form field `payload`.
 * A URLSearchParams body gives the request the form content type, one of the
 * few a page may send to another site without a preflight.
 */
export function slackFormBody(payload: SlackPayload): URLSearchParams {
  return new URLSearchParams({ payload: JSON.stringify(payload) });
}

/** The request as Slack documents it, as a curl command. */
export function slackCurl(url: string, payload: SlackPayload): string {
  return curlCommand([
    "-H 'Content-type: application/json'",
    `-d ${shellQuote(JSON.stringify(payload))}`,
    shellQuote(url),
  ]);
}

/** Slack's documented error words, and what each one means for the person testing. */
const SLACK_ERRORS: Readonly<Record<string, string>> = {
  invalid_payload:
    "Slack could not read the message: the JSON is malformed or has fields of the wrong kind. Correct it before sending again.",
  no_text: 'The message has no "text" field. Add one, also when the message is made of blocks.',
  invalid_blocks:
    "The blocks in this message are not valid Block Kit. Check each block's type and required fields.",
  too_many_attachments: "The message has more than 100 attachments, the most Slack takes.",
  user_not_found: "The user this message names does not exist in the workspace.",
  channel_not_found:
    "The channel this webhook posts to no longer exists. Create a new webhook for a channel that does.",
  channel_is_archived:
    "The channel has been archived and takes no more messages, from this webhook or anyone. Unarchive it, or create a webhook for another channel.",
  action_prohibited:
    "The workspace restricts this webhook from posting here, by an admin setting. Sending again will not help; ask a workspace admin.",
  posting_to_general_channel_denied:
    "Posting to #general is restricted in this workspace, and the person who made the webhook is not allowed to.",
  no_service:
    "The webhook is disabled, removed or invalid: the last two parts of the URL match no webhook. It may have been deleted or revoked (Slack revokes webhook URLs it finds published). Create a new one.",
  no_service_id: "The webhook part of the URL (the part starting with B) is missing or invalid.",
  no_active_hooks: "The incoming webhook is disabled. Turn it back on in the app's settings.",
  no_team:
    "Slack found no workspace for this URL: the first part after /services/ (starting with T) is wrong. Copy the URL again.",
  team_disabled: "The workspace this webhook belongs to is no longer active.",
  invalid_token: "The secret at the end of the URL is expired, invalid or missing.",
  rollup_error:
    "Something went wrong on Slack's side, probably through no fault of the message. Wait a moment and send again.",
};

/** Errors about the message's body, where the way the browser sends it could matter. */
const FORM_SENSITIVE: ReadonlySet<string> = new Set(["invalid_payload", "no_text"]);

/** What Slack's answer to a send means. */
export function explainSlackAnswer(answer: ProviderAnswer): AnswerExplanation {
  const { status } = answer;
  const word = answer.body.trim();

  if (status === 200) {
    return {
      outcome: "ok",
      title: "Message posted",
      detail:
        word === "ok"
          ? 'Slack answered "ok": the message is in the channel this webhook was made for.'
          : "Slack accepted the message.",
    };
  }

  if (status === 429) {
    return {
      outcome: "failed",
      title: "Rate limited (429)",
      detail:
        "Slack takes about one message a second from an incoming webhook, with short bursts allowed. Wait a few seconds and send again. Nothing was posted.",
    };
  }

  const known = Object.hasOwn(SLACK_ERRORS, word) ? SLACK_ERRORS[word] : undefined;
  if (known) {
    // The browser sends the JSON as a form field, which Slack's documentation
    // does not describe: if the message looks right, the documented request
    // settles whether the form is to blame.
    const viaForm = FORM_SENSITIVE.has(word)
      ? " If the JSON looks right, run the curl command below, which sends it the way Slack documents."
      : "";
    return { outcome: "failed", title: `${word} (${status})`, detail: known + viaForm };
  }

  if (status >= 500) {
    return {
      outcome: "failed",
      title: `Slack had a problem (${status})`,
      detail: "The error is on Slack's side. Wait a moment and send again.",
    };
  }

  return {
    outcome: "failed",
    title: `Slack answered ${status}`,
    detail:
      word && word.length <= 200
        ? `Slack did not post the message and answered "${word}".`
        : "Slack did not post the message.",
  };
}

/** The request left, but the browser could not read what Slack answered. */
export function explainSlackFailure(): AnswerExplanation {
  return {
    outcome: "unreadable",
    title: "The browser could not read Slack's answer",
    detail:
      "Either the request did not get through (you are offline, or an extension, firewall or network filter blocks hooks.slack.com), or Slack answered in a way a web page is not allowed to read. The message may still have been posted, so check the channel. To see Slack's answer, run the curl command below in a terminal.",
  };
}
