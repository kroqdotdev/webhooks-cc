/**
 * Request body parsing and field validation helpers.
 */

import {
  MOCK_RESPONSE_STATUS_MIN,
  MOCK_RESPONSE_STATUS_MAX,
  MOCK_RESPONSE_DELAY_MIN,
  MOCK_RESPONSE_DELAY_MAX,
  MAX_RESPONSE_RULES,
  MAX_RULE_NAME_LEN,
} from "@webhooks-cc/sdk";
import { checkForwardUrl } from "./forwarding/target";
import { conditionProblems } from "./rules";

/**
 * Validate a notificationUrl field from a request body: undefined or null
 * (skip), empty (clears it), or a URL a destination may send to (max 2048):
 * the URL becomes the endpoint's Notifications destination.
 */
export function validateNotificationUrl(
  value: unknown,
  options: { allowPrivate: boolean } = { allowPrivate: false }
): { valid: true } | { valid: false; response: Response } {
  if (value === undefined || value === null) {
    return { valid: true };
  }
  if (typeof value !== "string" || value.length > 2048) {
    return {
      valid: false,
      response: Response.json({ error: "Invalid notificationUrl" }, { status: 400 }),
    };
  }
  if (value.length > 0) {
    const check = checkForwardUrl(value, options);
    if (!check.ok) {
      return {
        valid: false,
        response: Response.json({ error: `notificationUrl: ${check.reason}` }, { status: 400 }),
      };
    }
  }
  return { valid: true };
}

/**
 * Validate a mockResponse field from a request body.
 * For POST (create): all fields required. For PATCH (update): fields are optional.
 */
export function validateMockResponseField(
  value: unknown,
  /** When true, status/body/headers are optional (PATCH semantics). */
  partial = false
): { valid: true } | { valid: false; response: Response } {
  if (value === undefined || value === null) return { valid: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      response: Response.json({ error: "Invalid mockResponse" }, { status: 400 }),
    };
  }

  const mr = value as Record<string, unknown>;

  // Status validation
  if (mr.status !== undefined) {
    if (
      typeof mr.status !== "number" ||
      !Number.isInteger(mr.status) ||
      mr.status < MOCK_RESPONSE_STATUS_MIN ||
      mr.status > MOCK_RESPONSE_STATUS_MAX
    ) {
      return {
        valid: false,
        response: Response.json({ error: "Invalid status code" }, { status: 400 }),
      };
    }
  } else if (!partial) {
    return {
      valid: false,
      response: Response.json({ error: "Invalid status code" }, { status: 400 }),
    };
  }

  // Body validation
  if (mr.body !== undefined) {
    if (typeof mr.body !== "string") {
      return {
        valid: false,
        response: Response.json({ error: "Invalid mockResponse body" }, { status: 400 }),
      };
    }
  } else if (!partial) {
    return {
      valid: false,
      response: Response.json({ error: "Invalid mockResponse body" }, { status: 400 }),
    };
  }

  // Headers validation
  if (mr.headers !== undefined) {
    if (typeof mr.headers !== "object" || mr.headers === null || Array.isArray(mr.headers)) {
      return {
        valid: false,
        response: Response.json({ error: "Invalid mockResponse headers" }, { status: 400 }),
      };
    }
    for (const val of Object.values(mr.headers as Record<string, unknown>)) {
      if (typeof val !== "string") {
        return {
          valid: false,
          response: Response.json({ error: "Invalid mockResponse headers" }, { status: 400 }),
        };
      }
    }
  } else if (!partial) {
    return {
      valid: false,
      response: Response.json({ error: "Invalid mockResponse headers" }, { status: 400 }),
    };
  }

  // Delay validation
  if (
    mr.delay !== undefined &&
    (typeof mr.delay !== "number" ||
      !Number.isInteger(mr.delay) ||
      mr.delay < MOCK_RESPONSE_DELAY_MIN ||
      mr.delay > MOCK_RESPONSE_DELAY_MAX)
  ) {
    return {
      valid: false,
      response: Response.json(
        { error: `Invalid delay: must be ${MOCK_RESPONSE_DELAY_MIN}-${MOCK_RESPONSE_DELAY_MAX}ms` },
        { status: 400 }
      ),
    };
  }

  return { valid: true };
}

/**
 * Validate a responseRules field from a request body.
 * Accepts undefined/null (skip) or a valid array of rule objects.
 */
export function validateResponseRules(
  value: unknown
): { valid: true } | { valid: false; response: Response } {
  if (value === undefined || value === null) return { valid: true };
  if (!Array.isArray(value)) {
    return {
      valid: false,
      response: Response.json({ error: "responseRules must be an array" }, { status: 400 }),
    };
  }
  if (value.length > MAX_RESPONSE_RULES) {
    return {
      valid: false,
      response: Response.json(
        { error: `responseRules: max ${MAX_RESPONSE_RULES} rules` },
        { status: 400 }
      ),
    };
  }
  for (let i = 0; i < value.length; i++) {
    const rule = value[i] as Record<string, unknown>;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: must be an object` },
          { status: 400 }
        ),
      };
    }
    const conditions = rule.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: conditions must be a non-empty array` },
          { status: 400 }
        ),
      };
    }
    // Validate logic field
    if (rule.logic !== undefined && rule.logic !== "and" && rule.logic !== "or") {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: logic must be "and" or "or"` },
          { status: 400 }
        ),
      };
    }
    // Validate rule name length
    if (
      rule.name !== undefined &&
      (typeof rule.name !== "string" || rule.name.length > MAX_RULE_NAME_LEN)
    ) {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: name must be a string (max ${MAX_RULE_NAME_LEN} chars)` },
          { status: 400 }
        ),
      };
    }
    // Fields, operators, lengths and patterns: the SDK's rule language, with
    // regular expressions checked by RE2 as the receiver compiles them.
    const problems = conditionProblems(conditions, "response", `responseRules[${i}].conditions`);
    if (problems.length > 0) {
      return {
        valid: false,
        response: Response.json({ error: problems[0] }, { status: 400 }),
      };
    }
    // Validate the rule's response (required)
    if (
      rule.response === undefined ||
      rule.response === null ||
      typeof rule.response !== "object"
    ) {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: response is required` },
          { status: 400 }
        ),
      };
    }
    const mockCheck = validateMockResponseField(rule.response);
    if (!mockCheck.valid) return mockCheck;
  }
  return { valid: true };
}

const DEFAULT_MAX_SIZE = 64 * 1024; // 64KB

/** RFC 5321 maximum address length; also bounds the regex below. */
const MAX_EMAIL_LENGTH = 254;

/**
 * An ASCII address with a dotted domain (the WHATWG "valid email address"
 * form, which GoTrue accepts too).
 */
const PLAIN_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Whether `value` is one plain email address and nothing else. Strict on
 * purpose: the mailer parses looser strings such as `x<a@b.c>` or
 * `a@b.c,d.e` as other recipients, so a check on the string would not be a
 * check on where mail goes.
 */
export function isPlainEmailAddress(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && PLAIN_EMAIL_REGEX.test(value);
}

/**
 * Parse a JSON request body with size limit enforcement.
 * Checks Content-Length header first (fast path), then actual byte size.
 * Returns the parsed body on success, or a 413/400 Response on failure.
 */
export async function parseJsonBody(
  request: Request,
  maxSize: number = DEFAULT_MAX_SIZE
): Promise<{ data: unknown } | { error: Response }> {
  // Check Content-Length header if present (fast path)
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) {
      return {
        error: Response.json(
          { error: `Request body too large (max ${maxSize} bytes)` },
          { status: 413 }
        ),
      };
    }
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch (err) {
    console.error("Failed to read request body:", err);
    return {
      error: Response.json({ error: "Failed to read request body" }, { status: 400 }),
    };
  }

  // Check actual byte size (defense in depth against spoofed Content-Length)
  if (buffer.byteLength > maxSize) {
    return {
      error: Response.json(
        { error: `Request body too large (max ${maxSize} bytes)` },
        { status: 413 }
      ),
    };
  }

  const text = new TextDecoder().decode(buffer);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.error("Failed to parse JSON body:", err);
    return {
      error: Response.json({ error: "Invalid JSON" }, { status: 400 }),
    };
  }

  // Validate that the parsed result is a JSON object (not array, string, number, etc.)
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      error: Response.json({ error: "Expected JSON object" }, { status: 400 }),
    };
  }

  return { data };
}
