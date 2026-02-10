import type { Request } from "./types";
import { parseJsonBody, matchJsonField } from "./helpers";

// Re-export matchJsonField for convenience
export { matchJsonField };

/** Match requests by HTTP method (case-insensitive). */
export function matchMethod(method: string): (request: Request) => boolean {
  const upper = method.toUpperCase();
  return (request: Request) => request.method.toUpperCase() === upper;
}

/** Match requests that have a specific header, optionally with a specific value. */
export function matchHeader(name: string, value?: string): (request: Request) => boolean {
  const lowerName = name.toLowerCase();
  return (request: Request) => {
    const entry = Object.entries(request.headers).find(([k]) => k.toLowerCase() === lowerName);
    if (!entry) return false;
    if (value === undefined) return true;
    return entry[1] === value;
  };
}

/**
 * Match requests by a dot-notation path into the JSON body.
 *
 * @example
 * ```ts
 * matchBodyPath("data.object.id", "obj_123")
 * matchBodyPath("type", "checkout.session.completed")
 * ```
 */
export function matchBodyPath(path: string, value: unknown): (request: Request) => boolean {
  const keys = path.split(".");
  return (request: Request) => {
    const body = parseJsonBody(request);
    if (typeof body !== "object" || body === null) return false;

    let current: unknown = body;
    for (const key of keys) {
      if (typeof current !== "object" || current === null) return false;
      if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
      current = (current as Record<string, unknown>)[key];
    }

    return current === value;
  };
}

/** Match when ALL matchers return true. */
export function matchAll(
  ...matchers: Array<(request: Request) => boolean>
): (request: Request) => boolean {
  return (request: Request) => matchers.every((m) => m(request));
}

/** Match when ANY matcher returns true. */
export function matchAny(
  ...matchers: Array<(request: Request) => boolean>
): (request: Request) => boolean {
  return (request: Request) => matchers.some((m) => m(request));
}
