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
      // The slug as id, as the endpoint list gives it: the actions that take
      // an endpoint (Send Test Email, the triggers) take its slug.
      return { ...endpoint, id: endpoint.slug, endpointId: endpoint.id };
    },
    sample: {
      id: "orders-acme",
      endpointId: "e3c1f1a0-0000-4000-8000-000000000000",
      slug: "orders-acme",
      name: "Orders",
      url: "https://go.webhooks.cc/w/orders-acme",
      emailAddress: "orders-acme@mailhooks.cc",
    },
  },
};
