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
import { z } from "zod";
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

type JsonBodyResult = { data: unknown } | { problem: "too_large" | "unreadable" | "invalid_json" };

/** Reads a body of at most `maxSize` bytes and parses it as JSON, of any type. */
async function readJsonBody(request: Request, maxSize: number): Promise<JsonBodyResult> {
  // Check Content-Length header if present (fast path)
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) return { problem: "too_large" };
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch (err) {
    console.error("Failed to read request body:", err);
    return { problem: "unreadable" };
  }

  // Check actual byte size (defense in depth against spoofed Content-Length)
  if (buffer.byteLength > maxSize) return { problem: "too_large" };

  try {
    return { data: JSON.parse(new TextDecoder().decode(buffer)) as unknown };
  } catch (err) {
    console.error("Failed to parse JSON body:", err);
    return { problem: "invalid_json" };
  }
}

function tooLargeMessage(maxSize: number): string {
  return `Request body too large (max ${maxSize} bytes)`;
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
  const read = await readJsonBody(request, maxSize);
  if ("problem" in read) {
    if (read.problem === "too_large") {
      return { error: Response.json({ error: tooLargeMessage(maxSize) }, { status: 413 }) };
    }
    const error = read.problem === "unreadable" ? "Failed to read request body" : "Invalid JSON";
    return { error: Response.json({ error }, { status: 400 }) };
  }

  // Validate that the parsed result is a JSON object (not array, string, number, etc.)
  const { data } = read;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      error: Response.json({ error: "Expected JSON object" }, { status: 400 }),
    };
  }

  return { data };
}

export interface ParseJsonBodyWithOptions {
  /** The largest body read, in bytes (64 KB when left out); a larger one is answered 413. */
  maxSize?: number;
  /**
   * The `error` of the 400 for a body the schema refuses: `null`, an array,
   * a field of the wrong type. "Invalid request body" when left out.
   */
  message?: string;
  /** The `error` of the 400 for a body that is not JSON at all; `message` when left out. */
  invalidJson?: string;
  /** Builds the error response, for routes whose answers carry headers of their own. */
  respond?: (body: { error: string }, init: { status: number }) => Response;
}

/**
 * The one way a route handler reads a JSON body: read it with the size
 * limit, parse it, and check it against a zod schema. A route gets either
 * data of the schema's type or the 4xx to return, so a malformed body (not
 * JSON, `null`, an array, a field of the wrong type) can never reach code
 * that would throw on it.
 *
 * The schema decides what is refused, so give it an object schema. Type
 * only the fields the route would otherwise have to check before use, and
 * leave a field `z.unknown()` where the route answers a wrong type with a
 * message of its own.
 */
export async function parseJsonBodyWith<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  options: ParseJsonBodyWithOptions = {}
): Promise<{ data: z.output<Schema> } | { error: Response }> {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const message = options.message ?? "Invalid request body";
  const respond = options.respond ?? ((body, init) => Response.json(body, init));

  const read = await readJsonBody(request, maxSize);
  if ("problem" in read) {
    if (read.problem === "too_large") {
      return { error: respond({ error: tooLargeMessage(maxSize) }, { status: 413 }) };
    }
    return { error: respond({ error: options.invalidJson ?? message }, { status: 400 }) };
  }

  const parsed = schema.safeParse(read.data);
  if (!parsed.success) return { error: respond({ error: message }, { status: 400 }) };
  return { data: parsed.data };
}
