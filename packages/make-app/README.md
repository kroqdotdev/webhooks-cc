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

Publishing needs the Make account: create a custom app in Make (or with the Make Apps Editor for VS Code), copy each file into the matching block (base, connection, webhook, modules, RPC), test it in a scenario, then request a review to make the app public.
