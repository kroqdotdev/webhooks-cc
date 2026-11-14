# Forwarding captures

Send captured webhooks and emails on to a server, a chat channel, a tool or
a spreadsheet with a destination, instead of writing a relay. Owner only.

## Limits

- Up to 10 destinations per endpoint, each with its own signing secret,
  retries and log.
- The URL must be `https` on a public host: no localhost, IP addresses or
  private networks, and never a webhooks.cc capture URL. To reach localhost,
  use `whk tunnel` (see [tunnels.md](tunnels.md)).
- Forwarding does not use request quota. Only requests captured after a
  destination is on are sent to it; `redeliver` sends older ones.

## Add one

`add_destination` with the endpoint `slug`, a `url` (not for Google Sheets,
below), `http` and `email` (booleans, both on by default) and:

- `format`: `"auto"` (picked from the URL), `"as_received"` (the request
  unchanged), `"json"` (a signed envelope; the default for email),
  `"template"` with a `bodyTemplate` (your own JSON with `{{ placeholders }}`,
  for Zapier, n8n or an API), `"chat"` for a Slack or Discord webhook
  (`messageTemplate` for your own text), or `"postmark"`, `"sendgrid"`,
  `"mailgun"`, `"cloudmailin"` to post emails in that provider's shape.
- `filter`: send only matching captures. Conditions as in [responses.md](responses.md), plus
  `kind`, `email` (`name`: subject, from, to, text or tag), `email_field`,
  `spam_score`, `email_auth` (`name`: spf, dkim or dmarc) and `signature`
  (`verified`, `failed` or `missing`).
- `throttleSeconds` (at most one delivery every N seconds; the rest are not
  sent, so 1 makes a heads-up channel), `delaySeconds` (up to 3600, for callbacks), `retrySeconds`,
  `keepOrder`, `headers`.

Template placeholders: HTTP requests read `json.<path>`, `headers.<name>`,
`query.<name>`, `method`, `path`, `body`; emails read `subject`,
`from.address`, `text`, `codes.0`, `links.0.url`, `fields.<name>`,
`parsed.fields.<name>`. A string that is only a placeholder keeps its type.

## Check and run it

`preview_destination`, `test_forwarding`, `get_forwarding_secret` and
`configure_forwarding` are in the forwarding group; `list_deliveries` and
`redeliver` are core.

1. `preview_destination` with a captured `requestId`: whether the filter
   passes and the exact request it would send. Fix `unknownPlaceholders`.
2. `test_forwarding` with the `destinationId` sends one now and reports the
   answer.
3. `get_forwarding_secret` returns the `whsec_` secret the receiving handler
   verifies deliveries with (the SDKs' `verifyForwardedEmail`,
   `verifyForwardedRequest`, `verifyRelayedRequest`). Put it in the
   handler's environment, never in code.
4. `list_deliveries` with `endpointSlug` (`status: "failed"`, or
   `"skipped"` for what the filter turned down) shows what went out;
   `redeliver` sends one again, or every failed one.
5. `update_destination`, `remove_destination`, `list_destinations`.
   `configure_forwarding` edits the endpoint's primary destination only.

## Google Sheets

A row per email (or per line item a layout found) in a spreadsheet.

1. `list_google_connections`; if none, `connect_google` (an approval: the
   person picks the Google account).
2. `create_spreadsheet` with a header row (its `id` is the spreadsheet), or
   `pick_spreadsheet` (an approval: the person chooses one in Google's
   picker; `create_spreadsheet` with its `spreadsheetId` then writes the
   header row if the first row is empty). `list_sheet_tabs` lists its tabs.
3. `add_destination` with `format: "sheets"` and, instead of a `url`,
   `config`: `connectionId`, `spreadsheetId`, `sheet` (the tab, default
   `"Sheet1"`), `rows` (`"email"` or `"line_items"`) and `columns`
   (`[{ "header": "Subject", "value": "{{ subject }}" }]`, in the header
   row's order). `update_destination` replaces the whole `config`, again with
   `format: "sheets"`; a `sheet` or `rows` left out keeps the current one. A
   Sheets destination's URL is its spreadsheet's, so never pass a `url` for
   one.

These tools are in the sheets group, except `add_destination` (core). No
Google credential ever passes through the agent.

CLI: `whk google` (`list`, `connect`, `pick`, `tabs`, `create-sheet`).

## File drops (Business)

CSV, XML or JSON files written to the person's SFTP, FTP/FTPS or
S3-compatible server, a file per email or per batch. A drop holds a server
password, so the MCP tools do not create one: the person adds it with the
SDK or `whk api` (`format: "file_drop"`, `config` and `dropSecret`) from
their own environment.

## Zapier and Make

Their apps add and remove their own destinations when a Zap or scenario
turns on or off. Nothing to add by hand.
