"use strict";

const { baseUrl } = require("../lib");

/** A sample email delivered to an endpoint, to try a Zap end to end. */
module.exports = {
  key: "send_test_email",
  noun: "Test Email",
  display: {
    label: "Send Test Email",
    description: "Delivers a sample email to an endpoint (it counts as one request).",
  },
  operation: {
    inputFields: [
      { key: "endpoint", label: "Endpoint", required: true, dynamic: "endpoint.id.name" },
      { key: "tag", label: "Tag", required: false, helpText: "Delivered to endpoint+tag@..." },
    ],
    perform: async (z, bundle) => {
      const response = await z.request({
        url: `${baseUrl()}/api/send-test-email`,
        method: "POST",
        body: {
          slug: bundle.inputData.endpoint,
          ...(bundle.inputData.tag ? { tag: bundle.inputData.tag } : {}),
        },
      });
      const data = response.data || {};
      return { ...data, id: data.requestId || data.id || bundle.inputData.endpoint };
    },
    sample: {
      id: "3f2a9c1e-0000-4000-8000-000000000000",
      requestId: "3f2a9c1e-0000-4000-8000-000000000000",
    },
  },
};
