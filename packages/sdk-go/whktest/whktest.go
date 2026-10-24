// Package whktest has test helpers for the webhooks.cc SDK.
//
//	func TestSendsAReceiptWebhook(t *testing.T) {
//		client := whktest.Client(t) // skips the test when WHK_API_KEY is not set
//		endpoint := whktest.Endpoint(t, client)
//
//		placeOrder(endpoint.URL)
//
//		request, err := client.Requests.WaitFor(t.Context(), endpoint.Slug, webhookscc.WaitOptions{})
//		if err != nil {
//			t.Fatal(err)
//		}
//		if request.Method != "POST" {
//			t.Errorf("method = %s", request.Method)
//		}
//	}
package whktest

import (
	"context"
	"errors"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

const (
	cleanupTimeout = 30 * time.Second
	maxNameLength  = 100
)

// Client returns a client configured from the environment (WHK_API_KEY,
// WHK_BASE_URL, WHK_WEBHOOK_URL) and opts. It skips the test when
// WHK_API_KEY is not set and no WithAPIKey option is given.
func Client(t testing.TB, opts ...webhookscc.Option) *webhookscc.Client {
	t.Helper()
	client, err := webhookscc.New(opts...)
	if errors.Is(err, webhookscc.ErrMissingAPIKey) {
		t.Skipf("%s is not set", webhookscc.APIKeyEnv)
	}
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// Endpoint creates an endpoint named after the test and deletes it when the
// test ends. Pass options to configure it; an empty Name is replaced by the
// test's name.
func Endpoint(t testing.TB, client *webhookscc.Client, opts ...webhookscc.CreateEndpointOptions) *webhookscc.Endpoint {
	t.Helper()
	var options webhookscc.CreateEndpointOptions
	if len(opts) > 0 {
		options = opts[0]
	}
	if options.Name == "" {
		options.Name = t.Name()
		// Endpoint names are at most 100 characters; subtest names can be longer.
		if runes := []rune(options.Name); len(runes) > maxNameLength {
			options.Name = string(runes[:maxNameLength])
		}
	}
	endpoint, err := client.Endpoints.Create(context.Background(), options)
	if err != nil {
		t.Fatalf("creating a webhooks.cc endpoint: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
		if err := client.Endpoints.Delete(ctx, endpoint.Slug); err != nil && !errors.Is(err, webhookscc.ErrNotFound) {
			t.Errorf("deleting webhooks.cc endpoint %s: %v", endpoint.Slug, err)
		}
	})
	return endpoint
}
