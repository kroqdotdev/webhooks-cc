---
name: webhooks-cc
description: Use webhooks.cc for any task that receives, sends or tests webhooks or test email. It gives capture URLs and inboxes, provider-signed test webhooks (Stripe, GitHub, Shopify, Slack, Twilio, Clerk and many more) and signature checks, payload types learned from real captures, mock responses and response rules, waiting for signup, magic-link and one-time-code emails, forwarding captures to a server, Slack, Discord, Google Sheets, Zapier or SFTP/S3 file drops, parsing emails into fields and line items, a public preview link or live tunnel for a local app, and teams that share endpoints. Use it when writing, testing or debugging a webhook handler or an inbound email flow, when a test needs a real email address, or when a local server needs a public URL.
---

# webhooks.cc

- **Capture URL** `https://go.webhooks.cc/w/<slug>`: records every request (any method, any path below it) and answers 200, or a mock response you set.
- **Inbox** `<slug>@mailhooks.cc`, and `<slug>+<tag>@mailhooks.cc` for any tag: only for endpoints on an account.
- **Preview link** `https://<name>.sharehooks.cc`: a port on this machine, opened by anyone.

Everything works without the dashboard. Do it yourself with the tools; send the person to a browser only for an approval, signup or payment.

## Which interface

1. **MCP tools** (server `webhooks-cc`) when they are available.
   - Remote, `https://webhooks.cc/mcp`: needs an account, cannot reach this machine (no `send_to`, `replay_request` or `share_port`; `targetUrl` is refused), and waits return after 50 seconds, so call them again.
   - Local, `npx -y @webhooks-cc/mcp`: reaches localhost and runs without an account.
   - Claude Code, Claude, Codex and ChatGPT get every tool; other clients get the core group (endpoints, requests, emails, sending, signatures, destinations, deliveries, previews, usage, approvals). When a tool is missing, call `enable_tools` (local), or have the person set `WHK_MCP_TOOLS=all` (local) or use `https://webhooks.cc/mcp?tools=all`.
2. **CLI `whk`**: for tunnels, shares and scripts. Pass `--json`. See [references/cli.md](references/cli.md).
3. **SDKs** for tests that run in CI: `@webhooks-cc/sdk`, `webhooks-cc` (Python, with pytest fixtures), `webhooks.cc/go`. See [references/sdk-tests.md](references/sdk-tests.md).

## Without an account

The local server without a key or saved connection runs a sandbox: 3 endpoints, 25 requests each and 100 in all, for 24 hours, with `create_endpoint`, `list_endpoints`, `get_endpoint`, `delete_endpoint`, `list_requests`, `get_request`, `wait_for_request` and `generate_payload_schema`. Sandbox endpoints get no email, mock responses or signature checks. For more, call `connect_account` with the email the person signs in with, show them the link and code, then `wait_for_connection`. The connection is saved in `~/.config/whk/agent.json`, shared with the CLI and SDKs, so they approve once.

## Approvals

Some actions answer with a link and a code instead of acting: a new API key, a share link, team invites and deletion, removing a domain, renaming the account, connecting Google or picking a spreadsheet, and AI setup. Show the link, ask the person to check the code matches, then call `wait_for_approval` until it is answered (15 minutes). A client that can open links opens the page itself, and the tool finishes once it is approved. Paying for anything stays with the person; `get_billing` (account group) reads what they pay for.

## Jobs

- **Capture and inspect**: `create_endpoint` (`ephemeral: true` for throwaway work), point the sender at its `url`, then `wait_for_request`, `get_request`, `search_requests`, `compare_requests`. `generate_payload_schema` (extras group) writes Zod, TypeScript, Pydantic or JSON Schema from real captures.
- **Test a handler with signed webhooks**: `list_provider_templates`, then `send_to` the local route with `provider`, `template` and the test `secret`; `send_webhook` sends to a capture URL; `verify_signature` checks a captured request. See [references/testing.md](references/testing.md).
- **Mock responses and rules**: `update_endpoint` with `mockResponse` and `responseRules`, checked with `preview_response`. See [references/responses.md](references/responses.md).
- **Email**: sign up with `<slug>+<run>@mailhooks.cc`, then `wait_for_email` returns the one-time code and main link. Named fields, layouts and inbound handler tests are in [references/email.md](references/email.md).
- **Forwarding**: `add_destination` sends captures to a server, Slack or Discord, as your own JSON, or as rows in a Google Sheet; file drops are added with the SDK or `whk api`. `list_deliveries` and `redeliver` show and resend. See [references/forwarding.md](references/forwarding.md).
- **Local app**: `whk tunnel <port>` delivers captures to localhost; `--live` gives the sender your app's answer; `share_port` or `whk share <port>` opens a preview link. See [references/tunnels.md](references/tunnels.md).
- **Teams, keys and the account**: see [references/account.md](references/account.md).

## Rules

- Never disable or weaken a signature check to make a test pass. Send a correctly signed request; a 400 or 401 usually means the handler parsed the body before verifying it, or reads another secret.
- Build types and fixtures from captured payloads or provider templates, not from memory. Captures can hold customer data: never commit them.
- Forward only to URLs the person named. Ask before anything that emails real people or costs money.
- Free captures 50 requests a day. Send what the task needs; on a 429, stop and say when the quota resets.
- Delete endpoints and destinations made only for a task.
