package webhookscc_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

// fakeAPI serves the API routes a test registers and records what it got.
type fakeAPI struct {
	t      *testing.T
	mux    *http.ServeMux
	server *httptest.Server
	mu     sync.Mutex
	calls  []*http.Request
	bodies []string
}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	api := &fakeAPI{t: t, mux: http.NewServeMux()}
	api.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		api.mu.Lock()
		api.calls = append(api.calls, r)
		api.bodies = append(api.bodies, string(body))
		api.mu.Unlock()
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		api.mux.ServeHTTP(w, r)
	}))
	t.Cleanup(api.server.Close)
	return api
}

func (a *fakeAPI) handle(pattern string, handler http.HandlerFunc) {
	a.mux.HandleFunc(pattern, handler)
}

func (a *fakeAPI) client(opts ...webhookscc.Option) *webhookscc.Client {
	a.t.Helper()
	all := append([]webhookscc.Option{
		webhookscc.WithAPIKey("whcc_test"),
		webhookscc.WithBaseURL(a.server.URL + "/"),
		webhookscc.WithWebhookURL(a.server.URL),
	}, opts...)
	client, err := webhookscc.New(all...)
	if err != nil {
		a.t.Fatal(err)
	}
	return client
}

func (a *fakeAPI) last() (*http.Request, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.calls) == 0 {
		a.t.Fatal("no request reached the fake API")
	}
	return a.calls[len(a.calls)-1], a.bodies[len(a.bodies)-1]
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestJSON(id string, receivedAt int64, extra map[string]any) map[string]any {
	request := map[string]any{
		"id": id, "endpointId": "ep_1", "method": "POST", "path": "/", "headers": map[string]string{},
		"body": `{"type":"invoice.paid"}`, "queryParams": map[string]string{}, "ip": "203.0.113.7",
		"size": 23, "receivedAt": receivedAt, "kind": "http",
	}
	for key, value := range extra {
		request[key] = value
	}
	return request
}

func TestNewNeedsAnAPIKey(t *testing.T) {
	t.Setenv(webhookscc.APIKeyEnv, "")
	if _, err := webhookscc.New(); !errors.Is(err, webhookscc.ErrMissingAPIKey) {
		t.Fatalf("err = %v, want ErrMissingAPIKey", err)
	}
	t.Setenv(webhookscc.APIKeyEnv, "whcc_env")
	if _, err := webhookscc.New(); err != nil {
		t.Fatal(err)
	}
}

func TestAPICallsCarryTheKeyAndUserAgent(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"used": 5, "limit": 100, "remaining": 95, "plan": "free", "periodEnd": nil})
	})
	usage, err := api.client().Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if usage.Used != 5 || usage.Remaining != 95 || usage.Plan != "free" || !usage.PeriodEnd.IsZero() {
		t.Errorf("usage = %+v", usage)
	}
	request, _ := api.last()
	if got := request.Header.Get("Authorization"); got != "Bearer whcc_test" {
		t.Errorf("Authorization = %q", got)
	}
	if got := request.Header.Get("User-Agent"); got != "webhooks-cc-go/"+webhookscc.Version {
		t.Errorf("User-Agent = %q", got)
	}
}

func TestCreateEndpoint(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"id": "ep_1", "slug": "acme-test", "name": "checkout", "url": "https://go.webhooks.cc/w/acme-test",
			"emailAddress": "acme-test@mailhooks.cc", "createdAt": 1767225600000, "isEphemeral": true,
			"expiresAt": 1767229200000, "mockResponse": map[string]any{"status": 201, "body": "ok", "headers": map[string]string{"x": "y"}, "delay": 250},
		})
	})
	endpoint, err := api.client().Endpoints.Create(context.Background(), webhookscc.CreateEndpointOptions{
		Name:         "checkout",
		ExpiresIn:    time.Hour,
		MockResponse: &webhookscc.MockResponse{Status: 201, Body: "ok", Delay: 250 * time.Millisecond},
	})
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.Slug != "acme-test" || !endpoint.IsEphemeral || endpoint.CreatedAt.UnixMilli() != 1767225600000 {
		t.Errorf("endpoint = %+v", endpoint)
	}
	if endpoint.MockResponse == nil || endpoint.MockResponse.Delay != 250*time.Millisecond || endpoint.MockResponse.Headers["x"] != "y" {
		t.Errorf("mock response = %+v", endpoint.MockResponse)
	}
	_, body := api.last()
	var sent map[string]any
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["name"] != "checkout" || sent["isEphemeral"] != true {
		t.Errorf("sent %s", body)
	}
	expiresAt, _ := sent["expiresAt"].(float64)
	if diff := time.UnixMilli(int64(expiresAt)).Sub(time.Now().Add(time.Hour)); diff > time.Minute || diff < -time.Minute {
		t.Errorf("expiresAt %v is not an hour away", expiresAt)
	}
	mock, _ := sent["mockResponse"].(map[string]any)
	if mock["delay"] != float64(250) || mock["status"] != float64(201) {
		t.Errorf("mockResponse sent as %v", mock)
	}
}

func TestUpdateSendsOnlySetFields(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("PATCH /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "ep_1", "slug": r.PathValue("slug")})
	})
	_, err := api.client().Endpoints.Update(context.Background(), "acme-test", webhookscc.UpdateEndpointOptions{
		Name:              webhookscc.Value("renamed"),
		MockResponse:      webhookscc.Null[webhookscc.MockResponse](),
		ShowEmailExtracts: webhookscc.Value(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, body := api.last()
	if want := `{"mockResponse":null,"name":"renamed","showEmailExtracts":false}`; body != want {
		t.Errorf("body = %s, want %s", body, want)
	}
}

func TestInvalidSlugsNeverReachTheAPI(t *testing.T) {
	client := newFakeAPI(t).client()
	for _, slug := range []string{"", "../admin", "a/b", "a?b"} {
		if _, err := client.Endpoints.Get(context.Background(), slug); err == nil {
			t.Errorf("Get(%q) succeeded", slug)
		}
	}
}

func TestErrorsMatchSentinels(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("slug") {
		case "unauthorized":
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		case "missing":
			http.Error(w, "Not found", http.StatusNotFound)
		case "limited":
			w.Header().Set("Retry-After", "7")
			w.Header().Set("X-RateLimit-Limit", "100")
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", "1767225660")
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
		case "html":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html></html>"))
		}
	})
	client := api.client()
	ctx := context.Background()
	if _, err := client.Endpoints.Get(ctx, "unauthorized"); !errors.Is(err, webhookscc.ErrUnauthorized) || !strings.Contains(err.Error(), "api-keys") {
		t.Errorf("401: %v", err)
	}
	if _, err := client.Endpoints.Get(ctx, "missing"); !errors.Is(err, webhookscc.ErrNotFound) {
		t.Errorf("404: %v", err)
	}
	_, err := client.Endpoints.Get(ctx, "limited")
	var apiErr *webhookscc.Error
	if !errors.Is(err, webhookscc.ErrRateLimited) || !errors.As(err, &apiErr) {
		t.Fatalf("429: %v", err)
	}
	if apiErr.RetryAfter != 7*time.Second || apiErr.RateLimit == nil || apiErr.RateLimit.Limit != 100 || apiErr.RateLimit.Reset != 1767225660 {
		t.Errorf("429 details: %+v %+v", apiErr, apiErr.RateLimit)
	}
	if _, err := client.Endpoints.Get(ctx, "html"); err == nil || !strings.Contains(err.Error(), "content type") {
		t.Errorf("html: %v", err)
	}
}

func TestRetriesServerErrors(t *testing.T) {
	api := newFakeAPI(t)
	var calls atomic.Int32
	api.handle("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, 200, map[string]any{"used": 1})
	})
	client := api.client(webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 3, Backoff: time.Millisecond}))
	if _, err := client.Usage(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Errorf("calls = %d", calls.Load())
	}
	calls.Store(0)
	if _, err := api.client().Usage(context.Background()); err == nil {
		t.Error("without retries a 503 should fail")
	}
}

func TestAPICallTimeout(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	_, err := api.client(webhookscc.WithTimeout(50 * time.Millisecond)).Usage(context.Background())
	var timeout *webhookscc.TimeoutError
	if !errors.Is(err, webhookscc.ErrTimeout) || !errors.As(err, &timeout) || timeout.After != 50*time.Millisecond {
		t.Errorf("err = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := api.client().Usage(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("canceled: %v", err)
	}
}

func TestListSendsFilters(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []any{requestJSON("r1", 1767225600000, nil)})
	})
	since := time.UnixMilli(1767225000000)
	requests, err := api.client().Requests.List(context.Background(), "acme-test", webhookscc.ListOptions{Limit: 5, Since: since, Kind: webhookscc.KindHTTP})
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0].ID != "r1" || requests[0].IP != "203.0.113.7" {
		t.Errorf("requests = %+v", requests)
	}
	request, _ := api.last()
	if got := request.URL.Query().Encode(); got != "extracts=true&kind=http&limit=5&since=1767225000000" {
		t.Errorf("query = %s", got)
	}
}

func TestWaitForPollsUntilAMatchArrives(t *testing.T) {
	api := newFakeAPI(t)
	var polls atomic.Int32
	now := time.Now().UnixMilli()
	api.handle("GET /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) {
		switch polls.Add(1) {
		case 1:
			writeJSON(w, 200, []any{})
		case 2:
			http.Error(w, "bad gateway", http.StatusBadGateway) // a server error does not end the wait
		default:
			writeJSON(w, 200, []any{
				requestJSON("late", now+2, map[string]any{"body": `{"type":"invoice.paid"}`}),
				requestJSON("other", now+1, map[string]any{"body": `{"type":"customer.created"}`}),
				requestJSON("early", now, map[string]any{"body": `{"type":"invoice.paid"}`}),
			})
		}
	})
	request, err := api.client().Requests.WaitFor(context.Background(), "acme-test", webhookscc.WaitOptions{
		Timeout:      5 * time.Second,
		PollInterval: 10 * time.Millisecond,
		Match:        webhookscc.MatchBodyPath("type", "invoice.paid"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.ID != "early" {
		t.Errorf("got %s, want the oldest match", request.ID)
	}
	all, err := api.client().Requests.WaitForAll(context.Background(), "acme-test", 2, webhookscc.WaitOptions{PollInterval: 10 * time.Millisecond, Match: webhookscc.MatchBodyPath("type", "invoice.paid")})
	if err != nil || len(all) != 2 || all[0].ID != "early" || all[1].ID != "late" {
		t.Errorf("WaitForAll = %v, %v", all, err)
	}
}

func TestWaitForTimesOutAndStopsOnClientErrors(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("slug") == "gone" {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		writeJSON(w, 200, []any{})
	})
	client := api.client()
	start := time.Now()
	_, err := client.Requests.WaitFor(context.Background(), "acme-test", webhookscc.WaitOptions{Timeout: 80 * time.Millisecond, PollInterval: 10 * time.Millisecond})
	if !errors.Is(err, webhookscc.ErrTimeout) {
		t.Errorf("err = %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("took %s", elapsed)
	}
	if _, err := client.Requests.WaitFor(context.Background(), "gone", webhookscc.WaitOptions{}); !errors.Is(err, webhookscc.ErrNotFound) {
		t.Errorf("404: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.Requests.WaitFor(ctx, "acme-test", webhookscc.WaitOptions{Timeout: time.Minute, PollInterval: 10 * time.Millisecond}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("context deadline: %v", err)
	}
}

func TestSendToNeverFollowsRedirects(t *testing.T) {
	var reachedOther atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reachedOther.Store(true) }))
	defer other.Close()
	api := newFakeAPI(t)
	api.handle("POST /hook", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/steal", http.StatusTemporaryRedirect)
	})
	// A client of the caller's own that would follow redirects.
	following := &http.Client{Timeout: 5 * time.Second}
	client := api.client(webhookscc.WithHTTPClient(following))
	response, err := client.SendTo(context.Background(), api.server.URL+"/hook", webhookscc.SendOptions{
		Body:    map[string]any{"event": "order.paid", "note": "<b>&</b>"},
		Headers: map[string]string{"X-Test": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusTemporaryRedirect || reachedOther.Load() {
		t.Errorf("status %d, followed: %v", response.StatusCode, reachedOther.Load())
	}
	if following.CheckRedirect != nil {
		t.Error("the caller's client was changed")
	}
	request, body := api.last()
	if body != `{"event":"order.paid","note":"<b>&</b>"}` || request.Header.Get("Content-Type") != "application/json" || request.Header.Get("X-Test") != "1" {
		t.Errorf("sent %s with %v", body, request.Header)
	}
}

func TestBuildRequestChecksItsInput(t *testing.T) {
	if _, err := webhookscc.BuildRequest("ftp://example.com", webhookscc.SendOptions{}); err == nil {
		t.Error("an ftp URL should fail")
	}
	if _, err := webhookscc.BuildRequest("https://example.com", webhookscc.SendOptions{Method: "TRACE"}); err == nil {
		t.Error("TRACE should fail")
	}
	if _, err := webhookscc.BuildRequest("https://example.com", webhookscc.SendOptions{Provider: "stripe"}); err == nil {
		t.Error("stripe without a secret should fail")
	}
	built, err := webhookscc.BuildRequest("https://example.com/hook", webhookscc.SendOptions{Method: "put", Body: "raw text", Headers: map[string]string{"content-type": "text/plain"}})
	if err != nil {
		t.Fatal(err)
	}
	if built.Method != "PUT" || string(built.Body) != "raw text" || len(built.Headers) != 1 {
		t.Errorf("built = %+v", built)
	}
	signed, err := webhookscc.BuildRequest("https://example.com/hook", webhookscc.SendOptions{
		Provider: "stripe", Secret: "whsec_test", Body: `{"id":"evt_1"}`, Timestamp: time.Unix(1767225600, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(signed.Headers["stripe-signature"], "t=1767225600,v1=") || string(signed.Body) != `{"id":"evt_1"}` {
		t.Errorf("signed = %+v", signed)
	}
	if info, ok := webhookscc.TemplateProvider("stripe"); !ok || !info.SecretRequired || info.SignatureHeader != "stripe-signature" {
		t.Errorf("stripe info = %+v", info)
	}
	if len(webhookscc.TemplateProviders()) < 30 {
		t.Errorf("only %d template providers", len(webhookscc.TemplateProviders()))
	}
}

func TestEndpointSendSignsForProviders(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /w/{slug}", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	response, err := api.client().Endpoints.Send(context.Background(), "acme-test", webhookscc.SendOptions{Provider: "github", Secret: "s3cret", Template: "push"})
	if err != nil {
		t.Fatal(err)
	}
	request, body := api.last()
	if response.StatusCode != 204 || request.URL.Path != "/w/acme-test" || !strings.HasPrefix(request.Header.Get("X-Hub-Signature-256"), "sha256=") || body == "" {
		t.Errorf("sent %s %s %v", request.URL.Path, body, request.Header)
	}
}

func TestReplay(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/requests/{id}", func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("id") {
		case "binary":
			writeJSON(w, 200, requestJSON("binary", 1, map[string]any{
				"method": "PUT", "body": "�", "bodyRaw": "/w==",
				"headers": map[string]string{"Content-Type": "application/octet-stream", "Authorization": "Bearer x", "X-Forwarded-For": "1.2.3.4", "X-Keep": "yes"},
			}))
		case "get":
			writeJSON(w, 200, requestJSON("get", 1, map[string]any{"method": "GET", "body": "ignored"}))
		case "email":
			writeJSON(w, 200, requestJSON("email", 1, map[string]any{"method": "EMAIL", "kind": "email", "path": "a@mailhooks.cc"}))
		}
	})
	var got struct {
		method string
		body   []byte
		header http.Header
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method = r.Method
		got.body, _ = io.ReadAll(r.Body)
		got.header = r.Header
	}))
	defer target.Close()
	client := api.client()
	if _, err := client.Requests.Replay(context.Background(), "binary", target.URL); err != nil {
		t.Fatal(err)
	}
	if got.method != "PUT" || string(got.body) != "\xff" || got.header.Get("Authorization") != "" || got.header.Get("X-Forwarded-For") != "" || got.header.Get("X-Keep") != "yes" {
		t.Errorf("replayed %s %q %v", got.method, got.body, got.header)
	}
	if _, err := client.Requests.Replay(context.Background(), "get", target.URL); err != nil || got.method != "GET" || len(got.body) != 0 {
		t.Errorf("GET replay: %v %q", err, got.body)
	}
	if _, err := client.Requests.Replay(context.Background(), "email", target.URL); err == nil {
		t.Error("an email should not replay")
	}
}

func TestSearchCountClear(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/search/requests", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, []any{}) })
	api.handle("GET /api/search/requests/count", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]int{"count": 3}) })
	api.handle("DELETE /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	client := api.client()
	ctx := context.Background()
	from := time.UnixMilli(1767225000000)
	if _, err := client.Requests.Search(ctx, webhookscc.SearchOptions{Slug: "acme-test", Query: "invoice", From: from, Limit: 10, Order: "asc"}); err != nil {
		t.Fatal(err)
	}
	request, _ := api.last()
	if got := request.URL.Query().Encode(); got != "from=1767225000000&limit=10&order=asc&q=invoice&slug=acme-test" {
		t.Errorf("search query = %s", got)
	}
	if count, err := client.Requests.Count(ctx, webhookscc.SearchOptions{Kind: webhookscc.KindEmail}); err != nil || count != 3 {
		t.Errorf("count = %d, %v", count, err)
	}
	if err := client.Requests.Clear(ctx, "acme-test", webhookscc.ClearOptions{Before: from}); err != nil {
		t.Fatal(err)
	}
	request, _ = api.last()
	if request.URL.RawQuery != "before=1767225000000" {
		t.Errorf("clear query = %s", request.URL.RawQuery)
	}
}

func TestCaptureDuringDeletesTheEndpoint(t *testing.T) {
	api := newFakeAPI(t)
	var deleted atomic.Bool
	api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "ep_1", "slug": "tmp-1", "url": api.server.URL + "/w/tmp-1"})
	})
	api.handle("DELETE /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		deleted.Store(r.PathValue("slug") == "tmp-1")
		w.WriteHeader(204)
	})
	var sent atomic.Bool
	api.handle("GET /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) {
		if !sent.Load() {
			writeJSON(w, 200, []any{})
			return
		}
		writeJSON(w, 200, []any{requestJSON("r1", time.Now().UnixMilli(), nil)})
	})
	requests, err := api.client().CaptureDuring(context.Background(), func(endpoint *webhookscc.Endpoint) error {
		sent.Store(true)
		return nil
	}, webhookscc.CaptureOptions{PollInterval: 10 * time.Millisecond, Timeout: 5 * time.Second})
	if err != nil || len(requests) != 1 || requests[0].ID != "r1" {
		t.Fatalf("CaptureDuring = %v, %v", requests, err)
	}
	if !deleted.Load() {
		t.Error("the endpoint was not deleted")
	}
	deleted.Store(false)
	failure := fmt.Errorf("action failed")
	if _, err := api.client().CaptureDuring(context.Background(), func(*webhookscc.Endpoint) error { return failure }, webhookscc.CaptureOptions{}); !errors.Is(err, failure) {
		t.Errorf("err = %v", err)
	}
	if !deleted.Load() {
		t.Error("the endpoint was not deleted after a failed action")
	}
}

// A client whose clock runs ahead of the server's must not skip requests that
// arrive between two polls.
func TestWaitForToleratesAClientClockAhead(t *testing.T) {
	api := newFakeAPI(t)
	serverNow := time.Now().Add(-2 * time.Minute).UnixMilli() // the server is two minutes behind
	var mu sync.Mutex
	stored := []map[string]any{requestJSON("earlier", serverNow, map[string]any{"body": `{"type":"other"}`})}
	var polls atomic.Int32
	api.handle("GET /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		mu.Lock()
		defer mu.Unlock()
		if polls.Add(1) == 2 {
			// Arrives just after the first poll, on the server's clock.
			stored = append(stored, requestJSON("late", serverNow+1000, map[string]any{"body": `{"type":"invoice.paid"}`}))
		}
		var out []any
		for _, request := range stored {
			if request["receivedAt"].(int64) >= since { // the route's filter
				out = append(out, request)
			}
		}
		writeJSON(w, http.StatusOK, out)
	})
	request, err := api.client().Requests.WaitFor(context.Background(), "acme-test", webhookscc.WaitOptions{
		Timeout: 3 * time.Second, PollInterval: 10 * time.Millisecond, Match: webhookscc.MatchBodyPath("type", "invoice.paid"),
	})
	if err != nil || request.ID != "late" {
		t.Fatalf("WaitFor = %v, %v", request, err)
	}
}
