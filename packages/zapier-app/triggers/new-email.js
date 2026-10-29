"use strict";

const { endpointPath, emailRecord, renderEmail } = require("../lib");

/**
 * A new email at an endpoint, with its parsed fields and line items when the
 * endpoint has layouts. A REST hook: turning the Zap on adds a destination
 * that sends each email to Zapier as JSON, turning it off removes it.
 */
module.exports = {
  key: "new_email",
  noun: "Email",
  display: {
    label: "New Email",
    description:
      "Triggers when an endpoint receives an email, with the fields and line items its layouts read.",
  },
  operation: {
    type: "hook",
    inputFields: [
      {
        key: "endpoint",
        label: "Endpoint",
        required: true,
        dynamic: "endpoint.id.name",
        helpText: "The endpoint whose emails start the Zap.",
      },
    ],
    performSubscribe: async (z, bundle) => {
      const response = await z.request({
        url: `${endpointPath(bundle.inputData.endpoint)}/destinations`,
        method: "POST",
        body: {
          url: bundle.targetUrl,
          name: "Zapier",
          format: "json",
          email: true,
          http: false,
        },
      });
      return { id: response.data.id, endpoint: bundle.inputData.endpoint };
    },
    performUnsubscribe: async (z, bundle) => {
      const { id, endpoint } = bundle.subscribeData || {};
      if (!id || !endpoint) return {};
      await z.request({
        url: `${endpointPath(endpoint)}/destinations/${encodeURIComponent(id)}`,
        method: "DELETE",
        skipThrowForStatus: true,
      });
      return {};
    },
    perform: async (z, bundle) => [emailRecord(bundle.cleanedRequest)],
    // Recent emails, rendered as the hook delivers them, for testing the Zap.
    performList: async (z, bundle) => {
      const response = await z.request({
        url: `${endpointPath(bundle.inputData.endpoint)}/requests`,
        params: { kind: "email", limit: 3 },
      });
      const requests = Array.isArray(response.data) ? response.data : [];
      const out = [];
      for (const request of requests.slice(0, 3)) {
        out.push(await renderEmail(z, request.id || request._id));
      }
      return out;
    },
    sample: {
      id: "3f2a9c1e-0000-4000-8000-000000000000",
      type: "email.received",
      endpoint: { slug: "orders-acme", name: "Orders" },
      receivedAt: "2026-10-29T17:33:26.000Z",
      address: "orders-acme@mailhooks.cc",
      subject: "Order #1001 confirmed",
      from: { name: "Acme Store", address: "orders@acme.example" },
      text: "Thanks for your order.\nTotal: $12.50",
      fields: { order: "1001", total: "12.50" },
    },
  },
};
