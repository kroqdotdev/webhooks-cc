# webhooks-cc

Python SDK for [webhooks.cc](https://webhooks.cc): capture webhooks and email in your tests, wait for them, send signed webhooks to your own handlers, and verify provider signatures.

```bash
pip install webhooks-cc
pip install "webhooks-cc[crypto]"  # also verify Discord (Ed25519) and PayPal (RSA) signatures
```

Python 3.10 or later. Get an API key at [webhooks.cc/account/api-keys](https://webhooks.cc/account/api-keys) and set `WHK_API_KEY`, or pass `api_key=`.

## Wait for a webhook

```python
from webhooks_cc import WebhooksCC, match_body_path, temporary_endpoint

with WebhooksCC() as client:
    # Deleted when the block ends, even when the test fails.
    with temporary_endpoint(client, "checkout test") as endpoint:
        trigger_checkout(webhook_url=endpoint.url)

        request = client.requests.wait_for(
            endpoint.slug,
            timeout="30s",
            match=match_body_path("type", "checkout.session.completed"),
        )
        assert request.json()["data"]["object"]["amount_total"] == 2000
```

Durations take `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"7d"`, a `timedelta`, or a number of milliseconds (the unit every webhooks.cc SDK uses, so prefer a string where you mean seconds). Times such as `since` and `Request.received_at` are milliseconds since the epoch.

Matchers combine with `match_all()` and `match_any()`, and any function that takes a `Request` and returns a bool works too: `match_method`, `match_path` (globs with `*` and `**`), `match_header`, `match_query_param`, `match_body_path`, `match_body_subset`, `match_content_type`, `match_verified`, `match_unverified` and `match_email`.

## pytest

Installing the package adds two fixtures. Tests that use them are skipped when `WHK_API_KEY` is not set.

```python
def test_sends_a_receipt_webhook(webhooks_cc, webhooks_cc_endpoint):
    place_order(webhook_url=webhooks_cc_endpoint.url)

    request = webhooks_cc.requests.wait_for(webhooks_cc_endpoint.slug, timeout="30s")
    assert request.method == "POST"
```

`webhooks_cc` is a client for the session; `webhooks_cc_endpoint` is a new endpoint for each test, deleted afterwards. Outside pytest, `temporary_endpoint(client)` is the same as a context manager, and `capture_during(client, action)` runs `action(endpoint)` and returns what it sent.

## Test email: codes and links

Every endpoint receives email at `{slug}@mailhooks.cc`, and at `{slug}+{tag}@mailhooks.cc` for any tag. Use a fresh tag per test run to find your own email. webhooks.cc finds the one-time codes and links in each email, the same ones its dashboard shows.

```python
import uuid
from webhooks_cc import extract_code, extract_link

run = f"signup-{uuid.uuid4().hex[:8]}"
sign_up(email=client.emails.address(endpoint, run))

email = client.emails.wait_for(endpoint.slug, tag=run, subject="Confirm your email")
code = extract_code(email)          # "482913"
link = extract_link(email)          # "https://app.example.com/confirm?token=..."
```

`email.email` holds the parsed message: `subject`, `from_`, `to`, `text`, `html`, attachments, and the SPF, DKIM and DMARC results.

## Send signed webhooks to your handler

Test your own webhook handler, on localhost or anywhere else, with requests signed the way the provider signs them:

```python
response = client.send_to(
    "http://localhost:8000/webhooks/stripe",
    provider="stripe",
    secret="whsec_test_secret",
    template="checkout.session.completed",
)
assert response.status_code == 200
```

Leave out `body` to send the provider's sample payload, or pass your own: a string or bytes go as they are, anything else as JSON. `timestamp` (seconds) and `message_id` make the signature repeatable. `build_request()` returns the method, URL, headers and body without sending. Redirects are never followed, even by an `http_client` of your own, so signed requests only reach the host you named. `client.endpoints.send_template(slug, ...)` sends the same to a webhooks.cc endpoint. `TEMPLATE_PROVIDERS` lists the 34 providers.

## Verify signatures

```python
from webhooks_cc import verify_signature

valid = verify_signature(
    "stripe",
    body=request.body,          # the exact bytes or text received
    headers=request.headers,    # any mapping; names match in any case
    secret="whsec_...",
)
```

Twilio, Square and HubSpot also need `url`; HubSpot also `method`. Discord takes `public_key`. One function per provider is in `webhooks_cc.verify`.

When webhooks.cc forwards requests or email to your server, check that they came from it with the endpoint's forwarding secret (`client.forwarding.secret(slug)`):

```python
from webhooks_cc import WebhookVerificationError, verify_forwarded_email

try:
    event = verify_forwarded_email(body, headers, secret)
except WebhookVerificationError as error:
    return 400 if error.code == "invalid_payload" else 401
print(event["data"]["subject"])
```

`verify_forwarded_request()` checks a request forwarded as JSON, and `verify_relayed_request()` one relayed as it was received.

## Stream requests as they arrive

```python
for request in client.requests.subscribe(endpoint.slug, timeout="10m", reconnect=True):
    print(request.method, request.path)
```

## Errors

API errors raise `WebhooksCCError` with a `status_code`, or one of its subclasses: `UnauthorizedError` (401), `NotFoundError` (404), `RateLimitError` (429, with `retry_after`) and `TimeoutError`, which is also Python's built-in `TimeoutError`. Network failures raise httpx's exceptions. Retries are off unless you pass `retry=RetryOptions(max_attempts=3)`.

## Same behaviour as the TypeScript SDK

This SDK passes the same conformance vectors as [`@webhooks-cc/sdk`](https://www.npmjs.com/package/@webhooks-cc/sdk): signing, signature verification, forwarding signatures, matchers and durations. They live in [`packages/sdk/conformance`](https://github.com/kroqdotdev/webhooks-cc/tree/main/packages/sdk/conformance).

## License

MIT
