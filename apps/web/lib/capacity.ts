/**
 * Extra request capacity on top of a plan (migration 00065): recurring
 * blocks, one-time blocks and metered overage, for Pro accounts and team
 * pools alike. Display prices live here; Polar holds the charged ones, so the
 * two change together.
 */

/** Requests in one block, recurring or one-time. Matches capacity_block_requests() in SQL. */
export const BLOCK_REQUESTS = 25_000;

/** A recurring block, per billing period. */
export const MONTHLY_BLOCK_CENTS = 200;
/** A one-time block. */
export const ONE_TIME_BLOCK_CENTS = 300;
/** Overage, per 25,000 requests ($0.16 per 1,000). Polar charges it per request. */
export const OVERAGE_BLOCK_CENTS = 400;

/** Upper bound for any one purchase or setting, in blocks (10 million requests). */
export const MAX_BLOCKS = 400;

/** How far the block sliders reach, in requests; larger amounts can be typed. */
export const SLIDER_MAX_REQUESTS = 500_000;

/**
 * An amount of requests a customer typed, as whole blocks: separators are
 * ignored, a partial block rounds up to the next 25,000, and the result is
 * kept within minBlocks..MAX_BLOCKS. Null when no number was typed.
 */
export function parseRequestAmount(
  text: string,
  { minBlocks = 0 }: { minBlocks?: number } = {}
): { blocks: number; adjusted: boolean } | null {
  const digits = text.trim().replace(/[\s,._']/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const requests = Number(digits);
  if (!Number.isSafeInteger(requests)) return null;
  const blocks = Math.min(MAX_BLOCKS, Math.max(minBlocks, Math.ceil(requests / BLOCK_REQUESTS)));
  return { blocks, adjusted: blocks * BLOCK_REQUESTS !== requests };
}

/** The overage maximum a customer starts with when turning overage on: $20. */
export const DEFAULT_OVERAGE_MAX_REQUESTS = 5 * BLOCK_REQUESTS;

/** The meter event the web app reports overage under (the Polar meter filters on it). */
export const OVERAGE_EVENT_NAME = "request.overage";

/** What overage costs for a number of requests, in cents, rounded like an invoice line. */
export function overageCents(requests: number): number {
  return Math.round((Math.max(0, requests) * OVERAGE_BLOCK_CENTS) / BLOCK_REQUESTS);
}

/** Whole blocks in a request count, or null when it is not a positive multiple of a block. */
export function blocksFromRequests(requests: number): number | null {
  if (!Number.isInteger(requests) || requests <= 0 || requests % BLOCK_REQUESTS !== 0) return null;
  return requests / BLOCK_REQUESTS;
}

/** A block count from user input, or null when it is outside 1..MAX_BLOCKS. */
export function parseBlockCount(value: unknown, { allowZero = false } = {}): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < (allowZero ? 0 : 1) || value > MAX_BLOCKS) return null;
  return value;
}

/**
 * Overage counted in the current plan period. capture_webhook() stamps the
 * period it counted in, so a count from an earlier period reads as none.
 * Like SQL's "is not distinct from", two nulls are the same period.
 */
export function periodOverageUsed(account: {
  overage_used: number;
  overage_period_start: string | null;
  period_start: string | null;
}): number {
  return account.overage_period_start === account.period_start ? account.overage_used : 0;
}

/** The fields of a users or teams row that decide whether a capture is still accepted. */
export interface CapacityFields {
  requests_used: number;
  request_limit: number;
  block_requests: number;
  credit_requests: number;
  overage_active: boolean;
  overage_max: number;
  overage_used: number;
  overage_period_start: string | null;
  period_start: string | null;
  period_end: string | null;
}

/** The allowance for the period: the plan plus recurring blocks. */
export function allowance(
  account: Pick<CapacityFields, "request_limit" | "block_requests">
): number {
  return account.request_limit + account.block_requests;
}

/**
 * True while captures for the account are turned away with 429: the
 * allowance is used up, no one-time blocks are left, and overage is off or
 * at its maximum. Mirrors take_extra_request() in SQL; an expired period
 * never counts as exhausted, because the next capture starts a new one.
 */
export function isCapacityExhausted(account: CapacityFields | null, nowMs: number): boolean {
  if (!account || !account.period_end) return false;
  const periodEndMs = Date.parse(account.period_end);
  if (!Number.isFinite(periodEndMs) || periodEndMs <= nowMs) return false;
  if (allowance(account) <= 0 && account.credit_requests <= 0 && !account.overage_active) {
    return false;
  }
  if (account.requests_used < allowance(account)) return false;
  if (account.credit_requests > 0) return false;
  if (account.overage_active && periodOverageUsed(account) < account.overage_max) return false;
  return true;
}

/** Requests still accepted this period, across the allowance, one-time blocks and overage. */
export function remainingCapacity(account: CapacityFields): number {
  const allowanceLeft = Math.max(0, allowance(account) - account.requests_used);
  const overageLeft = account.overage_active
    ? Math.max(0, account.overage_max - periodOverageUsed(account))
    : 0;
  return allowanceLeft + Math.max(0, account.credit_requests) + overageLeft;
}
