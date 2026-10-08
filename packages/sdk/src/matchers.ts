import type { EmailAddress } from "./email/types";
import type { EmailCriteria, EmailRequest, Request } from "./types";
import { parseJsonBody, matchJsonField } from "./helpers";

// Re-export matchJsonField for convenience
export { matchJsonField };

function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    source += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
  }

  source += "$";
  return new RegExp(source);
}

function isDeepSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((value, index) => isDeepSubset(value, actual[index]))
    );
  }

  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }

    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        return false;
      }
      return isDeepSubset(value, (actual as Record<string, unknown>)[key]);
    });
  }

  return Object.is(expected, actual);
}

/** Match requests by HTTP method (case-insensitive). */
export function matchMethod(method: string): (request: Request) => boolean {
  const upper = method.toUpperCase();
  return (request: Request) => request.method.toUpperCase() === upper;
}

/** Match requests that have a specific header, optionally with a specific value. Header names are matched case-insensitively; values are matched with exact (case-sensitive) equality. */
export function matchHeader(name: string, value?: string): (request: Request) => boolean {
  return (request: Request) => {
    const headerValue = getHeaderValue(request.headers, name);
    if (headerValue === undefined) return false;
    if (value === undefined) return true;
    return headerValue === value;
  };
}

/** Match request paths using glob-style wildcards. Supports `*` and `**`. */
export function matchPath(pattern: string): (request: Request) => boolean {
  const regex = globToRegExp(pattern);
  return (request: Request) => regex.test(request.path);
}

/** Match query parameter presence or a specific query parameter value. */
export function matchQueryParam(key: string, value?: string): (request: Request) => boolean {
  return (request: Request) => {
    if (!Object.prototype.hasOwnProperty.call(request.queryParams, key)) {
      return false;
    }
    if (value === undefined) {
      return true;
    }
    return request.queryParams[key] === value;
  };
}

/**
 * Match requests by a dot-notation path into the JSON body.
 * Supports array indexing with numeric path segments (e.g., `"items.0.id"`).
 *
 * @example
 * ```ts
 * matchBodyPath("data.object.id", "obj_123")
 * matchBodyPath("type", "checkout.session.completed")
 * matchBodyPath("items.0.name", "Widget")
 * ```
 */
export function matchBodyPath(path: string, value: unknown): (request: Request) => boolean {
  const keys = path.split(".");
  return (request: Request) => {
    const body = parseJsonBody(request);
    if (typeof body !== "object" || body === null) return false;

    let current: unknown = body;
    for (const key of keys) {
      if (current === null || current === undefined) return false;
      if (Array.isArray(current)) {
        const idx = Number(key);
        if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return false;
        current = current[idx];
      } else if (typeof current === "object") {
        if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
        current = (current as Record<string, unknown>)[key];
      } else {
        return false;
      }
    }

    return current === value;
  };
}

/** Match a deep partial subset of the parsed JSON body. */
export function matchBodySubset(subset: Record<string, unknown>): (request: Request) => boolean {
  return (request: Request) => {
    const body = parseJsonBody(request);
    return isDeepSubset(subset, body);
  };
}

/** Match the request content type, ignoring charset parameters. */
export function matchContentType(type: string): (request: Request) => boolean {
  const expected = type.trim().toLowerCase();
  return (request: Request) => {
    const raw = request.contentType ?? getHeaderValue(request.headers, "content-type");
    if (!raw) {
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === expected || normalized.startsWith(`${expected};`);
  };
}

/** Match when ALL matchers return true. Requires at least one matcher. */
export function matchAll(
  first: (request: Request) => boolean,
  ...rest: Array<(request: Request) => boolean>
): (request: Request) => boolean {
  const matchers = [first, ...rest];
  return (request: Request) => matchers.every((m) => m(request));
}

/** Match when ANY matcher returns true. Requires at least one matcher. */
export function matchAny(
  first: (request: Request) => boolean,
  ...rest: Array<(request: Request) => boolean>
): (request: Request) => boolean {
  const matchers = [first, ...rest];
  return (request: Request) => matchers.some((m) => m(request));
}

/** Match requests whose server-side signature verification succeeded. */
export function matchVerified(): (request: Request) => boolean {
  return (request: Request) => request.signatureVerified === true;
}

/** Match requests whose server-side signature verification failed. */
export function matchUnverified(): (request: Request) => boolean {
  return (request: Request) => request.signatureVerified === false;
}

/**
 * True for a captured email that carries its parsed message: `kind` is
 * "email" (or, from an older server, the method is EMAIL with an address
 * as the path). Requests from `requests.subscribe()` have no `email`; read
 * the full email with `emails.get(id)`.
 */
export function isEmailRequest(request: Request): request is EmailRequest {
  const looksLikeEmail =
    request.kind === "email" ||
    (request.kind === undefined && request.method === "EMAIL" && !request.path.startsWith("/"));
  return looksLikeEmail && !!request.email;
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function matchesAddress(addresses: EmailAddress[], pattern: string | RegExp): boolean {
  return addresses.some((entry) => {
    const address = entry.address ?? "";
    if (typeof pattern === "string") return address.toLowerCase() === pattern.toLowerCase();
    return testPattern(pattern, entry.name ? `${entry.name} <${address}>` : address);
  });
}

/**
 * Match captured emails by tag, subject, sender or recipient. Composes with
 * `matchAll()` and works as the `match` of `requests.waitFor()` and
 * `captureDuring()`.
 *
 * - `tag`: the address's `+tag`, exactly (`null` for untagged mail)
 * - `subject`: a substring, or a RegExp
 * - `from`: an address (case-insensitive), or a RegExp tested against "Name <address>"
 * - `to`: an address in To, Cc or the address it was delivered to, or a RegExp
 *
 * @example
 * ```ts
 * const request = await client.requests.waitFor(slug, {
 *   match: matchEmail({ tag: runId, subject: "Confirm your email" }),
 * });
 * ```
 */
export function matchEmail(criteria: EmailCriteria = {}): (request: Request) => boolean {
  return (request) => {
    if (!isEmailRequest(request)) return false;
    const { email } = request;
    if (criteria.tag !== undefined && email.tag !== criteria.tag) return false;
    if (criteria.subject !== undefined) {
      const subject = email.subject ?? "";
      const matches =
        typeof criteria.subject === "string"
          ? subject.includes(criteria.subject)
          : testPattern(criteria.subject, subject);
      if (!matches) return false;
    }
    if (criteria.from !== undefined && !matchesAddress(email.from, criteria.from)) return false;
    if (
      criteria.to !== undefined &&
      !matchesAddress(
        [...email.to, ...email.cc, { name: null, address: request.path }],
        criteria.to
      )
    ) {
      return false;
    }
    return true;
  };
}
