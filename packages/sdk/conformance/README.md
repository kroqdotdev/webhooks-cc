# SDK conformance vectors

Test data every webhooks.cc SDK must pass. The TypeScript SDK in this package is the reference: `src/__tests__/conformance.test.ts` builds these files from it, checks that it gives the expected answer for every case, and fails when a file here is out of date. The SDKs in other languages run the same files in their own test suites, so a port either behaves like the TypeScript SDK or its CI fails.

| File              | What a port must do                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `signing.json`    | Build signed requests (`sendTo`, `buildRequest`): the same signature headers and the same body.                                         |
| `verify.json`     | Check provider signatures (`verifySignature`) and reach the same verdict, valid or not.                                                 |
| `forwarding.json` | Verify what webhooks.cc forwards (`verifyForwardedEmail`, `verifyForwardedRequest`, `verifyRelayedRequest`), with the same error codes. |
| `matchers.json`   | Match captured requests (`matchHeader`, `matchBodyPath`, `matchEmail`, ...), as `waitFor` does.                                         |
| `durations.json`  | Read timeouts and poll intervals given as `"30s"`, `"5m"` or milliseconds.                                                              |

Each file has a `version` (raised when the format changes), a `description` that says how to run one vector, and the `vectors`. Codes and links found in emails are not here: the API returns them with each email, so ports read them instead of reimplementing the extraction.

## What ports get wrong

- A signature covers the body's bytes exactly as sent. Never parse and re-serialize JSON before signing or verifying. The exceptions are Mailgun and Adyen, which sign inside the body: there `expected.body` is the input re-serialized as compact JSON (no spaces, non-ASCII characters kept as they are) with the signature filled in.
- `whsec_` secrets (Standard Webhooks, Clerk, Resend, forwarding): strip `whsec_` and decode the rest as base64, padding optional. When that fails, the key is the UTF-8 bytes of the whole secret, prefix included. Adyen's key is hex. Every other provider keys its HMAC with the secret string as it is, even one that starts with `whsec_` (Stripe, WorkOS).
- Twilio signs the full URL followed by each form parameter's name and value, sorted by name and then by value.
- HubSpot signs the method, the URL with HubSpot's reserved percent-escapes decoded, the body and the timestamp in milliseconds. It is the only provider whose signatures expire (after five minutes); the others verify at any age, so captured requests can be checked later.
- Header names match in any case.

## Changing behaviour

1. Change the TypeScript SDK.
2. Run `pnpm --filter @webhooks-cc/sdk exec vitest run conformance -u` to rewrite the files, and read the diff.
3. Port the change to every other SDK; their CI fails until it is.

A new webhook provider must be added to `SIGNATURE_HEADERS` or `NOT_SIGNED` in the test before it passes. The JSON files are excluded from Prettier because the test compares them byte for byte.
