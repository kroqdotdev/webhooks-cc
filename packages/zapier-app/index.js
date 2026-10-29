"use strict";

const { version } = require("./package.json");
const { version: platformVersion } = require("zapier-platform-core");
const authentication = require("./authentication");
const endpoints = require("./triggers/endpoints");
const newEmail = require("./triggers/new-email");
const createEndpoint = require("./creates/create-endpoint");
const sendTestEmail = require("./creates/send-test-email");
const findEmail = require("./searches/find-email");

/** The API key as a bearer token on every request. */
function addApiKey(request, z, bundle) {
  if (bundle.authData && bundle.authData.apiKey) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  }
  return request;
}

/** The API's own message for a failed request, which says what to fix. */
function explainErrors(response, z) {
  if (response.status === 401) {
    throw new z.errors.Error(
      "The API key was not accepted. Create a new one under Account > API keys.",
      "AuthenticationError",
      401
    );
  }
  if (response.status >= 400 && !response.skipThrowForStatus) {
    let message = `webhooks.cc answered ${response.status}`;
    try {
      const body =
        typeof response.json === "object" && response.json
          ? response.json
          : JSON.parse(response.content);
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: the status says enough.
    }
    throw new z.errors.Error(message, "ApiError", response.status);
  }
  return response;
}

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [explainErrors],
  triggers: {
    [endpoints.key]: endpoints,
    [newEmail.key]: newEmail,
  },
  creates: {
    [createEndpoint.key]: createEndpoint,
    [sendTestEmail.key]: sendTestEmail,
  },
  searches: {
    [findEmail.key]: findEmail,
  },
};
