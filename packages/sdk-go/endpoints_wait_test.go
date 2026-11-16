package webhookscc_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

func TestCreateWaitingWaitsOutTheLimit(t *testing.T) {
	api := newFakeAPI(t)
	var calls atomic.Int32
	api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, 429, map[string]string{"error": "Too many requests"})
			return
		}
		writeJSON(w, 200, map[string]string{"id": "ep_1", "slug": "tmp-1"})
	})
	started := time.Now()
	endpoint, err := api.client().Endpoints.CreateWaiting(context.Background(), webhookscc.CreateEndpointOptions{}, time.Minute)
	if err != nil || endpoint.Slug != "tmp-1" {
		t.Fatalf("CreateWaiting = %+v, %v", endpoint, err)
	}
	if calls.Load() != 2 || time.Since(started) < time.Second {
		t.Errorf("calls = %d after %s, want 2 after at least 1s", calls.Load(), time.Since(started))
	}
}

func TestCreateWaitingGivesUpWithOneLine(t *testing.T) {
	api := newFakeAPI(t)
	var calls atomic.Int32
	api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "480")
		w.Header().Set("X-RateLimit-Limit", "30")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1767225660")
		writeJSON(w, 429, map[string]string{"error": "Too many requests"})
	})
	_, err := api.client().Endpoints.CreateWaiting(context.Background(), webhookscc.CreateEndpointOptions{}, time.Minute)
	if !errors.Is(err, webhookscc.ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	want := "webhooks.cc: too many new endpoints: the limit is 30 in a rolling window; the next one is free in 8m0s. Share one endpoint between tests (create it in TestMain), or run fewer tests that create one (HTTP 429)"
	if err.Error() != want || strings.Contains(err.Error(), "\n") {
		t.Errorf("err = %q\nwant  %q", err, want)
	}
	if calls.Load() != 1 {
		t.Errorf("calls = %d, want 1 (no wait past maxWait)", calls.Load())
	}
}

func TestAWaitTimeoutSaysWhatItWaitedFor(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/endpoints/acme/requests", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []map[string]any{{"id": "r1", "method": "POST", "path": "/", "receivedAt": time.Now().UnixMilli()}})
	})
	client := api.client()
	_, err := client.Emails.WaitFor(context.Background(), "acme", webhookscc.EmailQuery{
		Subject: "Confirm", Tag: "run1", Timeout: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond,
	})
	want := `webhooks.cc: timed out after 50ms waiting for an email with tag "run1", subject "Confirm" on endpoint "acme" (1 did not match)`
	if err == nil || err.Error() != want {
		t.Errorf("err = %v\nwant  %s", err, want)
	}
	_, err = client.Requests.WaitForAll(context.Background(), "acme", 2, webhookscc.WaitOptions{
		Timeout: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond,
	})
	want = `webhooks.cc: timed out after 50ms waiting for 2 requests on endpoint "acme" (1 arrived)`
	if err == nil || err.Error() != want {
		t.Errorf("err = %v\nwant  %s", err, want)
	}
}

func TestCreateWaitingPassesOnALimitWithoutRetryAfter(t *testing.T) {
	api := newFakeAPI(t)
	var calls atomic.Int32
	api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, 429, map[string]string{"error": "Too many active demo endpoints. Please try again later."})
	})
	_, err := api.client().Endpoints.CreateWaiting(context.Background(), webhookscc.CreateEndpointOptions{}, time.Minute)
	if !errors.Is(err, webhookscc.ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	if !strings.Contains(err.Error(), "Too many active demo endpoints") || calls.Load() != 1 {
		t.Errorf("err = %q after %d calls, want the server's words after 1", err, calls.Load())
	}
}
