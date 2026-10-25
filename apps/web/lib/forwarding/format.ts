import { isInboundEmailFormat, type InboundEmailFormat } from "@webhooks-cc/sdk/email";
import { isDiscordUrl, isSlackUrl } from "./chat";

/**
 * How one delivery goes out. The owner's setting (`endpoints.forward_format`)
 * overrides; null picks from the URL: Slack and Discord incoming webhooks get
 * the chat message (they need `text` or `content` in a JSON body), anything
 * else gets HTTP requests as received and emails as signed JSON. Emails have
 * no request to relay, so "as received" sends them as signed JSON too. A
 * template (migration 00063) is a JSON body of the owner's own, signed like
 * the JSON format. The inbound provider shapes (migration 00064) are for
 * emails; HTTP requests to such a destination go as received.
 */

export type ForwardFormat = "as_received" | "json" | "chat" | "template" | InboundEmailFormat;

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
  if (setting === "template") return "template";
  if (isInboundEmailFormat(setting)) return kind === "email" ? setting : "as_received";
  if (setting === "as_received") return native;
  return isChatUrl(url) ? "chat" : native;
}
