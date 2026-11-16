import { isUuid } from "@/lib/uuid";

/**
 * Dynamic segments of API routes that hold a row's UUID. A value that is no
 * UUID can name no row, and handing it to Postgres raises 22P02 (invalid
 * input syntax for type uuid), which a route would answer as a 500 and
 * report; clients read a 500 as "try again later", so an agent with a typo
 * would retry forever. The proxy answers such a path 404 before any route
 * runs (`malformedApiId()`).
 *
 * Every dynamic segment name under app/api is listed here or in
 * `OTHER_SEGMENTS`; api-path-ids.test.ts reads the route tree and fails on a
 * name in neither, so a new route comes with a decision.
 */
export const UUID_SEGMENTS: ReadonlySet<string> = new Set([
  "id",
  "teamId",
  "inviteId",
  "userId",
  "endpointId",
  "issuerId",
  "requestId",
]);

/** Dynamic segments that are not UUIDs; their routes check them themselves. */
export const OTHER_SEGMENTS: ReadonlySet<string> = new Set([
  // Endpoint slugs, blog slugs, preview names.
  "slug",
  "name",
  // Support ticket numbers and attachment positions.
  "number",
  "index",
]);

type Segment = { literal: string } | { param: string };

/** The route tree's dynamic paths, written as /api/requests/[id]/raw. */
export const API_ID_ROUTES: readonly string[] = [
  "/api/agent/registrations/[id]",
  "/api/agent/sandbox/requests/[id]",
  "/api/approvals/[id]",
  "/api/attachments/[id]/[index]",
  "/api/billing/checkouts/[id]",
  "/api/billing/checkouts/[id]/open",
  "/api/billing/checkouts/[id]/review",
  "/api/domains/[id]",
  "/api/domains/[id]/verify",
  "/api/endpoints/[slug]/destinations/[id]",
  "/api/endpoints/[slug]/destinations/[id]/secret",
  "/api/endpoints/[slug]/destinations/[id]/test",
  "/api/integrations/google/connections/[id]",
  "/api/invites/[inviteId]/accept",
  "/api/invites/[inviteId]/decline",
  "/api/request-shares/[id]",
  "/api/requests/[id]",
  "/api/requests/[id]/attachments/[index]",
  "/api/requests/[id]/deliveries",
  "/api/requests/[id]/raw",
  "/api/requests/[id]/render",
  "/api/requests/[id]/replay",
  "/api/requests/[id]/shares",
  "/api/shares/[id]/requests",
  "/api/shares/[id]/stop",
  "/api/support/attachments/[id]",
  "/api/teams/[teamId]",
  "/api/teams/[teamId]/billing/agent-budget",
  "/api/teams/[teamId]/billing/cancel",
  "/api/teams/[teamId]/billing/capacity",
  "/api/teams/[teamId]/billing/checkout",
  "/api/teams/[teamId]/billing/plan",
  "/api/teams/[teamId]/billing/portal",
  "/api/teams/[teamId]/billing/resubscribe",
  "/api/teams/[teamId]/billing/seats",
  "/api/teams/[teamId]/endpoints",
  "/api/teams/[teamId]/endpoints/[endpointId]",
  "/api/teams/[teamId]/idjag-issuers",
  "/api/teams/[teamId]/idjag-issuers/[issuerId]",
  "/api/teams/[teamId]/idjag-issuers/[issuerId]/connect",
  "/api/teams/[teamId]/invite",
  "/api/teams/[teamId]/invites/[inviteId]",
  "/api/teams/[teamId]/leave",
  "/api/teams/[teamId]/members",
  "/api/teams/[teamId]/members/[userId]",
];

function parseRoute(route: string): Segment[] {
  return route
    .split("/")
    .filter(Boolean)
    .map((part) => {
      const match = /^\[(\w+)\]$/.exec(part);
      return match ? { param: match[1] } : { literal: part };
    });
}

const PARSED = API_ID_ROUTES.map(parseRoute);

/**
 * True when `pathname` is one of the routes above with a value that is no
 * UUID in a UUID segment. Static siblings win, as in Next's routing: a
 * static directory beside a UUID segment is never a value (`STATIC_SIBLINGS`).
 * The staff routes under /api/ops are left alone: they validate their own
 * ids and answer anyone else 404 the same way whatever the path.
 */
export function malformedApiId(pathname: string): boolean {
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/ops/")) return false;
  const parts = pathname.split("/").filter(Boolean);
  for (const route of PARSED) {
    if (route.length !== parts.length) continue;
    let bad = false;
    let matches = true;
    for (let i = 0; i < route.length; i += 1) {
      const segment = route[i];
      if ("literal" in segment) {
        if (segment.literal !== parts[i]) {
          matches = false;
          break;
        }
      } else if (UUID_SEGMENTS.has(segment.param)) {
        let value = parts[i];
        try {
          value = decodeURIComponent(value);
        } catch {
          bad = true;
          continue;
        }
        if (!isUuid(value)) bad = true;
      }
    }
    if (matches && bad && !shadowedByStatic(parts)) return true;
  }
  return false;
}

/**
 * Static directories that sit beside a UUID segment (/api/approvals/decide
 * beside /api/approvals/[id]): Next routes them first, so a path through one
 * is never a malformed id.
 */
export const STATIC_SIBLINGS: readonly string[] = [
  "/api/approvals/decide",
  "/api/approvals/review",
  "/api/endpoints/[slug]/destinations/order",
  "/api/endpoints/[slug]/destinations/preview",
];

const PARSED_SIBLINGS = STATIC_SIBLINGS.map(parseRoute);

function shadowedByStatic(parts: string[]): boolean {
  return PARSED_SIBLINGS.some(
    (sibling) =>
      sibling.length <= parts.length &&
      sibling.every((segment, i) => !("literal" in segment) || segment.literal === parts[i])
  );
}

/** The answer for such a path, in the shape every API error has. */
export function malformedApiIdResponse(): Response {
  return Response.json(
    { error: "not_found", message: "Not found: that id is not a valid id." },
    { status: 404 }
  );
}
