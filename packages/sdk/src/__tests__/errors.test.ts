import { describe, it, expect } from "vitest";
import {
  WebhooksCCError,
  UnauthorizedError,
  NotFoundError,
  TimeoutError,
  RateLimitError,
} from "../errors";
import { notFoundHint } from "../client";

describe("WebhooksCCError", () => {
  it("stores statusCode and message", () => {
    const err = new WebhooksCCError(500, "Internal error");
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe("Internal error");
    expect(err.name).toBe("WebhooksCCError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("UnauthorizedError", () => {
  it("has statusCode 401 and default message", () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("Invalid or missing API key");
    expect(err.name).toBe("UnauthorizedError");
    expect(err).toBeInstanceOf(WebhooksCCError);
  });

  it("accepts custom message", () => {
    const err = new UnauthorizedError("Token expired");
    expect(err.message).toBe("Token expired");
  });
});

describe("NotFoundError", () => {
  it("has statusCode 404 and default message", () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Resource not found");
    expect(err.name).toBe("NotFoundError");
    expect(err).toBeInstanceOf(WebhooksCCError);
  });
});

describe("TimeoutError", () => {
  it("has statusCode 0 and timeout message", () => {
    const err = new TimeoutError(5000);
    expect(err.statusCode).toBe(0);
    expect(err.message).toBe("Request timed out after 5000ms");
    expect(err.name).toBe("TimeoutError");
    expect(err).toBeInstanceOf(WebhooksCCError);
  });
});

describe("RateLimitError", () => {
  it("has statusCode 429", () => {
    const err = new RateLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.name).toBe("RateLimitError");
    expect(err).toBeInstanceOf(WebhooksCCError);
  });

  it("stores retryAfter when provided", () => {
    const err = new RateLimitError(30);
    expect(err.retryAfter).toBe(30);
    expect(err.message).toBe("Rate limited, retry after 30s");
  });

  it("has default message when retryAfter is not provided", () => {
    const err = new RateLimitError();
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toBe("Rate limited");
  });

  it("backwards compat: limit/remaining/reset are undefined without meta", () => {
    const err = new RateLimitError(10);
    expect(err.limit).toBeUndefined();
    expect(err.remaining).toBeUndefined();
    expect(err.reset).toBeUndefined();
  });

  it("stores rate limit metadata when provided", () => {
    const meta = { limit: 100, remaining: 0, reset: 1711612800 };
    const err = new RateLimitError(60, meta);
    expect(err.retryAfter).toBe(60);
    expect(err.limit).toBe(100);
    expect(err.remaining).toBe(0);
    expect(err.reset).toBe(1711612800);
  });

  it("stores meta fields independently from retryAfter", () => {
    const meta = { limit: 50, remaining: 3, reset: 1711612900 };
    const err = new RateLimitError(undefined, meta);
    expect(err.retryAfter).toBeUndefined();
    expect(err.limit).toBe(50);
    expect(err.remaining).toBe(3);
    expect(err.reset).toBe(1711612900);
  });

  it("works with zero retryAfter and meta", () => {
    const meta = { limit: 10, remaining: 0, reset: 1711613000 };
    const err = new RateLimitError(0, meta);
    expect(err.retryAfter).toBe(0);
    expect(err.message).toBe("Rate limited, retry after 0s");
    expect(err.limit).toBe(10);
    expect(err.remaining).toBe(0);
    expect(err.reset).toBe(1711613000);
  });
});

describe("notFoundHint", () => {
  it("points each resource at its own list", () => {
    expect(notFoundHint("/approvals/apr_1")).toMatch(/^Only the key or agent that asked/);
    expect(notFoundHint("/api-keys/k1")).toBe("Use client.apiKeys.list() to see your API keys.");
    expect(notFoundHint("/endpoints/acme/destinations/d1")).toBe(
      "Use client.destinations.list(slug) to see the endpoint's destinations."
    );
    expect(notFoundHint("/requests/r1/raw")).toMatch(/^Use client\.requests\.list\(slug\)/);
    expect(notFoundHint("/teams/t1/members")).toBe("Use client.teams.list() to see your teams.");
    expect(notFoundHint("/domains/d1")).toBe("Use client.domains.list() to see your domains.");
    expect(notFoundHint("/billing/checkouts/c1")).toMatch(/createCheckout/);
    expect(notFoundHint("/endpoints/acme")).toBe(
      "Use client.endpoints.list() to see available endpoints."
    );
    expect(notFoundHint(undefined)).toBe("Use client.endpoints.list() to see available endpoints.");
  });
});
