import {
  emailTemplateContext,
  requestTemplateContext,
  type RuleSubject,
  type SignatureState,
} from "@webhooks-cc/sdk";
import { buildEmailJson } from "@webhooks-cc/sdk/email";
import type { RequestRecord } from "@/lib/supabase/requests";

/**
 * A stored request as conditions and placeholders read it: the rule subject
 * (lib/rules.ts) and the template context (`{{ ... }}`). The receiver builds
 * the same for mock responses in Rust; the shared vectors keep them equal.
 */

/** Where the signature check stands: verified, failed, or missing (none ran yet). */
export function signatureState(request: RequestRecord): SignatureState {
  if (request.signatureVerified === true) return "verified";
  if (request.signatureVerified === false) return "failed";
  return "missing";
}

/** The rule subject for a stored request, email or HTTP. */
export function ruleSubjectFor(request: RequestRecord): RuleSubject {
  const email = request.kind === "email" ? request.email : null;
  return {
    kind: request.kind,
    method: request.method,
    path: request.path,
    headers: request.headers ?? {},
    query: request.queryParams ?? {},
    body: request.body ?? "",
    contentType: request.contentType ?? null,
    size: request.size,
    email: email
      ? {
          subject: email.subject,
          from: email.from[0]?.address ?? null,
          to: [...email.to, ...email.cc]
            .map((address) => address.address)
            .filter((address): address is string => !!address),
          text: email.text,
          tag: email.tag,
          spamScore: email.spam?.score ?? null,
          auth: {
            spf: email.auth?.spf?.result ?? null,
            dkim: email.auth?.dkim?.some((check) => check.result === "pass")
              ? "pass"
              : (email.auth?.dkim?.[0]?.result ?? null),
            dmarc: email.auth?.dmarc?.result ?? null,
          },
        }
      : null,
    signature: signatureState(request),
  };
}

export interface ContextOptions {
  /** Codes and links for emails (the endpoint's "Show codes and links" setting). */
  includeExtracts?: boolean;
  /** Add `signature` (forwarded payloads; mock responses are sent before the check). */
  withSignature?: boolean;
}

/** The template context for a stored request. */
export function templateContextFor(
  request: RequestRecord,
  endpoint: { slug: string; name: string | null },
  options: ContextOptions = {}
): Record<string, unknown> {
  const extra = options.withSignature ? { signature: signatureState(request) } : {};
  if (request.kind === "email" && request.email) {
    const event = buildEmailJson({ ...request, email: request.email }, endpoint, {
      includeExtracts: options.includeExtracts !== false,
    });
    return emailTemplateContext(event.data as unknown as Record<string, unknown>, extra);
  }
  return requestTemplateContext(
    {
      id: request.id,
      method: request.method,
      path: request.path,
      headers: request.headers ?? {},
      query: request.queryParams ?? {},
      body: request.body ?? "",
      contentType: request.contentType ?? null,
      ip: request.ip,
      size: request.size,
      receivedAt: request.receivedAt,
      endpoint,
    },
    extra
  );
}
