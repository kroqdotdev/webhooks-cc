import type { WebhooksCC } from "./client";
import { diffRequests, type DiffResult } from "./diff";
import { waitTimeoutMessage } from "./client";
import { NotFoundError, RateLimitError, TimeoutError } from "./errors";
import type {
  CreateEndpointOptions,
  EmailCriteria,
  EmailRequest,
  Endpoint,
  Request,
} from "./types";
import { parseDuration } from "./utils";

const MIN_CAPTURE_POLL_INTERVAL = 10;
const DEFAULT_CAPTURE_LIMIT = 100;

type TestingClient = Pick<WebhooksCC, "endpoints" | "requests">;

export interface AssertRequestExpectation {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyJson?: Record<string, unknown>;
}

export interface AssertRequestOptions {
  ignoreHeaders?: string[];
  throwOnFailure?: boolean;
}

export interface AssertRequestResult {
  pass: boolean;
  diff: DiffResult;
}

export interface WithEndpointOptions extends CreateEndpointOptions {
  /**
   * How long, in all, to wait when creating endpoints is rate limited
   * (default 60 seconds). Each wait is what the API's Retry-After asks; when
   * that would run past this, the helper fails at once with a
   * RateLimitError that says so.
   */
  rateLimitWait?: number | string;
}

export interface CaptureDuringOptions extends WithEndpointOptions {
  timeout?: number | string;
  pollInterval?: number | string;
  count?: number;
  match?: (request: Request) => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeExpectedJson(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return expected;
    }
    return expected.map((value, index) => mergeExpectedJson(actual[index], value));
  }

  if (isPlainObject(expected)) {
    const base = isPlainObject(actual) ? { ...actual } : {};
    for (const [key, value] of Object.entries(expected)) {
      base[key] = mergeExpectedJson(base[key], value);
    }
    return base;
  }

  return expected;
}

function parseRequestJsonBody(body: string | undefined): unknown {
  if (!body) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function formatAssertionError(diff: DiffResult): string {
  return `Request assertion failed:\n${JSON.stringify(diff.differences, null, 2)}`;
}

async function cleanupEndpoint(client: TestingClient, slug: string): Promise<void> {
  try {
    await client.endpoints.delete(slug);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits between tries when a 429 named no Retry-After. */
const RATE_LIMIT_FALLBACK_WAIT_MS = 5000;

/**
 * Creates an endpoint for a test. A test suite that makes one per test can
 * reach the API's limit on new endpoints (30 per account in 10 minutes by
 * default); this waits as the API's Retry-After asks, for up to
 * `rateLimitWait` in all, and otherwise fails with one line that says what
 * to do. For large suites, share one endpoint between tests (create it in
 * `beforeAll`, and tell tests apart by what they send or by `since`).
 */
export async function createTestEndpoint(
  client: Pick<WebhooksCC, "endpoints">,
  options: WithEndpointOptions = {}
): Promise<Endpoint> {
  const { rateLimitWait = 60_000, ...createOptions } = options;
  const budgetMs = parseDuration(rateLimitWait);
  const startedAt = Date.now();
  for (;;) {
    try {
      return await client.endpoints.create(createOptions);
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      const waitMs =
        error.retryAfter !== undefined ? error.retryAfter * 1000 : RATE_LIMIT_FALLBACK_WAIT_MS;
      if (Date.now() - startedAt + waitMs > budgetMs) {
        throw endpointRateLimitError(error);
      }
      await sleep(waitMs);
    }
  }
}

/** The 429 from creating an endpoint, saying what to do about it. */
function endpointRateLimitError(error: RateLimitError): RateLimitError {
  const limited = new RateLimitError(
    error.retryAfter,
    error.limit !== undefined && error.remaining !== undefined && error.reset !== undefined
      ? { limit: error.limit, remaining: error.remaining, reset: error.reset }
      : undefined
  );
  const allowance =
    error.limit !== undefined ? `: the limit is ${error.limit} in a rolling window` : "";
  const next =
    error.retryAfter !== undefined ? `; the next one is free in ${error.retryAfter}s` : "";
  limited.message =
    `webhooks.cc: too many new endpoints${allowance}${next}. ` +
    "Share one endpoint between tests (create it in beforeAll), or run fewer tests that create one.";
  limited.apiMessage = error.apiMessage;
  limited.code = error.code;
  limited.path = error.path;
  return limited;
}

export async function withEndpoint<T>(
  client: TestingClient,
  callback: (endpoint: Endpoint) => Promise<T>,
  options: WithEndpointOptions = {}
): Promise<T> {
  const endpoint = await createTestEndpoint(client, options);
  try {
    return await callback(endpoint);
  } finally {
    await cleanupEndpoint(client, endpoint.slug);
  }
}

export async function withEphemeralEndpoint<T>(
  client: TestingClient,
  callback: (endpoint: Endpoint) => Promise<T>,
  options: Omit<WithEndpointOptions, "ephemeral"> = {}
): Promise<T> {
  return withEndpoint(client, callback, {
    ...options,
    ephemeral: true,
  });
}

export async function captureDuring(
  client: TestingClient,
  action: (endpoint: Endpoint) => Promise<unknown>,
  options: CaptureDuringOptions = {}
): Promise<Request[]> {
  const { timeout = 30000, pollInterval = 200, count = 1, match, ...createOptions } = options;

  const timeoutMs = parseDuration(timeout);
  const pollIntervalMs = Math.max(MIN_CAPTURE_POLL_INTERVAL, parseDuration(pollInterval));
  const expectedCount = Math.max(1, Math.floor(count));
  const requestLimit = Math.max(DEFAULT_CAPTURE_LIMIT, expectedCount * 5);

  return withEndpoint(
    client,
    async (endpoint) => {
      const startedAt = Date.now();
      await action(endpoint);

      let seen = 0;
      let matchedCount = 0;
      while (Date.now() - startedAt < timeoutMs) {
        const requests = await client.requests.list(endpoint.slug, { limit: requestLimit });
        const matched = (match ? requests.filter(match) : requests)
          .slice()
          .sort((left, right) => left.receivedAt - right.receivedAt);

        if (matched.length >= expectedCount) {
          return matched.slice(0, expectedCount);
        }
        seen = requests.length;
        matchedCount = matched.length;

        await sleep(pollIntervalMs);
      }

      throw new TimeoutError(
        timeoutMs,
        waitTimeoutMessage(
          timeoutMs,
          { noun: "request", slug: endpoint.slug },
          { wanted: expectedCount, matched: matchedCount, seen, filtered: match !== undefined }
        )
      );
    },
    createOptions
  );
}

export interface CaptureEmailDuringOptions extends WithEndpointOptions, EmailCriteria {
  /** Maximum time to wait for the emails (default: 60000) */
  timeout?: number | string;
  /** Interval between polls (default: 1000) */
  pollInterval?: number | string;
  /** Number of emails to collect (default: 1) */
  count?: number;
  /** Extra filter on top of the criteria */
  match?: (email: EmailRequest) => boolean;
}

/**
 * Creates a temporary endpoint, runs `action` with its email address, waits
 * for the email(s) it triggers, then deletes the endpoint. With `tag`, the
 * address carries it and only mail to that tag counts.
 *
 * @example
 * ```ts
 * const [email] = await captureEmailDuring(client, async (address) => {
 *   await signUp(address);
 * }, { subject: "Confirm your email" });
 * expect(extractCode(email)).toMatch(/^\d{6}$/);
 * ```
 */
export async function captureEmailDuring(
  client: Pick<WebhooksCC, "endpoints" | "requests" | "emails">,
  action: (address: string, endpoint: Endpoint) => Promise<unknown>,
  options: CaptureEmailDuringOptions = {}
): Promise<EmailRequest[]> {
  const {
    timeout = 60000,
    pollInterval = 1000,
    count = 1,
    match,
    tag,
    subject,
    from,
    to,
    ...createOptions
  } = options;

  return withEndpoint(
    client,
    async (endpoint) => {
      await action(client.emails.address(endpoint, tag ?? undefined), endpoint);
      return client.emails.waitForAll(endpoint.slug, {
        count,
        timeout,
        pollInterval,
        // A new endpoint: everything it received counts, measured on the server's clock.
        since: endpoint.createdAt,
        match,
        tag,
        subject,
        from,
        to,
      });
    },
    createOptions
  );
}

export function assertRequest(
  request: Request,
  expected: AssertRequestExpectation,
  options: AssertRequestOptions = {}
): AssertRequestResult {
  if (expected.body !== undefined && expected.bodyJson !== undefined) {
    throw new Error("assertRequest accepts either body or bodyJson, not both");
  }

  const comparable: Request = {
    ...request,
    method: expected.method ?? request.method,
    path: expected.path ?? request.path,
    headers: expected.headers ? { ...request.headers, ...expected.headers } : request.headers,
  };

  if (expected.body !== undefined) {
    comparable.body = expected.body;
  } else if (expected.bodyJson !== undefined) {
    const actualJson = parseRequestJsonBody(request.body);
    comparable.body = JSON.stringify(mergeExpectedJson(actualJson, expected.bodyJson));
  }

  const diff = diffRequests(request, comparable, {
    ignoreHeaders: options.ignoreHeaders,
  });
  const result = { pass: diff.matches, diff };

  if (!result.pass && options.throwOnFailure) {
    throw new Error(formatAssertionError(diff));
  }

  return result;
}
