import type { WebhooksCC } from "./client";
import { diffRequests, type DiffResult } from "./diff";
import { NotFoundError, TimeoutError } from "./errors";
import type { CreateEndpointOptions, Endpoint, Request } from "./types";
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

export interface CaptureDuringOptions extends CreateEndpointOptions {
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

export async function withEndpoint<T>(
  client: TestingClient,
  callback: (endpoint: Endpoint) => Promise<T>,
  options: CreateEndpointOptions = {}
): Promise<T> {
  const endpoint = await client.endpoints.create(options);
  try {
    return await callback(endpoint);
  } finally {
    await cleanupEndpoint(client, endpoint.slug);
  }
}

export async function withEphemeralEndpoint<T>(
  client: TestingClient,
  callback: (endpoint: Endpoint) => Promise<T>,
  options: Omit<CreateEndpointOptions, "ephemeral"> = {}
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

      while (Date.now() - startedAt < timeoutMs) {
        const requests = await client.requests.list(endpoint.slug, { limit: requestLimit });
        const matched = (match ? requests.filter(match) : requests)
          .slice()
          .sort((left, right) => left.receivedAt - right.receivedAt);

        if (matched.length >= expectedCount) {
          return matched.slice(0, expectedCount);
        }

        await sleep(pollIntervalMs);
      }

      throw new TimeoutError(timeoutMs);
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
