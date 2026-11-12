/**
 * What a provider answered, in the words the tool pages show. `ok` means the
 * message was posted (or the URL works); `failed` that the provider refused
 * it; `unreadable` that the browser got no answer it could read, so nothing
 * is known either way.
 */
export type AnswerOutcome = "ok" | "failed" | "unreadable";

export interface AnswerExplanation {
  outcome: AnswerOutcome;
  /** One line: what happened. */
  title: string;
  /** What it means and what to do about it. */
  detail: string;
}

/** The provider's answer as the browser read it. */
export interface ProviderAnswer {
  status: number;
  body: string;
}

/** Pretty-printed when the body is JSON, as it came otherwise. */
export function formatAnswerBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}

/** The number of characters as code points, the way length limits are counted here. */
export function characterCount(text: string): number {
  return Array.from(text).length;
}
