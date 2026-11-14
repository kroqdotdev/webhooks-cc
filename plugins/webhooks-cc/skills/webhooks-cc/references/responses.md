# Mock responses and response rules

Make an endpoint answer like the real receiver would, to test retries,
backoff, idempotency or code that reads the reply.

## Set them

`update_endpoint` with:

- `mockResponse`: the default answer, with `status`, `body`, `headers` and
  `delay` (milliseconds, at most 30 seconds), for example
  `{ "status": 503, "delay": 2000 }`.
- `responseRules`: answers that depend on the request. Sending them replaces
  the whole list, so include the rules to keep (`get_endpoint`). Checked top to
  bottom; the first match answers; without a match the mock response (or a
  plain 200) does. Each rule has `conditions` (all must hold, or any with
  `logic: "or"`) and a `response` shaped like `mockResponse`. At most 50
  rules, 10 conditions each.

`mockResponse: null` or `responseRules: null` removes them. Clear what you
set for a task when it ends.

## Conditions

Each condition is `{ field, op, value }`, plus `name` for a header or query
parameter and `path` for a body field (dot path, `items.0.sku`).

```text
field: method, path, header, query, body, body_path, content_type, size
op:    eq, neq, contains, not_contains, starts_with, ends_with,
       matches (glob over the whole value), regex (RE2), exists, not_exists,
       gt, gte, lt, lte
```

Regular expressions are RE2: no lookarounds or backreferences; `(?i)`
ignores case.

## Placeholders

Bodies and header values take `{{ ... }}`, filled in from each request:
`{{ json.data.id }}`, `{{ body }}`, `{{ headers.x-request-id }}`,
`{{ query.page }}`, `{{ method }}`, `{{ path }}`, `{{ id }}`, `{{ uuid }}`,
`{{ now }}`. Filters: `| default: "x"`, `| json`, `| lower`, `| upper`,
`| truncate: 80`. In a JSON body, text is escaped for you and numbers stay
numbers. Forwarding templates use the same syntax.

## Check before relying on it

`preview_response` with a captured `requestId` (and the `mockResponse` or
`responseRules` you are about to save) shows which rule answers and the
exact body. Anything in `unknownPlaceholders` is a typo.

## A service that calls back later

Answer at once with a mock response, and add a destination with
`delaySeconds` and a `bodyTemplate` that posts to the app's callback URL
(see [forwarding.md](forwarding.md)).
