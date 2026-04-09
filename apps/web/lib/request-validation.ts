/**
 * Request body parsing and field validation helpers.
 */

import {
  MOCK_RESPONSE_STATUS_MIN,
  MOCK_RESPONSE_STATUS_MAX,
  MOCK_RESPONSE_DELAY_MIN,
  MOCK_RESPONSE_DELAY_MAX,
  MAX_RESPONSE_RULES,
  MAX_CONDITIONS_PER_RULE,
} from "@webhooks-cc/sdk";

const VALID_RULE_FIELDS = new Set([
  "method",
  "path",
  "header",
  "body_contains",
  "body_path",
  "query",
]);
const VALID_RULE_OPS = new Set(["eq", "contains", "starts_with", "matches", "exists"]);

/**
 * Validate a notificationUrl field from a request body.
 * Accepts undefined/null (skip), empty string (allowed), or a valid http/https URL (max 2048).
 */
export function validateNotificationUrl(
  value: unknown
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
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return {
          valid: false,
          response: Response.json(
            { error: "notificationUrl must use http or https" },
            { status: 400 }
          ),
        };
      }
    } catch {
      return {
        valid: false,
        response: Response.json({ error: "Invalid notificationUrl format" }, { status: 400 }),
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
    if (conditions.length > MAX_CONDITIONS_PER_RULE) {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: max ${MAX_CONDITIONS_PER_RULE} conditions` },
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
    if (rule.name !== undefined && (typeof rule.name !== "string" || rule.name.length > 200)) {
      return {
        valid: false,
        response: Response.json(
          { error: `responseRules[${i}]: name must be a string (max 200 chars)` },
          { status: 400 }
        ),
      };
    }
    for (let j = 0; j < conditions.length; j++) {
      const c = conditions[j] as Record<string, unknown>;
      if (!c || typeof c !== "object") {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: must be an object` },
            { status: 400 }
          ),
        };
      }
      if (!VALID_RULE_FIELDS.has(c.field as string)) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: invalid field` },
            { status: 400 }
          ),
        };
      }
      if (!VALID_RULE_OPS.has(c.op as string)) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: invalid op` },
            { status: 400 }
          ),
        };
      }
      // String length limits
      if (typeof c.value === "string" && c.value.length > 4096) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: value too long (max 4096)` },
            { status: 400 }
          ),
        };
      }
      if (typeof c.name === "string" && c.name.length > 256) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: name too long (max 256)` },
            { status: 400 }
          ),
        };
      }
      if (typeof c.path === "string" && c.path.length > 256) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: path too long (max 256)` },
            { status: 400 }
          ),
        };
      }
      // Required sub-fields
      if (
        (c.field === "header" || c.field === "query") &&
        (typeof c.name !== "string" || c.name.length === 0)
      ) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: name required for ${c.field}` },
            { status: 400 }
          ),
        };
      }
      if (c.field === "body_path" && (typeof c.path !== "string" || c.path.length === 0)) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: path required for body_path` },
            { status: 400 }
          ),
        };
      }
      // Require value for non-exists ops
      if (
        c.op !== "exists" &&
        (c.value === undefined || c.value === null || typeof c.value !== "string")
      ) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: value required when op is "${c.op}"` },
            { status: 400 }
          ),
        };
      }
      // Validate op/field compatibility
      const validOpsForField: Record<string, Set<string>> = {
        method: new Set(["eq"]),
        path: new Set(["eq", "contains", "starts_with", "matches"]),
        header: new Set(["exists", "eq", "contains"]),
        body_contains: new Set(["contains"]),
        body_path: new Set(["exists", "eq", "contains"]),
        query: new Set(["exists", "eq"]),
      };
      const fieldOps = validOpsForField[c.field as string];
      if (fieldOps && !fieldOps.has(c.op as string)) {
        return {
          valid: false,
          response: Response.json(
            {
              error: `responseRules[${i}].conditions[${j}]: op "${c.op}" not valid for field "${c.field}"`,
            },
            { status: 400 }
          ),
        };
      }
      // Enforce glob pattern max length at API level
      if (c.op === "matches" && typeof c.value === "string" && c.value.length > 500) {
        return {
          valid: false,
          response: Response.json(
            { error: `responseRules[${i}].conditions[${j}]: matches pattern too long (max 500)` },
            { status: 400 }
          ),
        };
      }
    }
    // Validate the rule's response (required)
    if (rule.response === undefined || rule.response === null || typeof rule.response !== "object") {
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
