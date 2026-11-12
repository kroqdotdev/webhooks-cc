# pytest-webhooks-cc

pytest fixtures for testing the webhooks and emails your app sends, with [webhooks.cc](https://webhooks.cc).

webhooks.cc gives each test a real URL (and a real email address) that captures whatever is sent to it. Your test points the code under test at that URL, then reads what arrived: method, headers, body, signature. No mock server to write, no tunnel to keep open, and it works the same on your machine and in CI.

```bash
pip install pytest-webhooks-cc
```

That is the whole setup: no conftest, no import. The fixtures are in every test as soon as the package is installed. Python 3.10 or later, pytest 8 or later.

Create an API key on your [API keys page](https://webhooks.cc/account/api-keys) (the free plan is enough for a small suite) and set it as `WHK_API_KEY`. Without it, tests that use the fixtures are skipped, so the suite still passes on a machine without a key.

## Test a webhook your app sends

`webhooks_cc_endpoint` is a new capture URL for each test, deleted when the test ends, whether it passed or failed. `webhooks_cc` is the client that reads what the URL received.

```python
import httpx
from webhooks_cc import match_header


def send_order_webhook(url: str, order: dict) -> None:
    """Stands in for your app: the code under test."""
    httpx.post(url, json=order, headers={"X-Event": "order.paid"})


def test_sends_order_paid(webhooks_cc, webhooks_cc_endpoint):
    send_order_webhook(webhooks_cc_endpoint.url, {"id": "ord_1", "total": 4999})

    request = webhooks_cc.requests.wait_for(
        webhooks_cc_endpoint.slug,
        timeout="30s",
        match=match_header("x-event", "order.paid"),
    )
    assert request.method == "POST"
    assert request.json() == {"id": "ord_1", "total": 4999}
    assert request.headers["content-type"] == "application/json"
```

`wait_for` polls until a matching request arrives and raises `webhooks_cc.TimeoutError` when the time runs out. A request that arrived before the wait started still counts. [Matchers](https://webhooks.cc/docs/sdk/matchers) such as `match_body_path("data.status", "paid")` pick one request out of several.

## Test a sign-up email

Every endpoint also receives email, at `{slug}@mailhooks.cc`. Sign up with that address and read the confirmation code or link out of the email your app sent:

```python
from webhooks_cc import extract_code, extract_link

from myapp.accounts import sign_up  # your code: creates the account, sends the email


def test_sign_up_sends_a_confirmation_email(webhooks_cc, webhooks_cc_endpoint):
    address = webhooks_cc.emails.address(webhooks_cc_endpoint)
    sign_up(email=address, password="correct horse battery staple")

    email = webhooks_cc.emails.wait_for(
        webhooks_cc_endpoint.slug, subject="Confirm your email", timeout="60s"
    )
    assert email.email.to[0].address == address
    assert len(extract_code(email)) == 6                # "482913"
    assert "/confirm?token=" in extract_link(email)     # the link to click
```

The codes and links are found on the server, the same ones the webhooks.cc dashboard shows. `email.email` holds the parsed message: `subject`, `from_`, `to`, `text`, `html`, attachments, and the SPF, DKIM and DMARC results. To try the test before your app can send mail, `webhooks_cc.emails.send_test(webhooks_cc_endpoint.slug)` delivers a sample email with a code and a link.

## Fixtures

| Fixture                | Scope    | What you get                                                                                                                                                                  |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks_cc`          | session  | A [`WebhooksCC`](https://webhooks.cc/docs/sdk/python) client configured from the environment. Tests that use it are skipped when `WHK_API_KEY` is not set.                    |
| `webhooks_cc_endpoint` | function | A new [`Endpoint`](https://webhooks.cc/docs/sdk/python) named after the test and deleted when it ends. `.url` captures HTTP requests, `.slug` names it in the client's calls. |

For an endpoint that answers with something other than 200 (to test your retries, say), write a fixture of your own with `temporary_endpoint`, which deletes the endpoint the same way:

```python
import pytest
from webhooks_cc import temporary_endpoint


@pytest.fixture
def failing_endpoint(webhooks_cc):
    with temporary_endpoint(
        webhooks_cc, "always 503", mock_response={"status": 503, "body": "", "headers": {}}
    ) as endpoint:
        yield endpoint
```

## Settings

The fixtures read the environment; there is nothing to put in `pytest.ini`.

| Variable          | Default                  | What it does                                                        |
| ----------------- | ------------------------ | ------------------------------------------------------------------- |
| `WHK_API_KEY`     | none                     | The API key the client uses. Unset or empty: the tests are skipped. |
| `WHK_BASE_URL`    | `https://webhooks.cc`    | Where the API is.                                                   |
| `WHK_WEBHOOK_URL` | `https://go.webhooks.cc` | Where endpoints capture, the host in `webhooks_cc_endpoint.url`.    |

pytest's own options do the rest:

| Option                                                          | What it does                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `-rs`                                                           | Lists each skipped test with its reason.                                                |
| `-p no:webhooks_cc`                                             | Turns the fixtures off for a run.                                                       |
| `-p no:pytest_webhooks_cc`                                      | Keeps the fixtures and drops the line about skipped tests.                              |
| `-p pytest_webhooks_cc` with `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` | Loads the plugin, fixtures included, when pytest is told not to load installed plugins. |

When the key is missing, the plugin says so once, under pytest's "collected" line, because a skip is otherwise easy to miss:

```text
collected 14 items
webhooks.cc: WHK_API_KEY is not set, so 3 tests that use the webhooks.cc fixtures will be skipped
```

## In CI

Add the key as a secret and pass it to the test step. On GitHub Actions:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      WHK_API_KEY: ${{ secrets.WHK_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -e . pytest-webhooks-cc
      - run: pytest
```

Pull requests from forks get no secrets, so their webhooks.cc tests are skipped while the rest of the suite runs. With pytest-xdist (`pytest -n auto`) each worker gets its own client and every test its own endpoint, so parallel tests never see each other's requests.

## How it relates to webhooks-cc

The fixtures are defined once, in the [`webhooks-cc`](https://pypi.org/project/webhooks-cc/) SDK, which this package depends on. If you already install `webhooks-cc`, you already have them; this package is the pytest-shaped way in, and adds the line about skipped tests. Installing both registers the fixtures once. Everything else the SDK does is there too: signed test requests for Stripe, GitHub and 32 other providers with `build_template_request` (no key and no network needed), `verify_signature`, mock responses and response rules.

## Documentation

- [Testing with pytest](https://webhooks.cc/docs/sdk/testing/pytest): a whole suite, with handler tests that need no network, retries, emails and CI
- [Python SDK reference](https://webhooks.cc/docs/sdk/python)
- [Matchers](https://webhooks.cc/docs/sdk/matchers) and [signature verification](https://webhooks.cc/docs/sdk/signatures)
- [Source](https://github.com/kroqdotdev/webhooks-cc/tree/main/packages/pytest-webhooks-cc)

## License

MIT
