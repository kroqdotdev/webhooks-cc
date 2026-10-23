---
name: webhook-testing
description: Test webhook handlers and email flows against real, correctly signed traffic with webhooks.cc instead of guessing payloads or disabling signature checks. Use when writing, changing, or debugging code that receives webhooks (Stripe, GitHub, Shopify, Clerk, Twilio, Slack, Paddle and 27 more providers, or any HTTP callback), when you need the exact shape of a provider's payload or types for it, when a test must verify a webhook signature or a retry path, or when a test has to read a signup, magic-link, or one-time-code email.
---

# Webhook testing with webhooks.cc

webhooks.cc gives you capture URLs, provider-signed test payloads, typed schemas
learned from real requests, and inboxes for email. Use it so that a webhook
handler is tested with what the provider actually sends, and its signature
check stays switched on.

## Which interface to use

1. **MCP tools** (the `webhooks-cc` server, `@webhooks-cc/mcp`): use them
   whenever they are available. The tool names below are theirs.
2. **TypeScript SDK** (`@webhooks-cc/sdk`): for tests that run in CI, and when
   the MCP tools are missing. See [references/sdk-tests.md](references/sdk-tests.md).
3. **CLI** (`whk`): `whk tunnel <port>` forwards live deliveries to localhost
   while the developer clicks through a provider dashboard.

Without an API key the MCP server runs a sandbox: up to 3 endpoints, 25
requests each and 100 in all, for 24 hours. It covers `create_endpoint`,
`list_requests`, `get_request`, `wait_for_request` and
`generate_payload_schema`. For signed sends, email, mock responses, and
anything longer-lived, call `connect_account`: show the human the link and
the code it returns, then call `wait_for_connection`. The full tools appear
once they enter the code.

## Workflows

### Learn the real payload before writing types

Provider docs are often out of date. Capture real deliveries, then generate
the types from them.

1. `create_endpoint` (add `ephemeral: true` for throwaway work). Tell the
   developer to set the returned `url` as the webhook URL in the provider's
   dashboard, or trigger events with the provider's CLI. When neither is
   possible, `send_webhook` with a `provider` and `template` posts a realistic
   sample (`list_provider_templates` lists the templates). Signed providers
   need a `secret`; any test string works, since only the shape matters here.
2. `wait_for_request` until a delivery arrives. Ask for two or three
   deliveries of the same event if the developer can trigger them: every
   extra sample shows which fields are optional or nullable.
3. `generate_payload_schema` with `event` set to the event you are handling
   and `format` matching the project: `zod` for TypeScript projects that
   validate input, `typescript` for plain types, `pydantic` for Python,
   `json-schema` for anything else. Write the result into the codebase next
   to the handler and adapt the names to the project's conventions.

### Test a local handler with a signed payload

1. Find the handler's route and the env var holding its signing secret (for
   example `STRIPE_WEBHOOK_SECRET`). Read the value from the developer's local
   env file; never use or ask for a production secret.
2. `send_to` with `url` set to the local route (for example
   `http://localhost:3000/api/webhooks/stripe`), `provider`, `template` (from
   `list_provider_templates`), `secret`, and `body` when the test needs
   specific values. It returns the handler's status and body.
3. A `400` or `401` usually means the handler parses the body before
   verifying it (signatures cover the raw bytes) or reads a different secret.
   Fix that instead of disabling verification.
4. Check the side effect the handler should have (a database row, a queued
   job, a sent email), not only the status code.

### Write an automated test

Use the SDK in the project's test runner so the test runs in CI. Recipes for
Vitest, Jest and Playwright are in [references/sdk-tests.md](references/sdk-tests.md):
signed sends to a handler, asserting on webhooks the app sends, and reading
signup emails.

### Check webhooks the app sends

1. `create_endpoint`, and point the app's outgoing webhook URL at it.
2. Trigger the action in the app, then `wait_for_request`.
3. Inspect headers and body with `get_request`, and `verify_signature` with
   the app's signing secret if it signs its webhooks.

### Simulate failures

To test retry and backoff logic in code that sends webhooks, create the
endpoint with `mockResponse` (for example `{ "status": 503, "delay": 2000 }`)
or with `responseRules` that answer differently by path, header or body.
Clear them afterwards with `update_endpoint` and `mockResponse: null` (or
`responseRules: null`).

### Read signup, magic-link and code emails

Every account endpoint receives mail at `{slug}@mailhooks.cc`, and at
`{slug}+{tag}@mailhooks.cc` for any tag. Sandbox endpoints receive no email.

1. Use `{slug}+{run-id}@mailhooks.cc` as the address in the signup form, so
   parallel runs find their own mail.
2. `wait_for_email` with that `tag` (and `subject` if useful). It returns the
   one-time `code` and the main `link` already extracted.

### Debug a failing delivery

`list_requests` to see what arrived, `get_request` for the details,
`verify_signature` to check the signature, `compare_requests` to see what
changed between a working and a failing delivery, and `replay_request` with
`targetUrl` set to the local handler to reproduce it.

## Rules

- Never weaken or skip a handler's signature verification to make a test
  pass. Send a correctly signed request instead.
- Captured requests can hold real customer data. Do not copy them into fixtures
  or commit them; use `generate_payload_schema` for types and provider
  templates for fixture payloads.
- Delete endpoints you created only for a task with `delete_endpoint`, unless
  the developer wants to keep them. Prefer `ephemeral: true`.
- The free plan captures 50 requests a day. Send what the task needs, not
  loops of retries. On a `429`, stop and tell the developer when the quota
  resets.
