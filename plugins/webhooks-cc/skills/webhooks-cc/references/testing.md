# Testing webhook handlers

## Learn the real payload before writing types

Provider docs are often out of date, so type what the provider really sends.

1. `create_endpoint`. Have the person set its `url` as the webhook URL in the
   provider's dashboard, or trigger events with the provider's CLI. When
   neither is possible, `send_webhook` with `provider` and `template` posts a
   realistic sample; a signed provider needs a `secret`, and any string works
   when only the shape matters.
2. `wait_for_request` (or `wait_for_requests`). Two or three deliveries of
   the same event show which fields are optional or nullable.
3. `generate_payload_schema` with `event` and `format` (`zod`,
   `typescript`, `pydantic` or `json-schema`). Write the result next to the
   handler in the project's naming style.

## Send a signed request to a local handler

Needs the local MCP server (the remote one cannot reach localhost).

1. Find the route and the env var holding its signing secret (for example
   `STRIPE_WEBHOOK_SECRET`). Use the value from the local env file; never use
   or ask for a production secret.
2. `send_to` with `url` (for example
   `http://localhost:3000/api/webhooks/stripe`), `provider`, `template` and
   `secret`, plus `body` for specific values. It returns the handler's status
   and body. `preview_webhook` shows the signed request without sending it.
3. A 400 or 401 usually means the handler parsed the body before verifying
   it (signatures cover the raw bytes) or reads another secret. Fix that.
4. Check the side effect (a row, a job, an email), not only the status.
5. Also send one signed with a wrong secret and expect a rejection.

With only the remote server, run `whk tunnel <port> --endpoint <slug>` and
`send_webhook` to that endpoint: the tunnel delivers the signed request to
the handler. `test_webhook_flow` runs create, mock, send, wait, verify,
replay and clean-up in one call.

## Providers

`list_provider_templates` lists every provider, its templates and how it
signs. Signed providers need `secret`; the `sendgrid`, `discord` and `plaid`
templates are unsigned.

## Webhooks the app sends

1. `create_endpoint` and point the app's outgoing webhook URL at it.
2. Trigger the action, then `wait_for_request` and `get_request`.
3. `verify_signature` with the provider scheme and the app's secret. To have
   every capture checked on arrival, `update_endpoint` with
   `signingProvider` and `signingSecret`; `verify_signature` without a
   secret then reads that result.

## Debug a failing delivery

- `list_requests` and `get_request` for what arrived.
- `search_requests` finds text in paths, headers, bodies and email fields.
  When `complete` is false, call again with the `cursor`.
- `compare_requests` diffs a working delivery against a failing one;
  `extract_from_request` pulls fields out of a body.
- `replay_request` with `targetUrl` (local server), or
  `whk replay <id> --to <url>`, sends a capture to the handler again.
