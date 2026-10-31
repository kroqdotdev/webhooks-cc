"use strict";

/**
 * Shared by the app's triggers, actions and searches: where the API is, and
 * how an email reads in a Zap (the email.received JSON's `data`, which is
 * what a REST hook delivers and what the sample request renders).
 */

/** The API's origin; tests point it at a local server. */
function baseUrl() {
  return (process.env.WHK_BASE_URL || "https://webhooks.cc").replace(/\/+$/, "");
}

function endpointPath(slug) {
  return `${baseUrl()}/api/endpoints/${encodeURIComponent(slug)}`;
}

/** An email.received payload as a Zap's record: its data, with the type. */
function emailRecord(payload) {
  const data = (payload && payload.data) || {};
  return { ...data, id: data.id, type: payload && payload.type };
}

/** The email JSON of a captured request, as a hook would deliver it. */
async function renderEmail(z, requestId) {
  const response = await z.request({
    url: `${baseUrl()}/api/requests/${encodeURIComponent(requestId)}/render`,
    method: "POST",
    body: { format: "json" },
  });
  // The route answers the request a handler would get: the payload is its body.
  return emailRecord(JSON.parse(response.data.body));
}

module.exports = { baseUrl, endpointPath, emailRecord, renderEmail };
