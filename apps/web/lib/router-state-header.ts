/**
 * Next's client router sends the page's route tree in `Next-Router-State-Tree`
 * on every RSC fetch (`RSC: 1`), written by `prepareFlightRouterStateForRequest`
 * as `encodeURIComponent(JSON.stringify(tree))`. Next validates it while
 * rendering (`parseAndValidateFlightRouterState`) and throws on a header it
 * cannot use, which makes the request a 500 and an `onRequestError` report.
 * Only scanners send such a header.
 *
 * The proxy cannot refuse it: Next's adapter removes the RSC headers from the
 * request the proxy sees and puts them back afterwards. A `next.config.ts`
 * rewrite matches the real headers, so one sends an RSC request whose header
 * is plainly not what the client writes to `ROUTER_STATE_REFUSED_PATH`, a
 * route that answers 400 without rendering anything.
 *
 * "Plainly" is a check on the form, not the content: the client's header is
 * an encoded JSON array, so it starts with `%5B` (`[`), holds nothing but the
 * characters `encodeURIComponent` leaves alone and `%XX` escapes, and is at
 * most Next's own 40,000 characters. That stays true whatever Next changes
 * inside the tree, so a real navigation is never refused. A header of that
 * form that still fails Next's schema (well-formed JSON of the wrong shape),
 * and an empty one (a rewrite's `has` treats an empty header as absent), is a
 * 500 that `isRouterStateHeaderError()` keeps out of error reports.
 */

/** The header's name, as Next's app-router-headers spells it. */
export const ROUTER_STATE_HEADER = "next-router-state-tree";

/** Next's own limit (20 characters a segment state, 2,000 of them). */
export const ROUTER_STATE_MAX_LENGTH = 20 * 2000;

/** Where the rewrite sends an RSC request with a malformed header. */
export const ROUTER_STATE_REFUSED_PATH = "/router-state-refused";

/** A header of the form `encodeURIComponent` gives a JSON array. */
const WELL_FORMED = `(?=.{1,${ROUTER_STATE_MAX_LENGTH}}$)%5B(?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-Fa-f]{2})*`;

/**
 * Any header value not of that form, for a rewrite's `has` (Next anchors the
 * pattern with ^ and $). The two alternatives inside are disjoint, so
 * matching is linear in the header's length.
 */
export const MALFORMED_ROUTER_STATE = `(?!${WELL_FORMED}$).*`;

const malformed = new RegExp(`^${MALFORMED_ROUTER_STATE}$`);

/** Whether the rewrite refuses this header value, the way Next applies the pattern. */
export function malformedRouterState(value: string): boolean {
  return malformed.test(value);
}

/** The messages parseAndValidateFlightRouterState throws (Next 16). */
export const ROUTER_STATE_ERRORS: ReadonlySet<string> = new Set([
  "The router state header was sent but could not be parsed.",
  "Multiple router state headers were sent. This is not allowed.",
  "The router state header was too large.",
]);

/**
 * Whether a request error is Next refusing a router state header: a bad
 * request, never our fault, so it is not reported. Only reached for a header
 * of the right form that the rewrite let through.
 */
export function isRouterStateHeaderError(error: unknown): boolean {
  return error instanceof Error && ROUTER_STATE_ERRORS.has(error.message);
}
