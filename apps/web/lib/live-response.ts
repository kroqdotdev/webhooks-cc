/*
 * Reading a live capture's answer (`whk tunnel --live`) for display: what
 * the app behind the tunnel answered, or what stood in for an answer when it
 * could not. The request API already shapes it (`toLiveResponse()` in
 * lib/supabase/requests.ts); this reads it defensively again, because older
 * servers and search results may carry none or an older shape.
 */

/**
 * The API's `liveResponse` on a request (the same shape as
 * `LiveResponseRecord` in lib/supabase/requests.ts): `status` is what the
 * sender got, `outcome` whether the app answered or why not, `body` the first
 * 64 KB as UTF-8 text or base64.
 */
export interface LiveResponse {
  status: number | null;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  bodyEncoding: "utf8" | "base64";
  ms: number | null;
  outcome: "answered" | "offline" | "timeout" | "unreachable" | "busy" | "refused";
}

const OUTCOMES = new Set<LiveResponse["outcome"]>([
  "answered",
  "offline",
  "timeout",
  "unreachable",
  "busy",
  "refused",
]);

/** The response from an API value, or null when there is none or it is malformed. */
export function readLiveResponse(value: unknown): LiveResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const status =
    typeof raw.status === "number" &&
    Number.isInteger(raw.status) &&
    raw.status >= 100 &&
    raw.status <= 599
      ? raw.status
      : null;
  const outcome = OUTCOMES.has(raw.outcome as LiveResponse["outcome"])
    ? (raw.outcome as LiveResponse["outcome"])
    : "answered";
  if (status === null && outcome === "answered") return null;
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    for (const [name, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[name] = v;
      else if (Array.isArray(v)) headers[name] = v.filter((x) => typeof x === "string").join(", ");
    }
  }
  return {
    status,
    headers,
    body: typeof raw.body === "string" ? raw.body : "",
    bodyTruncated: raw.bodyTruncated === true,
    bodyEncoding: raw.bodyEncoding === "base64" ? "base64" : "utf8",
    ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) ? Math.round(raw.ms) : null,
    outcome,
  };
}

/**
 * The body as text to show: text as it is, base64 decoded when the bytes are
 * valid UTF-8. Null when the body is binary (shown as a size instead).
 */
export function liveResponseText(response: LiveResponse): string | null {
  if (response.bodyEncoding !== "base64") return response.body;
  try {
    const binary = atob(response.body);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The body's size in bytes as stored (after any truncation). */
export function liveResponseBytes(response: LiveResponse): number {
  if (response.bodyEncoding === "base64") {
    const clean = response.body.replace(/=+$/, "");
    return Math.floor((clean.length * 3) / 4);
  }
  return new TextEncoder().encode(response.body).length;
}

/** One line on what happened: the app's answer, or why the sender got an error instead. */
export function liveResponseSummary(response: LiveResponse): string {
  const took = response.ms === null ? "" : ` in ${response.ms} ms`;
  const sent = response.status === null ? "" : `: the sender got ${response.status}`;
  switch (response.outcome) {
    case "offline":
      return `whk tunnel --live was not connected${sent}`;
    case "timeout":
      return `Your app did not answer within 25 seconds${sent}`;
    case "unreachable":
      return `Nothing answered on your local port${sent}`;
    case "busy":
      return `Too many requests were waiting for your app${sent}`;
    case "refused":
      return `The request's path was not relayed${sent}`;
    default:
      return `Your app answered ${response.status ?? ""}${took}`.replace(/ {2,}/g, " ");
  }
}
