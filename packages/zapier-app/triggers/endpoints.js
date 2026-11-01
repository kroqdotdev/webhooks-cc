"use strict";

const { baseUrl } = require("../lib");

/** The account's endpoints, for choosing one in other steps (hidden). */
module.exports = {
  key: "endpoint",
  noun: "Endpoint",
  display: {
    label: "List Endpoints",
    description: "Lists your endpoints, for choosing one in other steps.",
    hidden: true,
  },
  operation: {
    perform: async (z) => {
      const response = await z.request({ url: `${baseUrl()}/api/endpoints` });
      const data = response.data;
      const list = Array.isArray(data) ? data : (data && (data.owned || data.endpoints)) || [];
      return list.map((endpoint) => ({
        id: endpoint.slug,
        slug: endpoint.slug,
        name: endpoint.name || endpoint.slug,
        emailAddress: endpoint.emailAddress || null,
      }));
    },
    sample: {
      id: "orders-acme",
      slug: "orders-acme",
      name: "Orders",
      emailAddress: "orders-acme@mailhooks.cc",
    },
  },
};
