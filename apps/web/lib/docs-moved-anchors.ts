/**
 * Sections of the SDK API reference that moved from `/docs/sdk/api` to a page
 * of their own (the page was 1.2 MB). A link or a bookmark to
 * `/docs/sdk/api#emails` still works: the browser never sends the fragment, so
 * `MovedAnchors` reads it on the old page and goes to the new one.
 * `docs-moved-anchors.test.ts` checks every target heading exists.
 */
export const MOVED_ANCHORS: Record<string, Record<string, string>> = {
  "sdk/api": {
    requests: "/docs/sdk/api/requests",
    "provider-detection": "/docs/sdk/api/requests",
    "body-parsing": "/docs/sdk/api/requests",
    "payload-schemas": "/docs/sdk/api/requests",
    "request-diffing": "/docs/sdk/api/requests",
    emails: "/docs/sdk/api/emails",
    "codes-and-links": "/docs/sdk/api/emails",
    "the-email-entry-point": "/docs/sdk/api/emails",
    forwarding: "/docs/sdk/api/forwarding",
    destinations: "/docs/sdk/api/forwarding",
    alerts: "/docs/sdk/api/forwarding",
    templates: "/docs/sdk/api/forwarding",
    teams: "/docs/sdk/api/teams-sharing",
    "sharing-localhost": "/docs/sdk/api/teams-sharing",
    "flow-builder": "/docs/sdk/api/teams-sharing",
    "sandbox-and-agent-registration": "/docs/sdk/api/teams-sharing",
    matchers: "/docs/sdk/api/types",
    "signature-verification": "/docs/sdk/api/types",
    "duration-strings": "/docs/sdk/api/types",
    types: "/docs/sdk/api/types",
    "error-classes": "/docs/sdk/api/types",
  },
};
