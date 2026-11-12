import {
  characterCount,
  formatAnswerBody,
  type AnswerExplanation,
  type ProviderAnswer,
} from "./answer";
import { curlCommand, shellQuote } from "./curl";

/**
 * The Discord webhook tester's logic: reading a webhook URL, building the
 * Execute Webhook body, and saying what Discord's answer means. Limits and
 * error codes are from Discord's developer documentation (Webhook resource,
 * Message resource, Rate Limits, Opcodes and Status Codes), read 2026-11-12.
 *
 * Nothing here talks to the network; the component sends the request from
 * the browser straight to Discord.
 */

/** The one origin requests go to, and the only Discord origin the page's CSP allows. */
export const DISCORD_ORIGIN = "https://discord.com";

/** Hosts that serve the same webhook API; every one is sent through discord.com. */
const DISCORD_HOSTS: ReadonlySet<string> = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
  "canary.discordapp.com",
  "ptb.discordapp.com",
]);

export const DISCORD_CONTENT_MAX = 2000;
export const DISCORD_EMBED_TITLE_MAX = 256;
export const DISCORD_EMBED_DESCRIPTION_MAX = 4096;

export const DISCORD_URL_EXAMPLE = "https://discord.com/api/webhooks/1234567890/AbCdEf...";

export interface DiscordWebhook {
  id: string;
  token: string;
  /** https://discord.com/api/webhooks/{id}/{token}, whatever host and API version were pasted. */
  url: string;
  /** From a `thread_id` in the pasted URL: the thread the message goes to. */
  threadId: string | null;
}

export type ParsedDiscordWebhook = ({ ok: true } & DiscordWebhook) | { ok: false; problem: string };

function problem(text: string): ParsedDiscordWebhook {
  return { ok: false, problem: text };
}

/** Reads a pasted Discord webhook URL, or says what is wrong with it. */
export function parseDiscordWebhookUrl(input: string): ParsedDiscordWebhook {
  const text = input.trim();
  if (!text) return problem("Paste a Discord webhook URL.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return problem(`This is not a URL. A Discord webhook URL looks like ${DISCORD_URL_EXAMPLE}`);
  }
  if (url.protocol !== "https:") {
    return problem("A Discord webhook URL starts with https://.");
  }
  if (url.username || url.password || url.port) {
    return problem("A Discord webhook URL has no user name, password or port.");
  }

  const host = url.hostname.toLowerCase();
  if (host === "hooks.slack.com") {
    return problem("This is a Slack webhook URL. Use the Slack webhook tester for it.");
  }
  if (!DISCORD_HOSTS.has(host)) {
    return problem(
      `This URL is on ${host}, not Discord. A Discord webhook URL looks like ${DISCORD_URL_EXAMPLE}`
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  const match = /^\/api(?:\/v\d+)?\/webhooks\/([^/]+)(?:\/([^/]+))?(?:\/(.+))?$/.exec(path);
  if (!match) {
    if (path.startsWith("/channels/")) {
      return problem(
        "This is a link to a channel, not a webhook URL. In Discord, open the channel's settings, then Integrations, Webhooks, and Copy Webhook URL."
      );
    }
    return problem(
      `This is a Discord address, but not a webhook URL. One looks like ${DISCORD_URL_EXAMPLE}`
    );
  }

  const [, id, token, rest] = match;
  if (!/^\d{15,22}$/.test(id)) {
    return problem("The webhook id (the first part after /webhooks/) should be a long number.");
  }
  if (!token) {
    return problem("The URL ends after the webhook id. The token that follows it is missing.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return problem("The token (the last part of the URL) has characters a token never has.");
  }
  if (rest === "slack" || rest === "github") {
    return problem(
      `This is the webhook's ${rest === "slack" ? "Slack" : "GitHub"}-compatible address. Remove /${rest} from the end to test the webhook itself.`
    );
  }
  if (rest) {
    return problem("The URL has something after the token. Copy the webhook URL again.");
  }

  const threadId = url.searchParams.get("thread_id");
  if (threadId !== null && !/^\d{15,22}$/.test(threadId)) {
    return problem("The thread_id in the URL should be a long number.");
  }

  return { ok: true, id, token, url: `${DISCORD_ORIGIN}/api/webhooks/${id}/${token}`, threadId };
}

/** Where the message is posted: `wait=true`, so Discord answers with the saved message. */
export function discordExecuteUrl(webhook: DiscordWebhook): string {
  const params = new URLSearchParams({ wait: "true" });
  if (webhook.threadId) params.set("thread_id", webhook.threadId);
  return `${webhook.url}?${params.toString()}`;
}

export interface DiscordEmbedInput {
  title: string;
  description: string;
  url: string;
  /** #rrggbb, or empty for Discord's default. */
  color: string;
}

export interface DiscordMessageInput {
  content: string;
  /** Overrides the webhook's name for this message; empty keeps it. */
  username: string;
  /** Null when the message has no embed. */
  embed: DiscordEmbedInput | null;
  /** Off by default, so a test never pings @everyone, a role or a person. */
  allowMentions: boolean;
}

export type DiscordPayload = Record<string, unknown>;

export type BuiltDiscordPayload =
  { ok: true; payload: DiscordPayload } | { ok: false; problems: string[] };

function over(name: string, text: string, max: number): string | null {
  const count = characterCount(text);
  return count > max
    ? `${name} is ${count.toLocaleString("en-US")} characters; Discord takes up to ${max.toLocaleString("en-US")}.`
    : null;
}

/** The Execute Webhook JSON body for a message, or what stops it being sent. */
export function buildDiscordPayload(input: DiscordMessageInput): BuiltDiscordPayload {
  const problems: string[] = [];
  const payload: DiscordPayload = {};

  const content = input.content.trim() ? input.content : "";
  if (content) {
    const tooLong = over("The message", content, DISCORD_CONTENT_MAX);
    if (tooLong) problems.push(tooLong);
    payload.content = content;
  }

  const username = input.username.trim();
  if (username) payload.username = username;

  if (input.embed) {
    const embed: Record<string, unknown> = {};
    const title = input.embed.title.trim();
    const description = input.embed.description.trim();
    const link = input.embed.url.trim();
    const color = input.embed.color.trim();

    if (title) embed.title = title;
    if (description) embed.description = description;
    if (!title && !description) {
      problems.push("The embed needs a title or a description.");
    }
    for (const tooLong of [
      over("The embed title", title, DISCORD_EMBED_TITLE_MAX),
      over("The embed description", description, DISCORD_EMBED_DESCRIPTION_MAX),
    ]) {
      if (tooLong) problems.push(tooLong);
    }
    if (link) {
      if (/^https?:\/\/\S+$/i.test(link)) embed.url = link;
      else problems.push("The embed link should be a full URL starting with http:// or https://.");
    }
    if (color) {
      if (/^#?[0-9a-f]{6}$/i.test(color)) embed.color = parseInt(color.replace("#", ""), 16);
      else problems.push("The embed colour should be six hex digits, such as #5865F2.");
    }
    payload.embeds = [embed];
  }

  if (!payload.content && !payload.embeds) {
    problems.push("Write a message or add an embed. Discord refuses an empty message.");
  }
  if (!input.allowMentions) payload.allowed_mentions = { parse: [] };

  return problems.length > 0 ? { ok: false, problems } : { ok: true, payload };
}

/** The same request as a curl command. */
export function discordCurl(webhook: DiscordWebhook, payload: DiscordPayload): string {
  return curlCommand([
    "-H 'Content-Type: application/json'",
    `-d ${shellQuote(JSON.stringify(payload))}`,
    shellQuote(discordExecuteUrl(webhook)),
  ]);
}

interface DiscordErrorBody {
  message?: unknown;
  code?: unknown;
  retry_after?: unknown;
  global?: unknown;
  errors?: unknown;
}

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Discord's nested `errors` object as lines: "embeds.0.url: Not a well formed
 * URL." A field's problems sit in an `_errors` list, or (for a few fields) in
 * a plain list of strings.
 */
export function discordFieldErrors(errors: unknown, path = ""): string[] {
  if (Array.isArray(errors)) {
    const lines = errors.filter((item): item is string => typeof item === "string");
    return lines.map((line) => (path ? `${path}: ${line}` : line));
  }
  if (!errors || typeof errors !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(errors)) {
    if (key === "_errors" && Array.isArray(value)) {
      for (const item of value) {
        const message = (item as { message?: unknown } | null)?.message;
        if (typeof message === "string") out.push(path ? `${path}: ${message}` : message);
      }
    } else {
      out.push(...discordFieldErrors(value, path ? `${path}.${key}` : key));
    }
  }
  return out;
}

function seconds(value: number): string {
  const rounded = Math.max(1, Math.ceil(value));
  return rounded === 1 ? "1 second" : `${rounded} seconds`;
}

const COPY_AGAIN =
  "Copy the URL again from the channel's settings (Integrations, Webhooks, Copy Webhook URL).";

/**
 * What Discord's answer to a send (or to a check of the URL) means.
 * `action` is "send" for Execute Webhook and "check" for the GET that reads
 * the webhook without posting.
 */
export function explainDiscordAnswer(
  answer: ProviderAnswer,
  action: "send" | "check"
): AnswerExplanation {
  const { status } = answer;
  const body = (parseBody(answer.body) ?? {}) as DiscordErrorBody & Record<string, unknown>;
  const code = typeof body.code === "number" ? body.code : null;
  const message = typeof body.message === "string" ? body.message : "";

  if (status === 200 && action === "check") {
    const name = typeof body.name === "string" && body.name ? `"${body.name}"` : "The webhook";
    const channel =
      typeof body.channel_id === "string" ? ` It posts to channel ${body.channel_id}.` : "";
    return {
      outcome: "ok",
      title: "The URL works",
      detail: `${name} exists and the token is right.${channel} Nothing was posted.`,
    };
  }
  if (status === 200 || status === 204) {
    const id = typeof body.id === "string" ? ` as message ${body.id}` : "";
    const channel = typeof body.channel_id === "string" ? ` in channel ${body.channel_id}` : "";
    return {
      outcome: "ok",
      title: "Message posted",
      detail: `Discord saved the message${id}${channel}. Check the channel to see how it looks.`,
    };
  }

  if (status === 429) {
    const wait = typeof body.retry_after === "number" ? body.retry_after : null;
    return {
      outcome: "failed",
      title: "Rate limited (429)",
      detail: `Discord is limiting how fast ${body.global === true ? "this address may call its API" : "this webhook may be used"}. ${wait !== null ? `Wait ${seconds(wait)} and send again.` : "Wait a few seconds and send again."} Nothing was posted.`,
    };
  }

  if (status === 404 || code === 10015) {
    return {
      outcome: "failed",
      title: "Unknown webhook (404)",
      detail: `Discord has no webhook with this id: it was deleted, or the URL is mistyped. ${COPY_AGAIN} Discord asks that a webhook answering 404 is not tried again and again.`,
    };
  }

  if (status === 401 || code === 50027) {
    return {
      outcome: "failed",
      title: "Invalid webhook token (401)",
      detail: `The webhook exists, but the token (the last part of the URL) is wrong: it was mistyped, cut short, or the webhook's URL was regenerated. ${COPY_AGAIN}`,
    };
  }

  if (status === 403) {
    return {
      outcome: "failed",
      title: "Forbidden (403)",
      detail: `Discord refused the request${message ? `: ${message}` : ""}. The webhook may no longer be allowed to post where it points.`,
    };
  }

  if (status === 400) {
    if (code === 50006) {
      return {
        outcome: "failed",
        title: "Empty message (400)",
        detail:
          "Discord refuses a message with no content and no embed. Write a message or fill in the embed.",
      };
    }
    if (code === 220001) {
      return {
        outcome: "failed",
        title: "Forum channel needs a thread (400)",
        detail:
          "This webhook posts to a forum or media channel, where every message belongs to a thread. Add ?thread_id= and the thread's id to the end of the webhook URL to post in an existing thread. (Discord can also start a new thread from a thread_name in the body, which this tester does not send.)",
      };
    }
    if (code === 220003) {
      return {
        outcome: "failed",
        title: "Not a forum channel (400)",
        detail: "Only a webhook in a forum or media channel can start a thread.",
      };
    }
    // Field problems sit under `errors`, or (for a few fields) at the top level.
    const rest = Object.fromEntries(
      Object.entries(body).filter(([key]) => !["errors", "message", "code"].includes(key))
    );
    const nested = discordFieldErrors(body.errors);
    const fields = nested.length > 0 ? nested : discordFieldErrors(rest);
    const reason =
      fields.length > 0 ? fields.join(" ") : message || "Discord could not read the request.";
    return {
      outcome: "failed",
      title: code === 50109 ? "Invalid JSON (400)" : "Bad request (400)",
      detail: `Discord did not accept the message. ${reason}`,
    };
  }

  if (status === 413 || code === 40005) {
    return {
      outcome: "failed",
      title: "Too large (413)",
      detail: "The request is larger than Discord accepts. Send something smaller.",
    };
  }

  if (status >= 500) {
    return {
      outcome: "failed",
      title: `Discord had a problem (${status})`,
      detail:
        "The error is on Discord's side, and such errors are rare. Wait a moment and send again.",
    };
  }

  return {
    outcome: "failed",
    title: `Discord answered ${status}`,
    detail: message || "Discord did not accept the request.",
  };
}

/** No answer at all: the request failed before the browser could read one. */
export function explainDiscordFailure(withCurl: boolean): AnswerExplanation {
  const blocked =
    "The request did not get through: you may be offline, or a browser extension, firewall or network filter is blocking discord.com. Nothing here was sent to webhooks.cc either.";
  return {
    outcome: "unreadable",
    title: "No answer from Discord",
    detail: withCurl
      ? `${blocked} The curl command below makes the same request from a terminal.`
      : blocked,
  };
}

/**
 * Discord's answer for display. Reading a webhook returns its token and full
 * URL again, which the page has no reason to show: both are hidden.
 */
export function displayDiscordBody(body: string): string {
  const parsed = parseBody(body);
  if (!parsed) return body;
  for (const key of ["token", "url"]) {
    if (key in parsed) parsed[key] = "[hidden]";
  }
  return formatAnswerBody(JSON.stringify(parsed));
}
