import {
  RESPONSE_TEMPLATE_ROOTS,
  renderTemplate,
  responseTemplateMode,
  unknownPlaceholders,
  type MockResponse,
  type ResponseRule,
} from "@webhooks-cc/sdk";
import { templateContextFor, ruleSubjectFor } from "./request-context";
import { conditionsHold } from "./rules";
import type { RequestRecord } from "./supabase/requests";

/**
 * What a sender would get back for a captured request: which rule matches,
 * and the response with its placeholders filled in. The receiver does this
 * in Rust when the request arrives (apps/receiver-rs/src/handlers/rules.rs
 * and placeholders.rs); both pass the same vectors, so the preview says what
 * the receiver sends.
 */

export interface ResponsePreview {
  /** The rule that matched (its position from 0), or null for the default response. */
  rule: { index: number; name: string | null } | null;
  /** The response sent; null means the plain `200 OK` (no mock response set). */
  response: { status: number; headers: Record<string, string>; body: string; delay: number } | null;
  /** Placeholders the receiver leaves as written, for a hint about typos. */
  unknownPlaceholders: string[];
  /** Emails get a standard mail-server reply, never a mock response. */
  email: boolean;
}

/** The largest body placeholders may produce (as in the receiver). */
const MAX_FILLED_BODY_BYTES = 1024 * 1024;
const MAX_HEADER_VALUE_BYTES = 8192;

function fill(
  mock: MockResponse,
  context: Record<string, unknown>,
  generated: { uuid: string; now: string }
): NonNullable<ResponsePreview["response"]> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(mock.headers ?? {})) {
    const filled = renderTemplate(value, context, {
      ...generated,
      mode: "text",
      maxBytes: MAX_HEADER_VALUE_BYTES + 1,
    });
    // The receiver drops headers that end up too long or hold a line break.
    if (filled.length > MAX_HEADER_VALUE_BYTES || /[\r\n]/.test(filled)) continue;
    headers[name] = filled;
  }
  return {
    status: mock.status,
    headers,
    body: renderTemplate(mock.body ?? "", context, {
      ...generated,
      mode: responseTemplateMode(mock.body ?? "", mock.headers),
      maxBytes: MAX_FILLED_BODY_BYTES,
    }),
    delay: Math.min(Math.max(mock.delay ?? 0, 0), 30_000),
  };
}

function placeholdersIn(mock: MockResponse | null | undefined): string[] {
  if (!mock) return [];
  return [mock.body ?? "", ...Object.values(mock.headers ?? {})].flatMap((text) =>
    unknownPlaceholders(text, RESPONSE_TEMPLATE_ROOTS)
  );
}

export function previewResponse(
  settings: { mockResponse: MockResponse | null; responseRules: ResponseRule[] | null },
  request: RequestRecord,
  endpoint: { slug: string; name: string | null },
  generated: { uuid: string; now: string } = {
    uuid: crypto.randomUUID(),
    now: new Date().toISOString(),
  }
): ResponsePreview {
  const rules = settings.responseRules ?? [];
  const unknown = [
    ...new Set([
      ...placeholdersIn(settings.mockResponse),
      ...rules.flatMap((rule) => placeholdersIn(rule.response)),
    ]),
  ];
  if (request.kind === "email") {
    return { rule: null, response: null, unknownPlaceholders: unknown, email: true };
  }
  const subject = ruleSubjectFor(request);
  const context = templateContextFor(request, endpoint);
  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false || rule.conditions.length === 0) continue;
    if (conditionsHold({ logic: rule.logic, conditions: rule.conditions }, subject)) {
      return {
        rule: { index, name: rule.name ?? null },
        response: fill(rule.response, context, generated),
        unknownPlaceholders: unknown,
        email: false,
      };
    }
  }
  return {
    rule: null,
    response: settings.mockResponse ? fill(settings.mockResponse, context, generated) : null,
    unknownPlaceholders: unknown,
    email: false,
  };
}
