import { CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the receiver answered a request with, as recorded when it was
 * captured (migration 00090): the status and the response rule that chose
 * it. Requests captured before that, and emails, have none.
 */
export interface ResponseAnswerFields {
  responseStatus?: number | null;
  responseRule?: string | null;
}

/** "Rule 2" names a rule by its place; anything else is the rule's own name. */
function ruleText(rule: string): string {
  return /^Rule \d+$/.test(rule) ? rule : `Rule: ${rule}`;
}

/** "Answered 402 (Rule: Payment failed)", "Answered 409 (Rule 2)", "Answered 200"; null without a record. */
export function answerLabel({ responseStatus, responseRule }: ResponseAnswerFields): string | null {
  if (responseStatus == null) return null;
  return responseRule
    ? `Answered ${responseStatus} (${ruleText(responseRule)})`
    : `Answered ${responseStatus}`;
}

/** The request detail's line: the full label. */
export function ResponseAnswer({ request }: { request: ResponseAnswerFields }) {
  const label = answerLabel(request);
  if (!label) return null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <CornerDownLeft className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The request list's compact form: the status, and the rule's name when one chose it. */
export function ResponseAnswerCompact({
  request,
  className,
}: {
  request: ResponseAnswerFields;
  className?: string;
}) {
  const label = answerLabel(request);
  if (!label) return null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)} title={label}>
      {/* A generic span cannot carry a name, so screen readers get the label as text. */}
      <span className="sr-only">{label}</span>
      <CornerDownLeft className="h-3 w-3 shrink-0" aria-hidden />
      <span aria-hidden className="shrink-0">
        {request.responseStatus}
      </span>
      {request.responseRule && (
        <span aria-hidden className="truncate">
          {request.responseRule}
        </span>
      )}
    </span>
  );
}
