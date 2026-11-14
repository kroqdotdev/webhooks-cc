import { isChatUrl, resolveFormat } from "@/lib/forwarding/format";

/**
 * Fix prompts: a failed delivery handed to a coding agent in one click. The
 * dashboard's failed-delivery view copies the prompt or opens it in T3 Code,
 * and a delivery-failure alert email links to T3 Code when the endpoint
 * names its repository (`endpoints.agent_repo`, migration 00103).
 *
 * The prompt travels in a URL to a third party (and through the clipboard
 * into whatever agent reads it), so it carries ids and the HTTP status, or
 * a kind of network error from a fixed list, and nothing else: no slug, URL,
 * header, body, email address, destination name or error message, nothing a
 * customer or a sender wrote. The agent reads the rest itself, with the
 * account's own credentials, through the MCP server or `whk`.
 *
 * Endpoints that delete requests once they are delivered
 * (`delete_after_delivery`) get no prompt: the request and its deliveries go
 * a few minutes after the last one settles, failed or not, so the ids would
 * name nothing by the time an agent reads them.
 */

/** The fields a prompt is made from; anything else on the delivery is ignored. */
export interface FixPromptDelivery {
  id: string;
  requestId: string;
  /** The last try's HTTP status; null when no answer came. */
  lastStatus: number | null;
  /** The last try's error, only classified, never quoted. */
  lastError: string | null;
}

/** Why a delivery got no HTTP answer, as the prompt names it. */
export type DeliveryErrorKind =
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "dns"
  | "unreachable"
  | "tls"
  | "url_refused"
  | "other";

const ERROR_KIND_WORDS: Record<DeliveryErrorKind, string> = {
  timeout: "a timeout (no answer in time)",
  connection_refused: "a refused connection",
  connection_reset: "a reset connection",
  dns: "a host name that could not be resolved",
  unreachable: "an unreachable host",
  tls: "a TLS certificate error",
  url_refused: "a destination URL that is not allowed",
  other: "an error before any answer",
};

/**
 * The kind of an error the forwarding worker recorded (lib/forwarding/send.ts
 * and target.ts write these), read from its wording; anything unknown is
 * "other". Only the kind ever leaves here.
 */
export function deliveryErrorKind(error: string | null | undefined): DeliveryErrorKind {
  const text = (error ?? "").toLowerCase();
  if (/no answer within|timed? ?out|timeout/.test(text)) return "timeout";
  if (/refused|econnrefused/.test(text)) return "connection_refused";
  if (/\breset\b|econnreset/.test(text)) return "connection_reset";
  if (/could not be resolved|enotfound|eai_again/.test(text)) return "dns";
  if (/could not be reached|ehostunreach|enetunreach/.test(text)) return "unreachable";
  if (/\btls\b|certificate|cert_/.test(text)) return "tls";
  if (/must use https|public host name|port \d+ is not allowed|full url|not allowed/.test(text)) {
    return "url_refused";
  }
  return "other";
}

/**
 * Whether a failed delivery in this format went to a handler someone can fix
 * in a repository: not Google Sheets, a file drop, or a Slack or Discord
 * chat message. Unknown (null, not tried yet) counts as one.
 */
export function takesFixPrompt(format: string | null | undefined): boolean {
  return format !== "sheets" && format !== "file_drop" && format !== "chat";
}

/**
 * The format a failed delivery's prompt decision reads: the one it recorded,
 * else (a failure recorded before formats were) what its destination
 * resolves to now, from the owner's view of its settings, or, for team
 * members, from the origin of the URL it went to (a Slack or Discord host is
 * chat); else unknown, which still takes a prompt.
 */
export function fixPromptFormat(
  recorded: string | null | undefined,
  kind: "http" | "email",
  destination: { format: string | null; url: string } | null,
  deliveredTo: { url: string } | null | undefined
): string | null {
  if (recorded) return recorded;
  if (destination) {
    const setting = destination.format === "auto" ? null : destination.format;
    return resolveFormat(kind, setting, destination.url);
  }
  if (deliveredTo?.url && isChatUrl(deliveredTo.url)) return "chat";
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpStatus(status: number | null | undefined): number | null {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

/**
 * The prompt for a failed delivery, or null when its ids are not ids (so
 * nothing else can ride along in their place). Redelivering is the owner's
 * (`canRedeliver`, the default); a team member's prompt stops at the fix and
 * leaves the redelivery to the owner.
 */
export function buildFixPrompt(
  delivery: FixPromptDelivery,
  { canRedeliver = true }: { canRedeliver?: boolean } = {}
): string | null {
  const id = String(delivery.id ?? "").toLowerCase();
  const requestId = String(delivery.requestId ?? "").toLowerCase();
  if (!UUID.test(id) || !UUID.test(requestId)) return null;
  const status = httpStatus(delivery.lastStatus);
  const failure =
    status !== null ? `status ${status}` : ERROR_KIND_WORDS[deliveryErrorKind(delivery.lastError)];
  return (
    `A webhooks.cc delivery failed with ${failure}. ` +
    "Using the webhooks.cc MCP server or `whk`, " +
    `read delivery ${id} of request ${requestId}, ` +
    (canRedeliver
      ? "find why the handler failed, fix it in this repository, " +
        "then redeliver and confirm it succeeds."
      : "find why the handler failed and fix it in this repository, " +
        "then ask the endpoint's owner to redeliver it.")
  );
}

// GitHub's own rules, which T3 Code's prompt links check too: an owner is
// letters, digits and dashes, not starting with a dash, at most 39; a
// repository name is letters, digits, dots, dashes and underscores, at most
// 100, and not only dots. Mirrored by endpoints_agent_repo_check (00103).
const AGENT_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** Whether the value is a repository as `owner/name`. */
export function isAgentRepo(value: unknown): value is string {
  return typeof value === "string" && AGENT_REPO.test(value) && !/\/\.+$/.test(value);
}

export type AgentRepoInput = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * An `agentRepo` as a client sent it: `owner/name` (spaces around it and a
 * trailing `.git` dropped), or null or "" to clear it.
 */
export function parseAgentRepo(input: unknown): AgentRepoInput {
  if (input === null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: "agentRepo must be owner/name, or null" };
  }
  const value = input.trim().replace(/\.git$/i, "");
  if (value === "") return { ok: true, value: null };
  if (!isAgentRepo(value)) {
    return {
      ok: false,
      error:
        "agentRepo must be a GitHub repository as owner/name: letters, digits and dashes for the owner (at most 39), letters, digits, dots, dashes and underscores for the name (at most 100)",
    };
  }
  return { ok: true, value };
}

export const T3_CODE_ORIGIN = "https://app.t3.codes";

/**
 * A T3 Code prompt link (docs/user/prompt-links.md in pingdotgg/t3code): it
 * opens a draft with the prompt, never runs it. `repo` is left out unless it
 * is a valid `owner/name`.
 */
export function t3CodeLink(prompt: string, repo?: string | null): string {
  const params = [`prompt=${encodeURIComponent(prompt)}`];
  if (repo && isAgentRepo(repo))
    params.push(`repo=${encodeURIComponent(repo).replaceAll("%2F", "/")}`);
  return `${T3_CODE_ORIGIN}/new?${params.join("&")}`;
}
