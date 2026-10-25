# webhooks.cc Go SDK

[![Go Reference](https://pkg.go.dev/badge/webhooks.cc/go.svg)](https://pkg.go.dev/webhooks.cc/go)

Capture webhooks and email in your Go tests, wait for them, send signed webhooks to your own handlers, and verify provider and forwarding signatures, with [webhooks.cc](https://webhooks.cc). Standard library only.

```bash
go get webhooks.cc/go
```

Go 1.25 or later. Create an API key at [webhooks.cc/account/api-keys](https://webhooks.cc/account/api-keys) and set `WHK_API_KEY`.

## Wait for a webhook

```go
import (
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
	"webhooks.cc/go/whktest"
)

func TestCheckoutSendsAWebhook(t *testing.T) {
	client := whktest.Client(t)             // skipped when WHK_API_KEY is not set
	endpoint := whktest.Endpoint(t, client) // deleted when the test ends

	triggerCheckout(endpoint.URL)

	request, err := client.Requests.WaitFor(t.Context(), endpoint.Slug, webhookscc.WaitOptions{
		Timeout: 30 * time.Second,
		Match:   webhookscc.MatchBodyPath("type", "checkout.session.completed"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Log(request.Body)
}
```

## Test email

```go
address, _ := client.Emails.Address(endpoint.Slug, "signup-42")
signUp(address)

email, err := client.Emails.WaitFor(ctx, endpoint.Slug, webhookscc.EmailQuery{Tag: "signup-42"})
code, _ := webhookscc.ExtractCode(email)
```

## Send signed webhooks to your handler

```go
response, err := client.SendTo(ctx, "http://localhost:8080/webhooks/stripe", webhookscc.SendOptions{
	Provider: "stripe",
	Secret:   "whsec_test_secret",
	Template: "checkout.session.completed",
})
```

## Mock responses and response rules

An endpoint answers with its `MockResponse` instead of a plain 200 OK, or with the first of its `ResponseRules` whose conditions match the request (method, path, header, query, body, body_path, content_type or size). Bodies and header values may hold `{{ placeholders }}` filled in from each request, such as `{{ json.id }}`. Check what a sender would get back without sending anything:

```go
preview, err := client.Endpoints.PreviewResponse(ctx, endpoint.Slug, webhookscc.PreviewResponseOptions{
	ResponseRules: webhookscc.Value([]webhookscc.ResponseRule{{
		Conditions: []webhookscc.ResponseRuleCondition{{Field: "body_path", Path: "type", Op: "eq", Value: "ping"}},
		Response:   webhookscc.MockResponse{Status: 202, Body: `{"pong":"{{ json.id }}"}`},
	}}),
})
```

It runs against the endpoint's newest HTTP request unless you set `RequestID`, and uses the saved settings unless you set `MockResponse` or `ResponseRules` (`webhookscc.Null` tries none at all). `Endpoints.Update` saves them.

## Forwarding destinations

An endpoint forwards what it captures to up to 10 destinations, each with its own kinds, filter, format, headers, retries, throttle, delay and signing secret:

```go
destination, err := client.Destinations.Create(ctx, endpoint.Slug, webhookscc.DestinationInput{
	URL:   webhookscc.Value("https://hooks.example.com/invoices"),
	Email: webhookscc.Value(false),
	Filter: webhookscc.Value(webhookscc.DestinationFilter{
		Conditions: []webhookscc.ResponseRuleCondition{{Field: "body_path", Path: "type", Op: "eq", Value: "invoice.paid"}},
	}),
	Format:       webhookscc.Value(webhookscc.FormatTemplate),
	BodyTemplate: webhookscc.Value(json.RawMessage(`{"invoice":"{{ json.data.object.id }}"}`)),
})
preview, err := client.Destinations.Preview(ctx, endpoint.Slug, webhookscc.PreviewDestinationOptions{DestinationID: destination.ID})
```

Filters take the conditions of response rules, plus `kind`, `email` (with `Name` subject, from, to, text or tag), `spam_score`, `email_auth` (with `Name` spf, dkim or dmarc) and `signature`. `Preview` is a dry run: whether the filter lets a captured request through and the exact request the destination would send. `Update` changes only the fields set with `Value` or `Null`, `Test` sends one delivery now, and `List`, `Get`, `Delete`, `Reorder`, `Secret` and `RotateSecret` do what they say.

## Verify signatures

```go
import "webhooks.cc/go/verify"

valid, err := verify.Signature("stripe", body, r.Header, verify.Options{Secret: secret})
event, err := verify.ForwardedEmail(body, r.Header, forwardingSecret)
paid, err := verify.ForwardedJSON(body, r.Header, destinationSecret) // a destination's own JSON
```

The `verify` package needs no client or API key, so it fits production handlers too.

## Documentation

- Guide: [webhooks.cc/docs/sdk/go](https://webhooks.cc/docs/sdk/go)
- API reference: [pkg.go.dev/webhooks.cc/go](https://pkg.go.dev/webhooks.cc/go)

The module lives in [`packages/sdk-go`](https://github.com/kroqdotdev/webhooks-cc/tree/main/packages/sdk-go) of the webhooks.cc repository and passes the TypeScript SDK's conformance vectors (`packages/sdk/conformance`) for signing, verification and matchers. Run its tests with `go test ./...` from this directory.

MIT licensed.
