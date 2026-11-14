# Tunnels and previews

Three ways to connect the outside world to a local app. All need `whk`
installed and signed in (`whk auth login`, or a connection saved by
`whk sandbox connect`).

| Need                                                  | Use                        |
| ----------------------------------------------------- | -------------------------- |
| Real webhooks and emails delivered to a local handler | `whk tunnel <port>`        |
| The sender must get the local app's own answer        | `whk tunnel <port> --live` |
| A person opens the site in a browser                  | `whk share <port>`         |

## `whk tunnel <port>`

Creates an endpoint (or uses `--endpoint <slug>`), prints its URL and email
address, and forwards each capture to `localhost:<port>` (a path may follow,
`3000/api/webhooks`). The sender gets the mock response or a plain 200 at
once; the local app gets the request right after. Emails are posted as
webhooks.cc's JSON, or in a provider's shape with `--email-format`
(`postmark`, `sendgrid`, `mailgun`, `cloudmailin`); `--email-path` sends
them to their own path. `-H` adds headers (Authorization and Cookie from
the sender are dropped). `-e` deletes the endpoint on exit. With `--json`
each delivery is an NDJSON line with the request `id` and the app's
`status`.

Run it in the background, have the person point the provider at the URL,
and read deliveries with `get_request` or `whk requests get <id>`.

## `--live`

For Slack slash commands, Twilio replies, verification handshakes and OAuth
callbacks: each webhook is relayed to the local app while the sender waits,
and the sender gets the app's answer. Every request is still captured, and
`get_request` shows the app's answer as `liveResponse`. No `whk` connected
means a 502; no answer within 25 seconds means a 504. Live traffic counts
against the request quota.

## `whk share <port>` and `share_port`

Opens the local site at `https://<name>.sharehooks.cc` for a client, a
teammate or a phone. `share_port` (local MCP server only) runs it for you
and keeps it until `stop_share` or the end of the session.

- Free: one share at a time, a random name ending in `-free`, 2 hours, 1 GB
  a month, and a notice page before the site. Say so when you hand over the
  link.
- Pro, Business and teams: several shares, no time limit, reserved names and
  passwords.
- `list_shares` (or `whk shares ls`) shows what runs, this month's data and
  the plan's limits; `share_requests` (`whk shares log <share>`) shows
  whether the person opened the link and what failed for them; `stop_share`
  (`whk shares stop <share>`) frees a slot.

## Reserved names and passwords (names group)

`list_names`, `reserve_name` (with `team` to share it with a team),
`release_name`, `set_name_password`, `clear_name_password`; then
`share_port` with that `name`, or `whk share <port> --name <name>`. The
tools never echo a password: give it to the person yourself.
