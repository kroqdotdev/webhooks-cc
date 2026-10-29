"use strict";

const { baseUrl } = require("../lib");

/** A new endpoint, with its HTTP URL and email address. */
module.exports = {
  key: "create_endpoint",
  noun: "Endpoint",
  display: {
    label: "Create Endpoint",
    description: "Creates an endpoint that captures webhooks and emails.",
  },
  operation: {
    inputFields: [{ key: "name", label: "Name", required: false }],
    perform: async (z, bundle) => {
      const response = await z.request({
        url: `${baseUrl()}/api/endpoints`,
        method: "POST",
        body: bundle.inputData.name ? { name: bundle.inputData.name } : {},
      });
      const endpoint = response.data;
      return { ...endpoint, id: endpoint.id || endpoint.slug };
    },
    sample: {
      id: "e3c1f1a0-0000-4000-8000-000000000000",
      slug: "orders-acme",
      name: "Orders",
      url: "https://go.webhooks.cc/w/orders-acme",
      emailAddress: "orders-acme@mailhooks.cc",
    },
  },
};
