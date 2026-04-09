import type { MockResponse, ResponseRule } from "./types";

export const MOCK_RESPONSE_STATUS_MIN = 100;
export const MOCK_RESPONSE_STATUS_MAX = 599;
export const MOCK_RESPONSE_DELAY_MIN = 0;
export const MOCK_RESPONSE_DELAY_MAX = 30000;
export const MAX_RESPONSE_RULES = 50;
export const MAX_CONDITIONS_PER_RULE = 10;

const VALID_CONDITION_FIELDS = new Set([
  "method",
  "path",
  "header",
  "body_contains",
  "body_path",
  "query",
]);
const VALID_CONDITION_OPS = new Set(["eq", "contains", "starts_with", "matches", "exists"]);

export function validateMockResponse(
  mockResponse: MockResponse,
  fieldName = "mock response"
): void {
  const { status, delay } = mockResponse;
  if (
    !Number.isInteger(status) ||
    status < MOCK_RESPONSE_STATUS_MIN ||
    status > MOCK_RESPONSE_STATUS_MAX
  ) {
    throw new Error(
      `Invalid ${fieldName} status: ${status}. Must be an integer ${MOCK_RESPONSE_STATUS_MIN}-${MOCK_RESPONSE_STATUS_MAX}.`
    );
  }
  if (
    delay !== undefined &&
    (!Number.isInteger(delay) || delay < MOCK_RESPONSE_DELAY_MIN || delay > MOCK_RESPONSE_DELAY_MAX)
  ) {
    throw new Error(
      `Invalid ${fieldName} delay: ${delay}. Must be an integer ${MOCK_RESPONSE_DELAY_MIN}-${MOCK_RESPONSE_DELAY_MAX}.`
    );
  }
}

export function validateResponseRules(rules: ResponseRule[]): void {
  if (!Array.isArray(rules)) {
    throw new Error("responseRules must be an array");
  }
  if (rules.length > MAX_RESPONSE_RULES) {
    throw new Error(`responseRules: max ${MAX_RESPONSE_RULES} rules allowed`);
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const prefix = `responseRules[${i}]`;

    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
      throw new Error(`${prefix}: conditions must be a non-empty array`);
    }
    if (rule.conditions.length > MAX_CONDITIONS_PER_RULE) {
      throw new Error(`${prefix}: max ${MAX_CONDITIONS_PER_RULE} conditions per rule`);
    }
    if (rule.logic !== undefined && rule.logic !== "and" && rule.logic !== "or") {
      throw new Error(`${prefix}: logic must be "and" or "or"`);
    }

    for (let j = 0; j < rule.conditions.length; j++) {
      const c = rule.conditions[j];
      const cp = `${prefix}.conditions[${j}]`;
      if (!VALID_CONDITION_FIELDS.has(c.field)) {
        throw new Error(`${cp}: invalid field "${c.field}"`);
      }
      if (!VALID_CONDITION_OPS.has(c.op)) {
        throw new Error(`${cp}: invalid op "${c.op}"`);
      }
    }

    validateMockResponse(rule.response, `${prefix}.response`);
  }
}
