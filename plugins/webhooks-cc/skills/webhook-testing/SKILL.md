---
name: webhook-testing
description: Test webhook handlers and email flows against real, correctly signed traffic with webhooks.cc instead of guessing payloads or disabling signature checks. Use when writing, changing, or debugging code that receives webhooks (Stripe, GitHub, Shopify, Clerk, Twilio, Slack, Paddle and 27 more providers, or any HTTP callback), when you need the exact shape of a provider's payload or types for it, when a test must verify a webhook signature or a retry path, when a test has to read a signup, magic-link, or one-time-code email, or when captured webhooks or emails should be forwarded, filtered or reshaped for another server, a Slack or Discord channel, or a tool such as Zapier.
---

# Webhook testing with webhooks.cc

webhooks.cc gives you capture URLs, provider-signed test payloads, typed schemas
learned from real requests, and inboxes for email. Use it so that a webhook
handler is tested with what the provider actually sends, and its signature
check stays switched on.

## Which interface to use

1. **MCP tools** (the `webhooks-cc` server): use them whenever they are
   available. The tool names below are theirs. The remote server at
   `https://webhooks.cc/mcp` works in any client that can add a remote MCP
   server, coding agents included: the human adds it and approves it once
   in the browser, with no key and no code. It cannot reach the developer's
   machine, so it has no `send_to` or `replay_request` and refuses
   `targetUrl`; for localhost, the developer runs the local server
   (`npx -y @webhooks-cc/mcp`) or `whk tunnel`.
2. **SDKs** (`@webhooks-cc/sdk`; `webhooks-cc` for Python, `webhooks.cc/go`
   for Go): for tests that run in CI, and when the MCP tools are missing.
   TypeScript recipes are in [references/sdk-tests.md](references/sdk-tests.md).
3. **CLI** (`whk`): `whk tunnel <port>` forwards live deliveries to localhost
   while the developer clicks through a provider dashboard, and
   `whk sandbox create --json` captures without an account.

Without an API key the local MCP server needs no setup. If the human
connected you before, it starts with the full tools for their account (the
connection is saved in `~/.config/whk/agent.json`, shared with the CLI and
the SDKs). Otherwise it runs a sandbox: up to 3 endpoints, 25 requests each
and 100 in all, for 24 hours. The first `create_endpoint` registers it, and
`list_requests`, `get_request`, `wait_for_request` and
`generate_payload_schema` work in it. For signed sends, email, mock
responses, and anything longer-lived, call `connect_account` with the email
the human signs in to webhooks.cc with (their GitHub or Google primary email
if they sign in that way): show them the link and the code it returns, then
call `wait_for_connection`. The full tools appear once they enter the code,
and the connection is saved, so they approve you once.

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

### Simulate the receiving end (failures, slow answers, dynamic replies)

To test code that sends webhooks or calls back into an API (retries, backoff,
idempotency, reading the reply), make the endpoint answer like the real
server would:

1. `update_endpoint` with `mockResponse` for the default answer (for example
   `{ "status": 503, "delay": 2000 }`) and `responseRules` for answers that
   depend on the request. Rules are checked in order and the first match
   answers. Each condition is `{ field, op, value }`, plus `name` for a
   header or query parameter and `path` for a body field:

   ```text
   field: method, path, header, query, body, body_path (dot path into a JSON
          or form body), content_type, size
   op:    eq, neq, contains, not_contains, starts_with, ends_with,
          matches (glob), regex (RE2), exists, not_exists, gt, gte, lt, lte
   ```

2. Echo the request in the answer with placeholders, filled in per request:
   `{"id": "{{ uuid }}", "event": "{{ json.id }}", "seen": "{{ now }}"}`, or
   a header value such as `{{ headers.x-request-id }}`. Filters:
   `| default: "x"`, `| json`, `| lower`, `| upper`, `| truncate: 80`.
3. Before relying on it, `preview_response` (with `requestId` of a captured
   request, and the rules you are about to save) shows which rule answers and
   the exact body. A placeholder listed in `unknownPlaceholders` is a typo.
4. Clear them afterwards with `update_endpoint` and `mockResponse: null` (or
   `responseRules: null`).
5. For a service that answers at once and calls back later, also add a
   destination with `delaySeconds` that posts a `bodyTemplate` to the app's
   callback URL (see the next workflow).

### Send captures on to a server, a channel or a tool

When the developer wants captured webhooks or emails delivered somewhere
(a staging server, a Slack or Discord channel, Zapier or n8n), add a
destination instead of writing a relay. An endpoint takes up to 10, each
with its own signing secret, retries and log.

1. `add_destination` with the `url`, the kinds it takes (`http`, `email`),
   and what it needs:
   - `filter` to send only some captures: the response rule conditions plus
     `kind`, `email` (`name`: subject, from, to, text or tag), `spam_score`,
     `email_auth` (`name`: spf, dkim or dmarc) and `signature` (`verified`
     sends only requests whose signature checked out).
   - `format: "template"` and a `bodyTemplate` to send only the fields the
     tool wants, under its names:
     `{"invoice": "{{ json.data.object.id }}", "code": "{{ codes.0 }}"}`.
     A string that is only a placeholder keeps the value's type.
   - `format: "chat"` for Slack or Discord, `messageTemplate` for your own
     text, and `throttleSeconds: 1` for a heads-up rather than a message per
     request.
   - `delaySeconds` (up to 3600) to send it later, like a callback.
2. `preview_destination` with a captured `requestId` shows whether the filter
   lets it through and the exact request it would send. Fix anything listed
   in `unknownPlaceholders`.
3. `test_forwarding` with the `destinationId` sends one now and reports the
   answer. `get_forwarding_secret` with the `destinationId` returns the
   `whsec_` secret a handler verifies deliveries with; put it in the
   handler's environment, never in code.
4. `list_deliveries` with `endpointSlug` (`status: "failed"`, or `"skipped"`
   for what the filter turned down) shows what went out, and `redeliver`
   sends one again. `update_destination` changes it, `remove_destination`
   removes it, `list_destinations` lists them.

### Read signup, magic-link and code emails

Every account endpoint receives mail at `{slug}@mailhooks.cc`, and at
`{slug}+{tag}@mailhooks.cc` for any tag. Sandbox endpoints receive no email.

1. Use `{slug}+{run-id}@mailhooks.cc` as the address in the signup form, so
   parallel runs find their own mail.
2. `wait_for_email` with that `tag` (and `subject` if useful). It returns the
   one-time `code` and the main `link` already extracted.
3. For other values (an order number, an amount, a magic token in an odd
   place), `update_endpoint` with `emailFields`: a `name`, where it is
   (`from`: subject, text, html, from, to, or header with `header`) and an
   RE2 `pattern` whose first group is the value. `get_email` then returns
   them as `fields`, and the reply without its quote as `replyText`.

### Test an inbound email handler

When the app receives email through Postmark, SendGrid, Mailgun or
CloudMailin, test the handler with real mail in that provider's shape:

1. Send mail to the endpoint's address (`send_test_email`, or the app's own
   flow), then `render_email` with the `requestId`, the provider as
   `format`, and `targetUrl` set to the local handler (for example
   `http://localhost:3000/api/inbound/postmark`). For Mailgun, pass the test
   signing key the handler verifies with as `mailgunSigningKey`.
2. Check the side effect the handler should have, as for webhooks.
3. Attachments are never included (their contents are not stored); say so
   if the handler's attachment path needs another test.

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
- Forwarding sends real traffic to real URLs. Add a destination only to a URL
  the developer named, and remove the ones you added for a task.
- The free plan captures 50 requests a day. Send what the task needs, not
  loops of retries. On a `429`, stop and tell the developer when the quota
  resets.
