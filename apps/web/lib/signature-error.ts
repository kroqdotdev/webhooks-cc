/**
 * The receiver stores a failed signature check as JSON in
 * `requests.signature_error`. Rows captured before the receiver stopped doing
 * so also hold `expected`: the signature the endpoint's stored secret makes
 * for the body that was sent. Whoever can send to an endpoint and read its
 * captures could sign any payload as the provider with it, so every read
 * drops it until retention has removed those rows.
 */
export function redactSignatureError(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (!raw.includes("expected")) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  if (!("expected" in parsed)) return raw;
  const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete rest.expected;
  return JSON.stringify(rest);
}
