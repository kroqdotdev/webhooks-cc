import {
  CONDITION_FIELDS,
  type Condition,
  type ConditionField,
  type ConditionOp,
} from "@webhooks-cc/sdk";

/**
 * How conditions read in the dashboard: field and operator names in plain
 * words, the order operators are offered in, and a one-line summary of a
 * rule or filter ("method is POST and header x-test is present"). The rule
 * language itself lives in the SDK (packages/sdk/src/rules.ts).
 */

export type ConditionUse = "response" | "filter";

interface FieldLabel {
  label: string;
  /** Operators in the order the picker offers them. */
  ops: ConditionOp[];
  /** What the key input asks for. */
  keyLabel?: string;
  keyPlaceholder?: string;
  /** Fixed choices for the key (email part, email check). */
  keyChoices?: { value: string; label: string }[];
  valuePlaceholder?: string;
  /** Fixed choices for the value. */
  valueChoices?: string[];
}

const NUMBER: ConditionOp[] = ["gt", "gte", "lt", "lte"];

export const FIELD_LABELS: Record<ConditionField, FieldLabel> = {
  method: {
    label: "Method",
    ops: ["eq", "neq"],
    valueChoices: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  },
  path: {
    label: "Path",
    ops: ["eq", "starts_with", "contains", "ends_with", "matches", "regex", "neq", "not_contains"],
    valuePlaceholder: "/stripe/events",
  },
  header: {
    label: "Header",
    ops: [
      "exists",
      "eq",
      "contains",
      "starts_with",
      "ends_with",
      "matches",
      "regex",
      "not_exists",
      "neq",
      "not_contains",
      ...NUMBER,
    ],
    keyLabel: "Header name",
    keyPlaceholder: "x-event",
    valuePlaceholder: "value",
  },
  query: {
    label: "Query parameter",
    ops: [
      "exists",
      "eq",
      "contains",
      "starts_with",
      "ends_with",
      "matches",
      "regex",
      "not_exists",
      "neq",
      "not_contains",
      ...NUMBER,
    ],
    keyLabel: "Parameter name",
    keyPlaceholder: "page",
    valuePlaceholder: "value",
  },
  body: {
    label: "Body text",
    ops: ["contains", "not_contains", "regex"],
    valuePlaceholder: "invoice.paid",
  },
  body_contains: {
    label: "Body text",
    ops: ["contains"],
    valuePlaceholder: "invoice.paid",
  },
  body_path: {
    label: "Body field",
    ops: [
      "eq",
      "exists",
      "contains",
      "starts_with",
      "ends_with",
      "matches",
      "regex",
      ...NUMBER,
      "not_exists",
      "neq",
      "not_contains",
    ],
    keyLabel: "Field path",
    keyPlaceholder: "data.object.status",
    valuePlaceholder: "value",
  },
  content_type: {
    label: "Content type",
    ops: ["contains", "eq", "starts_with", "neq", "not_contains", "regex"],
    valuePlaceholder: "json",
  },
  size: {
    label: "Size in bytes",
    ops: [...NUMBER, "eq", "neq"],
    valuePlaceholder: "1024",
  },
  kind: {
    label: "Kind",
    ops: ["eq", "neq"],
    valueChoices: ["http", "email"],
  },
  email: {
    label: "Email",
    ops: [
      "contains",
      "eq",
      "starts_with",
      "ends_with",
      "matches",
      "regex",
      "exists",
      "not_exists",
      "neq",
      "not_contains",
    ],
    keyLabel: "Part of the email",
    keyChoices: [
      { value: "subject", label: "Subject" },
      { value: "from", label: "From" },
      { value: "to", label: "To or Cc" },
      { value: "text", label: "Text" },
      { value: "tag", label: "Tag" },
    ],
    valuePlaceholder: "value",
  },
  email_field: {
    label: "Email field",
    ops: [
      "eq",
      "neq",
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
      "matches",
      "regex",
      ...NUMBER,
      "exists",
      "not_exists",
    ],
    keyLabel: "Field name",
    keyPlaceholder: "invoice",
    valuePlaceholder: "value",
  },
  spam_score: {
    label: "Spam score",
    ops: [...NUMBER, "exists", "not_exists"],
    valuePlaceholder: "5",
  },
  email_auth: {
    label: "Sender check",
    ops: ["eq", "neq"],
    keyLabel: "Check",
    keyChoices: [
      { value: "spf", label: "SPF" },
      { value: "dkim", label: "DKIM" },
      { value: "dmarc", label: "DMARC" },
    ],
    valueChoices: ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"],
  },
  signature: {
    label: "Signature",
    ops: ["eq", "neq"],
    valueChoices: ["verified", "failed", "missing"],
  },
};

export const OP_LABELS: Record<ConditionOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  matches: "matches pattern",
  regex: "matches regex",
  exists: "is present",
  not_exists: "is missing",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};

/** Fields offered for a use, in the picker's order (body_contains is shown as body). */
export function fieldsFor(use: ConditionUse): ConditionField[] {
  const response: ConditionField[] = [
    "method",
    "path",
    "header",
    "query",
    "body_path",
    "body",
    "content_type",
    "size",
  ];
  if (use === "response") return response;
  return [...response, "kind", "email", "spam_score", "email_auth", "signature"];
}

/** Whether the operator needs a value. */
export function takesValue(op: ConditionOp): boolean {
  return op !== "exists" && op !== "not_exists";
}

/** The key a field needs (name or path), if any. */
export function keyOf(field: ConditionField): "name" | "path" | undefined {
  return CONDITION_FIELDS[field]?.key;
}

/** A fresh condition for a field: its first operator, its first choices filled in. */
export function blankCondition(field: ConditionField): Condition {
  const labels = FIELD_LABELS[field];
  const condition: Condition = { field, op: labels.ops[0] };
  if (labels.keyChoices) condition.name = labels.keyChoices[0].value;
  else if (keyOf(field) === "name") condition.name = "";
  else if (keyOf(field) === "path") condition.path = "";
  if (takesValue(condition.op)) condition.value = labels.valueChoices?.[0] ?? "";
  return condition;
}

/** Changes a condition's field, keeping what still fits. */
export function withField(condition: Condition, field: ConditionField): Condition {
  if (field === condition.field) return condition;
  const next = blankCondition(field);
  // Keep a typed value when both fields take free text.
  const labels = FIELD_LABELS[field];
  if (
    takesValue(next.op) &&
    !labels.valueChoices &&
    !FIELD_LABELS[condition.field]?.valueChoices &&
    condition.value
  ) {
    next.value = condition.value;
  }
  return next;
}

function quote(text: string): string {
  return text === "" ? '""' : text;
}

/** One condition in words: "header x-test is present". */
export function describeCondition(condition: Condition): string {
  const labels = FIELD_LABELS[condition.field];
  if (!labels) return "an unknown condition";
  let subject = labels.label.toLowerCase();
  if (condition.field === "header" || condition.field === "query") {
    subject = `${condition.field === "header" ? "header" : "query"} ${condition.name || "?"}`;
  } else if (condition.field === "body_path") {
    subject = `body field ${condition.path || "?"}`;
  } else if (condition.field === "email") {
    const part = labels.keyChoices?.find((choice) => choice.value === condition.name);
    subject = `email ${(part?.label ?? condition.name ?? "?").toLowerCase()}`;
  } else if (condition.field === "email_auth") {
    subject = (condition.name ?? "check").toUpperCase();
  } else if (condition.field === "method") {
    subject = "method";
  }
  const op = OP_LABELS[condition.op] ?? condition.op;
  return takesValue(condition.op)
    ? `${subject} ${op} ${quote(condition.value ?? "")}`
    : `${subject} ${op}`;
}

/** A rule's or filter's conditions in one line. */
export function describeConditions(conditions: Condition[], logic: "and" | "or" = "and"): string {
  if (conditions.length === 0) return "every request";
  return conditions.map(describeCondition).join(logic === "or" ? " or " : " and ");
}
