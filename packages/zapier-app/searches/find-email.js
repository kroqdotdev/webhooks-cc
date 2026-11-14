"use strict";

const { baseUrl, renderEmail } = require("../lib");

// How long Find Email keeps searching. Each page of a search reads for about
// 2 seconds and says how far back it got; Zapier ends a step at 30 seconds,
// and the email found still has to be fetched, so stop starting pages here.
const SEARCH_DEADLINE_MS = 20_000;
// A page can take a little over its 2 seconds; do not start one this close
// to the deadline.
const PAGE_MS = 2_500;

/**
 * The newest email at an endpoint containing the text, following the
 * search's cursor back through older requests until one matches, the
 * search has read everything, or the deadline passes (then nothing found).
 */
async function findNewest(z, bundle) {
  const stopAt = Date.now() + SEARCH_DEADLINE_MS;
  let cursor = null;
  for (;;) {
    const params = {
      slug: bundle.inputData.endpoint,
      q: bundle.inputData.query,
      kind: "email",
      limit: 1,
      paged: "true",
    };
    if (cursor) params.cursor = cursor;
    const response = await z.request({ url: `${baseUrl()}/api/search/requests`, params });
    const data = response.data;
    const list = Array.isArray(data) ? data : (data && (data.requests || data.results)) || [];
    if (list.length > 0) return list[0];
    cursor = response.getHeader("x-search-cursor");
    const complete = response.getHeader("x-search-complete") !== "false";
    if (complete || !cursor || Date.now() + PAGE_MS > stopAt) return null;
  }
}

/** The newest email at an endpoint whose subject, sender or text contains a word. */
module.exports = {
  key: "find_email",
  noun: "Email",
  display: {
    label: "Find Email",
    description: "Finds the newest email at an endpoint that contains the text you give.",
  },
  operation: {
    inputFields: [
      { key: "endpoint", label: "Endpoint", required: true, dynamic: "endpoint.id.name" },
      { key: "query", label: "Contains", required: true },
    ],
    perform: async (z, bundle) => {
      const found = await findNewest(z, bundle);
      if (!found) return [];
      return [await renderEmail(z, found.id || found._id)];
    },
    sample: {
      id: "3f2a9c1e-0000-4000-8000-000000000000",
      type: "email.received",
      subject: "Order #1001 confirmed",
    },
  },
};
