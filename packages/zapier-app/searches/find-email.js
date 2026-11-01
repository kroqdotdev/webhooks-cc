"use strict";

const { baseUrl, renderEmail } = require("../lib");

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
      const response = await z.request({
        url: `${baseUrl()}/api/search/requests`,
        params: {
          slug: bundle.inputData.endpoint,
          q: bundle.inputData.query,
          kind: "email",
          limit: 1,
        },
      });
      const data = response.data;
      const list = Array.isArray(data) ? data : (data && (data.requests || data.results)) || [];
      if (list.length === 0) return [];
      return [await renderEmail(z, list[0].id || list[0]._id)];
    },
    sample: {
      id: "3f2a9c1e-0000-4000-8000-000000000000",
      type: "email.received",
      subject: "Order #1001 confirmed",
    },
  },
};
