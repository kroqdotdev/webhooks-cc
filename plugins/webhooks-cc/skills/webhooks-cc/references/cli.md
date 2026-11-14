# The `whk` CLI for agents

## Conventions

- Pass `--json` to every command: stdout carries the API's own JSON (NDJSON
  for streams), and a failure is an `error` object (`code`, `message`,
  `exit`, `hint`) on stderr.
- Exit statuses are stable and listed in `whk --help`: 3 not logged in,
  4 not found, 5 not allowed by the plan, 6 rate limited, 7 server or
  network failure (retry), 8 a wait or approval timed out, 9 not confirmed
  or refused.
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
| Read, search, export               | `whk requests list`, `get`, `search`, `count`, `export`, `clear`                                                  |
| Send                               | `whk send <slug> -d @body.json`, `whk send-to <url>`, `whk replay <id> --to <url>`                                |
| Local app                          | `whk tunnel <port> [--live]`, `whk share <port>`, `whk shares`, `whk names`                                       |
| Email setup                        | `whk fields preview`, `whk layouts`, `whk ai setup`, `whk domains`                                                |
| Account                            | `whk usage`, `whk billing`, `whk keys`, `whk agents`, `whk account`, `whk share-links`, `whk teams`, `whk google` |
| Connect this machine's agents      | `whk setup agent [--agent cursor] [--local] [--dry-run]`                                                          |
| Anything else                      | `whk api <path> [-X METHOD] [-d JSON]`                                                                            |

`whk wait` exits at the first match: start it in the background, trigger
the sender, and its exit is the signal. Without `--since now`, a request
from the last 5 minutes also counts.

`whk api` reaches every route a command does not cover (destinations among
them): `whk api endpoints/<slug>/destinations`,
`whk api -X POST endpoints/<slug>/destinations -d @destination.json`.

Commands that need the person's approval (`whk keys create`,
`whk share-links create`, `whk teams invite`, `whk domains remove`, ...)
print the link and wait; with `--no-wait` they print the approval and exit,
and `whk approvals wait <id>` collects it later.

`whk setup agent` adds the MCP server and this skill to every coding agent
on the machine (Claude Code, Codex, Cursor, VS Code, Claude Desktop, Devin);
without a terminal it needs `--yes`, and `--dry-run --json` says what it
would change first.

Signed provider templates are sent from the MCP tools or the SDKs, not the
CLI: `whk send` and `whk send-to` send the body and headers you give them.
