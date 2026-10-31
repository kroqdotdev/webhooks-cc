"use strict";

const { endpointPath, emailRecord, renderEmail } = require("../lib");

/** The Zap's id, when Zapier says which Zap is subscribing. */
function zapId(bundle) {
  const zap = bundle.meta && bundle.meta.zap;
  return zap && zap.id ? String(zap.id) : null;
}

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
          // Which Zap it belongs to, for whoever sees it in the dashboard.
          name: zapId(bundle) ? `Zapier (Zap ${zapId(bundle)})` : "Zapier",
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
      const response = await z.request({
        url: `${endpointPath(endpoint)}/destinations/${encodeURIComponent(id)}`,
        method: "DELETE",
        skipThrowForStatus: true,
      });
      // Already gone (removed in the dashboard) is fine; anything else is
      // shown, so a destination is never left sending to a dead hook.
      if (response.status >= 400 && response.status !== 404) {
        throw new z.errors.Error(
          `The Zap's destination could not be removed (webhooks.cc answered ${response.status}).`,
          "ApiError",
          response.status
        );
      }
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
      address: "orders-acme@mailhooks.cc",
      tag: null,
      subject: "Order #1001 confirmed",
      from: { name: "Acme Store", address: "orders@acme.example" },
      to: [{ name: null, address: "orders-acme@mailhooks.cc" }],
      cc: [],
      replyTo: [],
      date: "2026-10-29T17:33:20.000Z",
      messageId: "<1001@acme.example>",
      inReplyTo: null,
      text: "Thanks for your order.\nTotal: $12.50\n",
      html: "<p>Thanks for your order.</p><p>Total: $12.50</p>",
      replyText: "Thanks for your order.\nTotal: $12.50",
      fields: { order: "1001", total: "12.50" },
      attachments: [
        {
          filename: "invoice.pdf",
          contentType: "application/pdf",
          size: 48213,
          contentId: null,
          inline: false,
          url: "https://webhooks.cc/api/attachments/3f2a9c1e-0000-4000-8000-000000000000/0?e=1793900000&s=example",
        },
      ],
      auth: { spf: "pass", dkim: "pass", dmarc: "pass", tls: "TLSv1.3" },
      spam: { score: 0.4, required: 6, action: "no action" },
      headers: { subject: "Order #1001 confirmed", "message-id": "<1001@acme.example>" },
      size: 52100,
      truncated: { text: false, html: false },
      test: false,
    },
  },
};
