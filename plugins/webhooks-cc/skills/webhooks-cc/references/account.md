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
shows what the account pays for.

## Billing changes (account group)

Each is an approval shown with its quote: what changes, when (at once or at
the renewal) and what is charged now. Ask only when the person wants the
change; never to spend money on your own.

- `change_plan` (pro or business; team or team_business with `teamId`;
  `keep: true` drops a change waiting for the renewal), `set_seats` for a
  team, `change_addons` (monthly blocks, one-time blocks, overage),
  `cancel_subscription`, `resume_subscription`.
- Adding blocks, or turning overage on for the first time, sends the owner
  to a Polar checkout when they approve.
- If the price or the subscription changed before they approve,
  `wait_for_approval` says nothing was changed: ask again for a new quote.
  Another refusal (a declined card) says why; fix that first.
- An unknown outcome means Polar was asked and then something failed: the
  change may have been made. Read `get_billing` before asking again.

## Agent spend budget (account group)

The owner can set an agent budget: cents before tax, per 30 days, that
keys may charge at once without an approval (0, the default, is off; at
most $500). While enough is left, more seats, Pro to Business monthly and
Teams to Team Business monthly are made at once and the owner is emailed;
fewer seats or monthly blocks are made at once too. Everything else (annual,
downgrades, cancelling, overage, checkouts) stays an approval, and so does
a change the budget cannot cover: the answer says why (what is left, what
is needed).

- `get_agent_budget` reads it; `set_agent_budget` lowers it at once, and a
  raise is an approval. Only when the person asks.
- Each change counts at its charge now plus how much it raises the next
  renewal (monthly plans always; annual plans when the renewal is at most 31
  days away, else the larger of the two, and a seat added more than 60 days
  before that renewal is not bounded at it). Later renewals keep the new
  price: say so when you spend it.
- Any change of the budget refuses a raise still waiting: `wait_for_approval`
  says the budget changed; read it again and ask again only if still needed.
- An "outcome unknown" answer (HTTP 502) means the change may have been
  made: read `get_billing` first; if it was not, send the same request again
  (same `Idempotency-Key`); nothing is charged twice. A key names one change.
- On Business the personal budget only covers reductions.

CLI: `whk billing plan|keep-plan|seats|blocks|buy|overage|cancel|resume|budget`.

## Checkout links (account group)

Paying stays with the person: when they ask for a first plan, a team's first
subscription, blocks or overage, `create_checkout` makes a link to
webhooks.cc that they open signed in as the account's owner (the team's
owner for a team) and pay with their own card on Polar's page; follow it
with `wait_for_checkout`, which says when what was bought differs from what
was asked, or when the purchase was undone because the account already had
what it buys (its subscription ended, a refund under review: never promise one),
or when it expired before Polar confirmed a payment (it may still have been
paid: never tell the person nothing was charged; check `get_billing`). A
`create_checkout` whose client opened the link for them waits only 45
seconds: on "Not paid yet", keep waiting with `wait_for_checkout`, and only a
paid answer means it was paid. `cancel_checkout` cancels a link they have not opened yet
(when they change their mind).

CLI: `whk billing checkout|checkout-status|checkout-cancel`.

## Teams (teams group)

A team shares endpoints between its members under one pooled quota.

- `list_teams`, `list_team_members`; `share_endpoint` and `unshare_endpoint`
  for an endpoint you own. Requests on a shared endpoint bill the team.
- `create_team` makes it, but it stays suspended until the owner subscribes
  in the browser (2 seats or more). `quote_team_change` prices a seat or
  plan change without making it; `set_seats` and `change_plan` ask for it.
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
