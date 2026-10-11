import { isDiscordUrl, isSlackUrl } from "./chat";

/**
 * How one delivery goes out. The owner's setting (`endpoints.forward_format`)
 * overrides; null picks from the URL: Slack and Discord incoming webhooks get
 * the chat message (they need `text` or `content` in a JSON body), anything
 * else gets HTTP requests as received and emails as signed JSON. Emails have
 * no request to relay, so "as received" sends them as signed JSON too.
 */

export type ForwardFormat = "as_received" | "json" | "chat";

export function isChatUrl(url: string): boolean {
  return isSlackUrl(url) || isDiscordUrl(url);
}

export function resolveFormat(
  kind: "http" | "email",
  setting: string | null | undefined,
  url: string
): ForwardFormat {
  const native: ForwardFormat = kind === "email" ? "json" : "as_received";
  if (setting === "chat") return "chat";
  if (setting === "json") return "json";
  if (setting === "as_received") return native;
  return isChatUrl(url) ? "chat" : native;
}
