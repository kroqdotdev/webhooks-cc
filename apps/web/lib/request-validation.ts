/**
 * Request body parsing and field validation helpers.
 */

import {
  MOCK_RESPONSE_STATUS_MIN,
  MOCK_RESPONSE_STATUS_MAX,
  MOCK_RESPONSE_DELAY_MIN,
  MOCK_RESPONSE_DELAY_MAX,
} from "@webhooks-cc/sdk";

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
  } catch {
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
  } catch {
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
