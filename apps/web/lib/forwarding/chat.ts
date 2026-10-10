/**
 * The chat message a forwarded request becomes when the destination is a
 * Slack or Discord incoming webhook: the same JSON the receiver's
 * notifications send (apps/receiver-rs/src/handlers/notification_payload.rs),
 * so a forward to Slack reads like a notification but is retried and logged.
 * Both implementations are checked against one set of vectors
 * (notification_vectors.json next to the Rust file); change them together.
 *
 * Slack needs a top-level `text` and reads `&`, `<` and `>` as control
 * characters, so `text` escapes them; Discord reads `content`, unescaped and
 * under 2,000 characters, and `allowed_mentions` keeps `@everyone` silent.
 */

/** Longest path shown in the message; the `path` field keeps it whole. */
const PATH_SHOWN_CHARS = 100;
/** Longest method shown. */
const METHOD_SHOWN_CHARS = 16;
/** Discord rejects `content` over 2,000 characters; stay clear of it. */
const CONTENT_MAX_CHARS = 1_900;
/** The code block's fences and newlines around the body. */
const CODE_BLOCK_CHARS = "\n```\n".length + "\n```".length;
/** Below this much room, a Discord message leaves the body out. */
const MIN_BODY_SHOWN_CHARS = 20;
/** The documented `preview` field. */
export const CHAT_PREVIEW_CHARS = 200;
/** The body excerpt the message shows. */
export const CHAT_MESSAGE_CHARS = 3_000;

export interface ChatFields {
  slug: string;
  method: string;
  path: string;
  ip: string;
  /** RFC 3339 UTC with milliseconds. */
  receivedAt: string;
  preview: string;
  body: string;
  /** The destination, to recognise Discord. */
  targetUrl: string;
}

type Escape = (s: string) => string;

function chars(s: string): string[] {
  return Array.from(s);
}

/** At most `max` characters ending in "..." when cut (the receiver's truncate_preview). */
export function truncatePreview(s: string, max: number): string {
  const all = chars(s);
  if (all.length <= max) return s;
  return `${all.slice(0, Math.max(max - 3, 0)).join("")}...`;
}

/** At most `max` characters, ending in "…" when cut. */
function shorten(s: string, max: number): string {
  const all = chars(s);
  if (all.length <= max) return s;
  return `${all.slice(0, Math.max(max - 1, 0)).join("")}…`;
}

function slackEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function asIs(s: string): string {
  return s;
}

function noBackticks(s: string): string {
  return s.replaceAll("`", "'");
}

function noMarkup(s: string): string {
  return chars(s)
    .filter((c) => /^[A-Za-z0-9_-]$/.test(c))
    .join("");
}

function headline(fields: ChatFields, escape: Escape): string {
  const slug = escape(noMarkup(fields.slug));
  const path = escape(noBackticks(shorten(fields.path, PATH_SHOWN_CHARS)));
  const what =
    fields.method === "EMAIL"
      ? `New email to *${slug}* (\`${path}\`)`
      : `New webhook on *${slug}* (\`${escape(noBackticks(shorten(fields.method, METHOD_SHOWN_CHARS)))} ${path}\`)`;
  return `${what}\nReceived ${fields.receivedAt} (UTC)`;
}

function message(fields: ChatFields, escape: Escape, bodyMax: number): string {
  let text = headline(fields, escape);
  if (fields.body !== "" && bodyMax >= MIN_BODY_SHOWN_CHARS) {
    const body = escape(shorten(fields.body, bodyMax).replaceAll("```", "'''"));
    text += `\n\`\`\`\n${body}\n\`\`\``;
  }
  return text;
}

function discordContent(fields: ChatFields): string {
  const room = Math.max(
    CONTENT_MAX_CHARS - (chars(headline(fields, asIs)).length + CODE_BLOCK_CHARS),
    0
  );
  return shorten(message(fields, asIs, room), CONTENT_MAX_CHARS);
}

/** Discord's webhook hosts (discord.com and discordapp.com, with ptb. and canary.). */
export function isDiscordUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  host = host.replace(/\.+$/, "").toLowerCase();
  return ["discord.com", "discordapp.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/** Slack's incoming webhook host. */
export function isSlackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/\.+$/, "").toLowerCase() === "hooks.slack.com";
  } catch {
    return false;
  }
}

/** The JSON body of a chat delivery. */
export function chatPayload(fields: ChatFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    slug: fields.slug,
    method: fields.method,
    path: fields.path,
    ip: fields.ip,
    receivedAt: fields.receivedAt,
    preview: fields.preview,
    text: message(fields, slackEscape, Number.MAX_SAFE_INTEGER),
    content: discordContent(fields),
  };
  if (isDiscordUrl(fields.targetUrl)) payload.allowed_mentions = { parse: [] };
  return payload;
}
