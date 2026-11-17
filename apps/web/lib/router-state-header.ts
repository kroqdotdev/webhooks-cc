/**
 * Next's client router sends the page's route tree in `Next-Router-State-Tree`
 * on every RSC fetch (`RSC: 1`), URI-encoded JSON of a FlightRouterState.
 * Next validates it while rendering (parseAndValidateFlightRouterState) and
 * throws on a header it cannot use, which makes the request a 500 and an
 * `onRequestError` report. Only scanners send such a header, so the proxy
 * answers them 400 before anything renders (`malformedRouterState()`).
 *
 * The check is deliberately looser than Next's schema: a header Next's own
 * client sends must never be refused here, and Next changes the tree's
 * details between versions (segment tuples, refresh markers, prefetch hints).
 * It checks what every version so far has had in common: a tree is an array
 * of a segment (a string or an array) and an object of child trees. A header
 * that passes this and still fails Next's schema is left out of error
 * reports by `isRouterStateHeaderError()` instead.
 */

/** Next's own limit (20 characters a segment state, 2,000 of them). */
export const ROUTER_STATE_MAX_LENGTH = 20 * 2000;

/** The header's name, as Next's app-router-headers spells it. */
export const ROUTER_STATE_HEADER = "next-router-state-tree";

function isTree(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [segment, children] = value;
  if (typeof segment !== "string" && !Array.isArray(segment)) return false;
  if (children === null || typeof children !== "object" || Array.isArray(children)) return false;
  return Object.values(children).every(isTree);
}

/**
 * Whether a router state header is one Next would refuse: too large,
 * not URI-encoded JSON, or not shaped like a route tree. A duplicated header
 * reaches the proxy joined with ", ", which is no JSON, so it is refused too.
 * No header at all is fine.
 */
export function malformedRouterState(value: string | null): boolean {
  if (value === null) return false;
  if (value.length > ROUTER_STATE_MAX_LENGTH) return true;
  let state: unknown;
  try {
    state = JSON.parse(decodeURIComponent(value));
  } catch {
    return true;
  }
  return !isTree(state);
}

/** The messages parseAndValidateFlightRouterState throws (Next 16). */
const ROUTER_STATE_ERRORS: ReadonlySet<string> = new Set([
  "The router state header was sent but could not be parsed.",
  "Multiple router state headers were sent. This is not allowed.",
  "The router state header was too large.",
]);

/**
 * Whether a request error is Next refusing a router state header: a bad
 * request, never our fault, so it is not reported. Only reached for a header
 * the proxy's looser check let through.
 */
export function isRouterStateHeaderError(error: unknown): boolean {
  return error instanceof Error && ROUTER_STATE_ERRORS.has(error.message);
}
