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

/** Valid ops per field — must match the Rust evaluator and API validation. */
const VALID_OPS_BY_FIELD: Record<string, Set<string>> = {
  method: new Set(["eq"]),
  path: new Set(["eq", "contains", "starts_with", "matches"]),
  header: new Set(["exists", "eq", "contains"]),
  body_contains: new Set(["contains"]),
  body_path: new Set(["exists", "eq", "contains"]),
  query: new Set(["exists", "eq"]),
};

export const MAX_CONDITION_VALUE_LEN = 4096;
export const MAX_CONDITION_NAME_LEN = 256;
export const MAX_CONDITION_PATH_LEN = 256;
export const MAX_RULE_NAME_LEN = 200;
export const MAX_GLOB_PATTERN_LEN = 500;

export function validateMockResponse(
  mockResponse: MockResponse,
  fieldName = "mock response"
): void {
  const { status, body, headers, delay } = mockResponse;
  if (
    !Number.isInteger(status) ||
    status < MOCK_RESPONSE_STATUS_MIN ||
    status > MOCK_RESPONSE_STATUS_MAX
  ) {
    throw new Error(
      `Invalid ${fieldName} status: ${status}. Must be an integer ${MOCK_RESPONSE_STATUS_MIN}-${MOCK_RESPONSE_STATUS_MAX}.`
    );
  }
  if (body !== undefined && typeof body !== "string") {
    throw new Error(`Invalid ${fieldName} body: must be a string.`);
  }
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      throw new Error(`Invalid ${fieldName} headers: must be a Record<string, string>.`);
    }
    for (const val of Object.values(headers)) {
      if (typeof val !== "string") {
        throw new Error(`Invalid ${fieldName} headers: all values must be strings.`);
      }
    }
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

    if (
      rule.name !== undefined &&
      (typeof rule.name !== "string" || rule.name.length > MAX_RULE_NAME_LEN)
    ) {
      throw new Error(`${prefix}: name must be a string (max ${MAX_RULE_NAME_LEN} chars)`);
    }
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
      // Op/field compatibility
      const fieldOps = VALID_OPS_BY_FIELD[c.field];
      if (fieldOps && !fieldOps.has(c.op)) {
        throw new Error(`${cp}: op "${c.op}" is not valid for field "${c.field}"`);
      }
      // String length limits
      if (
        c.value !== undefined &&
        typeof c.value === "string" &&
        c.value.length > MAX_CONDITION_VALUE_LEN
      ) {
        throw new Error(`${cp}: value too long (max ${MAX_CONDITION_VALUE_LEN} chars)`);
      }
      if (
        c.name !== undefined &&
        typeof c.name === "string" &&
        c.name.length > MAX_CONDITION_NAME_LEN
      ) {
        throw new Error(`${cp}: name too long (max ${MAX_CONDITION_NAME_LEN} chars)`);
      }
      if (
        c.path !== undefined &&
        typeof c.path === "string" &&
        c.path.length > MAX_CONDITION_PATH_LEN
      ) {
        throw new Error(`${cp}: path too long (max ${MAX_CONDITION_PATH_LEN} chars)`);
      }
      // Required sub-fields
      if ((c.field === "header" || c.field === "query") && (!c.name || c.name.length === 0)) {
        throw new Error(`${cp}: name is required for ${c.field} conditions`);
      }
      if (c.field === "body_path" && (!c.path || c.path.length === 0)) {
        throw new Error(`${cp}: path is required for body_path conditions`);
      }
      // Value required for non-exists ops
      if (c.op !== "exists" && (c.value === undefined || c.value === null)) {
        throw new Error(`${cp}: value is required when op is "${c.op}"`);
      }
      // Glob pattern length
      if (c.op === "matches" && c.value && c.value.length > MAX_GLOB_PATTERN_LEN) {
        throw new Error(`${cp}: matches pattern too long (max ${MAX_GLOB_PATTERN_LEN} chars)`);
      }
    }

    validateMockResponse(rule.response, `${prefix}.response`);
  }
}
