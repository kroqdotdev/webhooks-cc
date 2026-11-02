# webhooks.cc

webhooks.cc and mailhooks.cc capture webhooks and inbound email. Every endpoint has an HTTP URL and an email address; this app watches the emails an endpoint receives, with the fields your layouts read from each one, and can create endpoints, send test emails and search what arrived.

## Connect

Create an API key on webhooks.cc (or mailhooks.cc) under **Account > API keys** and paste it into the connection. Keys start with `whcc_`.

## Modules

- **Watch emails**: runs the scenario for each email an endpoint receives. Turning the scenario on adds a destination to the endpoint that sends each email to Make; turning it off removes it.
- **Search emails**: finds an endpoint's emails by text.
- **Send a test email**: sends a sample email to an endpoint, to try a scenario.
- **Create an endpoint**: makes a new endpoint and returns its URL and email address.
- **Make an API call**: calls any route of the webhooks.cc API with the connection's key.

The API reference is at https://webhooks.cc/docs/api.
