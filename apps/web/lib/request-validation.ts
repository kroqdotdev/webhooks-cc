/**
 * Request body parsing and field validation helpers.
 */

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
