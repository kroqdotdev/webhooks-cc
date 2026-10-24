# SDK conformance vectors

Test data every webhooks.cc SDK must pass. The TypeScript SDK in this package is the reference: `src/__tests__/conformance.test.ts` builds these files from it, checks that it gives the expected answer for every case, and fails when a file here is out of date. The SDKs in other languages run the same files in their own test suites, so a port either behaves like the TypeScript SDK or its CI fails.

| File                | What a port must do                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signing.json`      | Build signed requests (`sendTo`, `buildRequest`): the same signature headers and the same body.                                                                          |
| `verify.json`       | Check provider signatures (`verifySignature`) and reach the same verdict, valid or not.                                                                                  |
| `forwarding.json`   | Verify what webhooks.cc forwards (`verifyForwardedEmail`, `verifyForwardedRequest`, `verifyRelayedRequest`), with the same error codes, and refuse a secret with no key. |
| `matchers.json`     | Match captured requests (`matchHeader`, `matchBodyPath`, `matchEmail`, ...), as `waitFor` does.                                                                          |
| `durations.json`    | Read timeouts and poll intervals given as `"30s"`, `"5m"` or milliseconds. Only for ports that take durations that way (Go does not).                                    |
| `rules.json`        | Evaluate conditions of response rules and forwarding filters. The receiver runs these (Rust); a port needs them only if it evaluates conditions itself.                  |
| `placeholders.json` | Fill in `{{ ... }}` placeholders in mock responses. The receiver runs these (Rust); a port needs them only if it renders templates itself.                               |

Each file has a `version` (raised when the format changes), a `description` that says how to run one vector, and the `vectors`. `rules.json` and `placeholders.json` are written by `src/__tests__/rules-conformance.test.ts` (regenerate with `pnpm --filter @webhooks-cc/sdk exec vitest run rules-conformance -u`). Codes and links found in emails are not here: the API returns them with each email when asked (`extracts=true` on the request routes), so ports read them instead of reimplementing the extraction.

## What ports get wrong

- A signature covers the body's bytes exactly as sent. Never parse and re-serialize JSON before signing or verifying. The exceptions are Mailgun and Adyen, which sign inside the body: there `expected.body` is the input re-serialized as compact JSON (keys in their original order, no spaces, no escaping of `<`, `>`, `&` or non-ASCII characters) with the signature filled in. Mailgun signs the `timestamp` and `token` already in the body's `signature` object, not the vector's `timestamp`; Adyen signs fixed fields of each notification item (`pspReference`, `originalReference`, `merchantAccountCode`, `merchantReference`, `amount.value`, `amount.currency`, `eventCode`, `success`, joined with `:`, a missing field as empty), and every item must carry a valid signature.
- Standard Webhooks, Clerk, Resend and forwarding secrets: strip a leading `whsec_` if there is one and decode the rest as standard base64 (`+` and `/`, padding optional, ASCII whitespace ignored). When that fails (a character outside `A-Z`, `a-z`, `0-9`, `+` and `/`; `=` anywhere but as one or two final characters that make the length a multiple of 4; or 4n+1 characters without padding), the key is the UTF-8 bytes of the whole secret, prefix included. A secret that decodes to no key at all (`whsec_`, whitespace) is an error, raised before the request is looked at: an HMAC keyed with nothing is one anyone can compute. Adyen's key is hex. Every other provider keys its HMAC with the secret string as it is, even one that starts with `whsec_` (Stripe, WorkOS).
- Twilio signs the full URL followed by each form parameter's name and value, sorted by name and then by value.
- HubSpot signs the method, the URL, the body and the timestamp in milliseconds. In the URL, exactly these escapes are decoded first, and only in uppercase: `%3A %2F %3F %40 %21 %24 %27 %28 %29 %2A %2C %3B`. HubSpot is the only provider whose signatures expire (after five minutes); the others verify at any age, so captured requests can be checked later.
- PayPal: a certificate is trusted because of where it comes from, not by its chain or dates. Only fetch `https` URLs on `api.paypal.com`, `api-m.paypal.com`, `api.sandbox.paypal.com` or `api-m.sandbox.paypal.com` whose path starts with `/v1/notifications/certs/`; refuse anything else, and any `paypal-auth-algo` other than `SHA256withRSA`. Read the URL the way browsers do (a `\` is a `/`), then download the URL rebuilt from what you checked, never the raw header: an HTTP client that parses `https://api.paypal.com\v1\notifications\certs\x@evil.test/` its own way fetches from `evil.test`, and the sender's certificate then makes a forged signature valid. Redirects get the same check. The signed message is `transmission id|transmission time|webhook id|CRC-32 of the body as a decimal number`. A port should let tests supply the certificate instead of downloading it, as the vectors do.
- Header names match in any case.

## Changing behaviour

1. Change the TypeScript SDK.
2. Run `pnpm --filter @webhooks-cc/sdk exec vitest run conformance -u` to rewrite the files, and read the diff.
3. Port the change to every other SDK; their CI fails until it is.

A new webhook provider must be added to `SIGNATURE_HEADERS` or `NOT_SIGNED` in the test before it passes. The JSON files are excluded from Prettier because the test compares them byte for byte.
