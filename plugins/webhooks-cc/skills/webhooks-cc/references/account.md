# Account, teams and plans

## Plans (requests per period, retention)

| Plan          | Requests               | Retention |
| ------------- | ---------------------- | --------- |
| Free          | 50 a day               | 7 days    |
| Pro           | 100,000 a month        | 31 days   |
| Business      | 250,000 a month        | 90 days   |
| Teams         | 100,000 a seat, pooled | 31 days   |
| Team Business | 250,000 a seat, pooled | 90 days   |

Business adds attachment parsing at volume, 50 layouts per endpoint, a
custom inbound domain and file drops. Past the quota, captures and emails
get 429 or a bounce until it resets. `get_usage` (or `whk usage`) shows
usage, what is left and when it resets; `get_billing` (or `whk billing`)
shows what the account pays for. Plan changes, seats and add-ons are bought
by the person in the browser; never start a checkout yourself.

## Teams (teams group)

A team shares endpoints between its members under one pooled quota.

- `list_teams`, `list_team_members`; `share_endpoint` and `unshare_endpoint`
  for an endpoint you own. Requests on a shared endpoint bill the team.
- `create_team` makes it, but it stays suspended until the owner subscribes
  in the browser (2 seats or more). `quote_team_change` prices a seat or
  plan change without making it.
- `invite_to_team` emails someone, so it is an approval; `list_invites`,
  `answer_invite`, `withdraw_invite`, `remove_team_member`, `leave_team`,
  `rename_team`. `delete_team` is an approval and ends the subscription.
- Act on membership only when the person asks.

CLI: `whk teams`.

## API keys, agents, share links (account group)

- `create_api_key` is an approval; `wait_for_approval` returns the key once.
  Put it in a secret store or CI secret, never in code. `list_api_keys`,
  `revoke_api_key`.
- `list_connected_agents`, `disconnect_agent` (disconnecting yourself ends
  your access).
- `create_share_link` makes a public read-only copy of one HTTP request for
  a bug report or a teammate; it is an approval. `list_share_links`,
  `revoke_share_link`.
- `rename_account` sets the display name (an approval).

CLI: `whk keys`, `whk agents`, `whk share-links`, `whk account`.
