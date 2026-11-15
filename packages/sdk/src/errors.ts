/**
 * Base error class for all webhooks.cc SDK errors.
 * Extends the standard Error with an HTTP status code.
 */
export class WebhooksCCError extends Error {
  /**
   * The API's error code, when its answer named one: `invalid_cursor` (a
   * search cursor the server did not issue), `search_busy` (a 429 because the
   * account already runs its searches), `invalid_q` and the like.
   */
  public code?: string;

  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "WebhooksCCError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the API key is invalid or missing (401). */
export class UnauthorizedError extends WebhooksCCError {
  constructor(message = "Invalid or missing API key") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown when the requested resource does not exist (404). */
export class NotFoundError extends WebhooksCCError {
  constructor(message = "Resource not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a request times out, or when a `requests.subscribe()` stream goes
 * idle (no data or keepalive within `idleTimeout`) and `reconnect` is disabled.
 */
export class TimeoutError extends WebhooksCCError {
  constructor(timeoutMs: number, message = `Request timed out after ${timeoutMs}ms`) {
    super(0, message);
    this.name = "TimeoutError";
  }
}

/** The account's owner refused the approval on its page ("This wasn't me"). */
export class ApprovalDeniedError extends WebhooksCCError {
  constructor(
    public readonly approvalId: string,
    message = "The approval was refused on its approval page."
  ) {
    super(0, message);
    this.name = "ApprovalDeniedError";
  }
}

/** Nobody answered the approval in time, or its result was not collected in time. Ask again. */
export class ApprovalExpiredError extends WebhooksCCError {
  constructor(
    public readonly approvalId: string,
    message = "The approval expired before it was answered and collected. Ask again."
  ) {
    super(0, message);
    this.name = "ApprovalExpiredError";
  }
}

/** What CheckoutExpiredError says for a link that may have been paid (`reason` "unsettled"). */
const UNSETTLED_CHECKOUT_MESSAGE =
  "The checkout link expired before Polar confirmed a payment for it. If the person paid, it is still applied to the account once Polar confirms it, and webhooks.cc has been alerted; check billing before making a new link.";

/**
 * A checkout link expired before the person paid. Make a new one if they
 * still want it. `reason` is "unsettled" when it expired while Polar never
 * said it was unpaid (a payment still being confirmed a day later, or
 * Polar not answering): the person may have paid, and a payment that
 * lands still turns the link paid, so check billing first.
 */
export class CheckoutExpiredError extends WebhooksCCError {
  public readonly reason: "unsettled" | null;

  constructor(
    public readonly checkoutId: string,
    message?: string,
    reason: "unsettled" | null = null
  ) {
    super(
      0,
      message ??
        (reason === "unsettled"
          ? UNSETTLED_CHECKOUT_MESSAGE
          : "The checkout link expired before it was paid. Make a new one if the person still wants it.")
    );
    this.name = "CheckoutExpiredError";
    this.reason = reason;
  }
}

/**
 * A checkout link was paid, but the webhook undid the purchase as a
 * duplicate: the account already had that plan or add-on (or the
 * subscription it added to had ended), so its subscription was ended and a
 * refund of what it charged is under review (monthly blocks bought twice
 * stay as one-time blocks; a second overage subscription charged nothing).
 * A CheckoutExpiredError too, so code that handles a link that did not buy
 * anything handles this one.
 */
export class CheckoutSupersededError extends CheckoutExpiredError {
  constructor(checkoutId: string) {
    super(
      checkoutId,
      "By the time this checkout was paid, the account already had what it buys (or what it added to had ended), so the purchase was undone: its subscription was ended and a refund of what it charged is under review. Monthly blocks bought twice stay on the account as one-time blocks instead, and a second overage subscription was ended before it charged anything."
    );
    this.name = "CheckoutSupersededError";
  }
}

/** Rate limit metadata from X-RateLimit-* response headers. */
export interface RateLimitMeta {
  /** Maximum number of requests allowed in the current window. */
  limit: number;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Unix epoch timestamp (seconds) when the rate limit window resets. */
  reset: number;
}

/** Thrown when the API returns 429 Too Many Requests. */
export class RateLimitError extends WebhooksCCError {
  /** Seconds until the rate limit resets, if provided by the server. */
  public readonly retryAfter?: number;
  /** Maximum number of requests allowed in the current window. */
  public readonly limit?: number;
  /** Number of requests remaining in the current window. */
  public readonly remaining?: number;
  /** Unix epoch timestamp (seconds) when the rate limit window resets. */
  public readonly reset?: number;

  constructor(retryAfter?: number, meta?: RateLimitMeta) {
    const message =
      retryAfter !== undefined ? `Rate limited, retry after ${retryAfter}s` : "Rate limited";
    super(429, message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
    if (meta) {
      this.limit = meta.limit;
      this.remaining = meta.remaining;
      this.reset = meta.reset;
    }
  }
}

/** Why `verifyForwardedEmail()`, `verifyForwardedRequest()` or `verifyRelayedRequest()` rejected a delivery. */
export type WebhookVerificationErrorCode =
  "missing_headers" | "timestamp_out_of_range" | "invalid_signature" | "invalid_payload";

/**
 * Thrown by `verifyForwardedEmail()`, `verifyForwardedRequest()` and
 * `verifyRelayedRequest()` when a request is not a genuine forwarded
 * delivery. Answer it with 401 (or 400 for `invalid_payload`).
 */
export class WebhookVerificationError extends Error {
  constructor(
    public readonly code: WebhookVerificationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
