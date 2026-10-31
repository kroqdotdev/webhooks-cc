# webhooks.cc for Zapier

The webhooks.cc and mailhooks.cc app for Zapier. It connects with an API key and offers:

- **New Email** (trigger, instant): an endpoint received an email, with the fields and line items its layouts read. A REST hook: turning a Zap on adds a destination to the endpoint that sends each email to Zapier as JSON, and turning it off removes it.
- **Create Endpoint** and **Send Test Email** (actions).
- **Find Email** (search): the newest email at an endpoint that contains some text.

Records are the `data` of the `email.received` JSON that forwarding sends, so a Zap reads the same fields as any destination.

The destination a Zap adds is named after it (`Zapier (Zap 123)`), so it can be told apart in the dashboard; deleting it there stops the Zap's emails. If a Zap is removed while its destination stays (an unsubscribe that failed), Zapier answers 410 and webhooks.cc turns the destination off. Find Email uses the search API, limited to 60 searches per 10 minutes per account; when a limit is reached the app asks Zapier to try again later.

## Develop

```bash
pnpm --filter @webhooks-cc/zapier-app test
```

The tests check the app against Zapier's schema and, when the web app runs locally (`WHK_BASE_URL`, default `http://localhost:3000`, with the Supabase stack from `apps/web/.env.local`), run every trigger, action and search against it.

## Publish

Publishing needs the Zapier developer account:

```bash
npm install -g zapier-platform-cli
zapier login
zapier push   # .zapierapprc (committed) names the registered integration
```

Then fill in the listing in the Zapier developer platform (logo, description, the help link to the docs) and submit it for review. While it is private, invite testers from the developer platform.
