# webhooks.cc for Make

The webhooks.cc and mailhooks.cc custom app for Make, as Make's IML definitions:

- `base.imljson`: the API's base URL and the API key header.
- `connections/api-key.imljson`: an API key, checked against `/api/usage`.
- `webhooks/new-email.imljson` and `modules/watch-emails.imljson`: **Watch emails**, an instant trigger. Attaching it adds a destination to the endpoint that sends each email to Make as JSON (the `email.received` JSON, read from its `data`); detaching removes it.
- `modules/create-endpoint.imljson`, `modules/send-test-email.imljson`: actions.
- `modules/find-emails.imljson`: a search.
- `rpcs/list-endpoints.imljson`: the endpoints for the dropdowns.

## Develop

```bash
pnpm --filter @webhooks-cc/make-app test
```

The tests check the files and their references and, when the web app runs locally, run the requests each definition describes against it.

## Publish

`deploy.py` creates the app in the Make account the first time and writes every section from these files on each run, through Make's SDK apps API (the same calls the Make Apps Editor makes):

```bash
MAKE_API_TOKEN=... python3 packages/make-app/deploy.py                      # https://webhooks.cc
MAKE_API_TOKEN=... python3 packages/make-app/deploy.py --base-url https://<tunnel>   # a dev server, for testing
```

The token needs the `sdk-apps:read` and `sdk-apps:write` scopes (Profile > API access). The remote names of the app and its components are kept in `~/.config/webhooks-cc/make-app-state.json` (`MAKE_APP_STATE`). A private app can be used in the owner's organization once it is installed there (Make asks the first time a scenario runs it); test it in a scenario, then request a review to make it public, which needs the API in production.
