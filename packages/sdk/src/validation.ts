import {
  conditionIssues,
  conditionsIssues,
  MAX_CONDITIONS,
  MAX_PATTERN_CHARS,
  type ValidateOptions,
} from "./rules";
import type { MockResponse, ResponseRule } from "./types";
import { emailFieldIssues } from "./email/fields";

export const MOCK_RESPONSE_STATUS_MIN = 100;
export const MOCK_RESPONSE_STATUS_MAX = 599;
export const MOCK_RESPONSE_DELAY_MIN = 0;
export const MOCK_RESPONSE_DELAY_MAX = 30000;
export const MAX_RESPONSE_RULES = 50;
export const MAX_CONDITIONS_PER_RULE = MAX_CONDITIONS;

export const MAX_CONDITION_VALUE_LEN = 4096;
export const MAX_CONDITION_NAME_LEN = 256;
export const MAX_CONDITION_PATH_LEN = 256;
export const MAX_RULE_NAME_LEN = 200;
export const MAX_GLOB_PATTERN_LEN = MAX_PATTERN_CHARS;

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

/**
 * Checks response rules the way the API does. Pass `checkRegex` to check
 * regular expressions too (the API uses RE2).
 */
export function validateResponseRules(
  rules: ResponseRule[],
  { checkRegex }: Pick<ValidateOptions, "checkRegex"> = {}
): void {
  const options: ValidateOptions = { use: "response", checkRegex };
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
      const issues = conditionIssues(rule.conditions[j], options);
      if (issues.length > 0) throw new Error(`${prefix}.conditions[${j}]: ${issues[0]}`);
    }

    validateMockResponse(rule.response, `${prefix}.response`);
  }
}

/** Checks a destination's filter conditions the way the API does (regular expressions excepted). */
export function validateDestinationInput(input: { filter?: unknown }): void {
  if (input.filter === undefined || input.filter === null) return;
  if (typeof input.filter !== "object" || Array.isArray(input.filter)) {
    throw new Error("filter must be { logic, conditions } or null");
  }
  const filter = input.filter as { logic?: unknown; conditions?: unknown };
  if (filter.logic !== undefined && filter.logic !== "and" && filter.logic !== "or") {
    throw new Error('filter.logic must be "and" or "or"');
  }
  const issues = conditionsIssues(filter.conditions, { use: "filter" }, "filter.conditions");
  if (issues.length > 0) throw new Error(issues[0]);
}

/** Refuses a field list the API would refuse (names, sources, pattern length; RE2 syntax is checked by the server). */
export function validateEmailFields(fields: unknown): void {
  if (fields === undefined || fields === null) return;
  const issues = emailFieldIssues(fields);
  if (issues.length > 0) throw new Error(`emailFields: ${issues[0]}`);
}
