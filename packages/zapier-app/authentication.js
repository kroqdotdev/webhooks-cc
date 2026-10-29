"use strict";

const { baseUrl } = require("./lib");

/**
 * An API key from Account > API keys, sent as a bearer token. The test reads
 * the account's usage, which any key may.
 */
module.exports = {
  type: "custom",
  fields: [
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      helpText:
        "Create one on webhooks.cc (or mailhooks.cc) under **Account > API keys**. Keys start with `whcc_`.",
    },
  ],
  test: async (z) => {
    const response = await z.request({ url: `${baseUrl()}/api/usage` });
    return response.data;
  },
  connectionLabel: (z, bundle) =>
    bundle.inputData && bundle.inputData.plan
      ? `webhooks.cc (${bundle.inputData.plan})`
      : "webhooks.cc",
};
