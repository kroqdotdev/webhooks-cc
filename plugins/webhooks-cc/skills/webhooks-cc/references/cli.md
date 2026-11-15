# The `whk` CLI for agents

## Conventions

- Pass `--json` to every command: stdout carries the API's own JSON (NDJSON
  for streams), and a failure is an `error` object (`code`, `message`,
  `exit`, `hint`) on stderr.
- Exit statuses are stable and listed in `whk --help`: 1 with
  `delivery_failed` when `whk destinations test` was not accepted (the
  result is still on stdout), 3 not logged in, 4 not found, 5 not allowed
  by the plan, 6 rate limited, 7 server or network failure (retry), 8 a
  wait or approval timed out, 9 not confirmed or refused.
- Nothing reads stdin without a terminal: destructive commands need
  `--yes`.
- Sign in with `whk auth login` (the person approves in a browser), or
  without an account use `whk sandbox create` and later
  `whk sandbox connect --email <address>`.

## Commands

| Job                                | Command                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Endpoints                          | `whk create [name] -e`, `whk list`, `whk get <slug>`, `whk update-endpoint <slug>`, `whk delete <slug> --yes`     |
| Wait for the next request or email | `whk wait <slug> --since now --timeout 2m`                                                                        |
| Stream arrivals                    | `whk listen <slug>`                                                                                               |
| Read, search, export               | `whk requests list`, `get`, `search`, `count`, `export`, `clear`, `download <id> -o <file>`                       |
| Send                               | `whk send <slug> -d @body.json`, `whk send-to <url>`, `whk replay <id> --to <url>`, `whk send-email <slug>`       |
| Local app                          | `whk tunnel <port> [--live]`, `whk share <port>`, `whk shares`, `whk names`                                       |
| Forwarding                         | `whk destinations ls`, `add`, `update`, `preview`, `test`, `secret`, `rm`; `whk deliveries ls`, `redeliver`       |
| Responses and alerts               | `whk mock preview <slug>`, `whk alerts get <slug>`, `whk alerts set <slug> --silence-hours 24`                    |
| Email setup                        | `whk fields preview`, `whk layouts preview`, `whk layouts`, `whk ai setup`, `whk domains`                         |
| Account                            | `whk usage`, `whk billing`, `whk keys`, `whk agents`, `whk account`, `whk share-links`, `whk teams`, `whk google` |
| Anything else                      | `whk api <path> [-X METHOD] [-d JSON]`                                                                            |

`whk wait` exits at the first match: start it in the background, trigger
the sender, and its exit is the signal. Without `--since now`, a request
from the last 5 minutes also counts.

`whk api` reaches every route a command does not cover, such as saving
response rules or layouts: `whk api -X PATCH endpoints/<slug> -d @settings.json`.
Try them first with `whk mock preview <slug> --response-rules @rules.json`
or `whk layouts preview <slug> --layouts @layouts.json`: dry runs that
save and send nothing.

`whk requests download <id> -o message.eml` saves an email's exact message,
`--attachment <n> -o <file>` one attachment; the path is only ever `-o`
(never the sender's file name), and with `--json` `-o` is required.
`whk requests replay <id> --yes` runs a request through its endpoint's
layouts and destinations again after a pattern was fixed;
`replay-range <slug> --since 2h --yes` does it for a range.
`whk send-email <slug> --tag <tag>` delivers a sample email to wait for.

`whk destinations add` and `update` take a flag per setting (`--url`,
`--format`, `--filter @filter.json`,
`--header "Authorization: Bearer $HOOK_TOKEN"`, ...); `update` changes only
what you pass. Give a header's token as a variable in double quotes: the
shell stores the variable's name in its history, not the token. A file
drop's password or key comes from `WHK_DROP_SECRET` (never a flag), so the
person sets it in their own environment; a key from its file,
`WHK_DROP_SECRET="$(cat ~/.ssh/drop_key)"`. `@file` reads a flag from a
file; `@@` starts a value with a literal `@`. `whk destinations preview` is a dry run; `test`,
`secret --rotate`, `rm` and `whk deliveries redeliver` need `--yes`.
`whk deliveries ls` rows carry the request id and the destination id;
`whk deliveries redeliver <request-id> --destination <destination-id> --yes`
sends a failed one again (it takes the request id, not the delivery's).

Commands that need the person's approval (`whk keys create`,
`whk share-links create`, `whk teams invite`, `whk domains remove`, ...)
print the link and wait; with `--no-wait` they print the approval and exit,
and `whk approvals wait <id>` collects it later.

Signed provider templates are sent from the MCP tools or the SDKs, not the
CLI: `whk send` and `whk send-to` send the body and headers you give them.
