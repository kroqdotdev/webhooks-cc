package webhookscc_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
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
	// No connected agent either, whatever this machine's own file holds.
	t.Setenv(webhookscc.AgentFileEnv, filepath.Join(t.TempDir(), "agent.json"))
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

func TestUpdateSetsAndClearsTheAgentRepo(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("PATCH /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "ep_1", "slug": r.PathValue("slug"), "agentRepo": "acme/api"})
	})
	client := api.client()
	endpoint, err := client.Endpoints.Update(context.Background(), "acme-test", webhookscc.UpdateEndpointOptions{
		AgentRepo: webhookscc.Value("acme/api"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.AgentRepo != "acme/api" {
		t.Errorf("AgentRepo = %q", endpoint.AgentRepo)
	}
	if _, body := api.last(); body != `{"agentRepo":"acme/api"}` {
		t.Errorf("body = %s", body)
	}
	if _, err := client.Endpoints.Update(context.Background(), "acme-test", webhookscc.UpdateEndpointOptions{
		AgentRepo: webhookscc.Null[string](),
	}); err != nil {
		t.Fatal(err)
	}
	if _, body := api.last(); body != `{"agentRepo":null}` {
		t.Errorf("body = %s", body)
	}
	// Read as the API reads it: trimmed, ".git" dropped, "" clears.
	for in, want := range map[string]string{
		" acme/api ":   `{"agentRepo":"acme/api"}`,
		"acme/api.git": `{"agentRepo":"acme/api"}`,
		"":             `{"agentRepo":null}`,
		"  ":           `{"agentRepo":null}`,
	} {
		if _, err := client.Endpoints.Update(context.Background(), "acme-test", webhookscc.UpdateEndpointOptions{
			AgentRepo: webhookscc.Value(in),
		}); err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if _, body := api.last(); body != want {
			t.Errorf("%q: body = %s", in, body)
		}
	}
	for _, bad := range []string{"acme", "https://github.com/acme/api", "-acme/api", "acme/..", "acme/.git", "acme/api.", "acme/api.git.git", strings.Repeat("a", 40) + "/b"} {
		if _, err := client.Endpoints.Update(context.Background(), "acme-test", webhookscc.UpdateEndpointOptions{
			AgentRepo: webhookscc.Value(bad),
		}); err == nil || !strings.Contains(err.Error(), "AgentRepo") {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
}

func TestListAndGetReadFavorites(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"owned":  []map[string]any{{"id": "ep_1", "slug": "acme-own", "favorite": true}, {"id": "ep_2", "slug": "acme-plain", "favorite": false}},
			"shared": []map[string]any{{"id": "ep_3", "slug": "acme-team", "favorite": true}},
		})
	})
	api.handle("GET /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "ep_3", "slug": r.PathValue("slug"), "favorite": true})
	})
	client := api.client()
	endpoints, err := client.Endpoints.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var favorites []string
	for _, endpoint := range endpoints {
		if endpoint.Favorite {
			favorites = append(favorites, endpoint.Slug)
		}
	}
	if strings.Join(favorites, ",") != "acme-own,acme-team" {
		t.Errorf("favorites = %v", favorites)
	}
	endpoint, err := client.Endpoints.Get(context.Background(), "acme-team")
	if err != nil {
		t.Fatal(err)
	}
	if !endpoint.Favorite {
		t.Errorf("endpoint = %+v", endpoint)
	}
}

func TestFavoriteAndUnfavorite(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("PUT /api/endpoints/{slug}/favorite", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("slug") == "missing" {
			writeJSON(w, 404, map[string]any{"error": "Endpoint not found"})
			return
		}
		writeJSON(w, 200, map[string]any{"favorite": true})
	})
	api.handle("DELETE /api/endpoints/{slug}/favorite", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"favorite": false})
	})
	client := api.client()
	ctx := context.Background()
	if favorite, err := client.Endpoints.Favorite(ctx, "acme-test"); err != nil || !favorite {
		t.Fatalf("Favorite = %v, %v", favorite, err)
	}
	request, body := api.last()
	if request.Method != http.MethodPut || request.URL.Path != "/api/endpoints/acme-test/favorite" || body != "" {
		t.Errorf("sent %s %s %q", request.Method, request.URL.Path, body)
	}
	if favorite, err := client.Endpoints.Unfavorite(ctx, "acme-test"); err != nil || favorite {
		t.Fatalf("Unfavorite = %v, %v", favorite, err)
	}
	request, body = api.last()
	if request.Method != http.MethodDelete || request.URL.Path != "/api/endpoints/acme-test/favorite" || body != "" {
		t.Errorf("sent %s %s %q", request.Method, request.URL.Path, body)
	}
	_, err := client.Endpoints.Favorite(ctx, "missing")
	if !errors.Is(err, webhookscc.ErrNotFound) || !strings.Contains(err.Error(), "Endpoint not found") {
		t.Errorf("404: %v", err)
	}
}

func TestFavoriteRefusedWithoutAnAccount(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("PUT /api/endpoints/{slug}/favorite", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 403, map[string]any{"error": "This needs an account"})
	})
	_, err := api.client().Endpoints.Favorite(context.Background(), "acme-test")
	var apiErr *webhookscc.Error
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusForbidden {
		t.Errorf("403: %v", err)
	}
}

func TestPreviewResponseSendsOnlyGivenSettings(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/endpoints/{slug}/responses/preview", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"rule":                map[string]any{"index": 1, "name": "pings"},
			"response":            map[string]any{"status": 202, "headers": map[string]string{"x-id": "evt_1"}, "body": `{"id":"evt_1"}`, "delay": 250},
			"unknownPlaceholders": []string{"json.nope"},
			"email":               false,
			"request": map[string]any{
				"id": "4f0e7c1a-0000-4000-8000-000000000002", "method": "POST", "path": "/hooks",
				"receivedAt": 1767225600000, "sample": false,
			},
		})
	})
	client := api.client()
	ctx := context.Background()

	preview, err := client.Endpoints.PreviewResponse(ctx, "acme-test", webhookscc.PreviewResponseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	request, body := api.last()
	if request.URL.Path != "/api/endpoints/acme-test/responses/preview" || body != "{}" {
		t.Errorf("sent %s %s", request.URL.Path, body)
	}
	if preview.Rule == nil || preview.Rule.Index != 1 || preview.Rule.Name != "pings" {
		t.Errorf("rule = %+v", preview.Rule)
	}
	if preview.Response == nil || preview.Response.Status != 202 || preview.Response.Body != `{"id":"evt_1"}` ||
		preview.Response.Headers["x-id"] != "evt_1" || preview.Response.Delay != 250*time.Millisecond {
		t.Errorf("response = %+v", preview.Response)
	}
	if len(preview.UnknownPlaceholders) != 1 || preview.UnknownPlaceholders[0] != "json.nope" || preview.Email {
		t.Errorf("preview = %+v", preview)
	}
	if preview.Request.ID != "4f0e7c1a-0000-4000-8000-000000000002" || preview.Request.Path != "/hooks" ||
		preview.Request.ReceivedAt.UnixMilli() != 1767225600000 || preview.Request.Sample {
		t.Errorf("request = %+v", preview.Request)
	}

	_, err = client.Endpoints.PreviewResponse(ctx, "acme-test", webhookscc.PreviewResponseOptions{
		RequestID:    "4f0e7c1a-0000-4000-8000-000000000002",
		MockResponse: webhookscc.Null[webhookscc.MockResponse](),
		ResponseRules: webhookscc.Value([]webhookscc.ResponseRule{{
			Conditions: []webhookscc.ResponseRuleCondition{{Field: "size", Op: "gt", Value: "1024"}},
			Response:   webhookscc.MockResponse{Status: 413},
		}}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, body = api.last()
	want := `{"mockResponse":null,"requestId":"4f0e7c1a-0000-4000-8000-000000000002",` +
		`"responseRules":[{"conditions":[{"field":"size","op":"gt","value":"1024"}],"response":{"status":413,"body":"","headers":{}}}]}`
	if body != want {
		t.Errorf("body = %s, want %s", body, want)
	}

	if _, err := client.Endpoints.PreviewResponse(ctx, "acme-test", webhookscc.PreviewResponseOptions{
		ResponseRules: webhookscc.Null[[]webhookscc.ResponseRule](),
	}); err != nil {
		t.Fatal(err)
	}
	if _, body = api.last(); body != `{"responseRules":null}` {
		t.Errorf("body = %s", body)
	}

	if _, err := client.Endpoints.PreviewResponse(ctx, "../admin", webhookscc.PreviewResponseOptions{}); err == nil {
		t.Error("an invalid slug reached the API")
	}
}

func TestPreviewResponseReadsASampleAndThePlain200(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/endpoints/{slug}/responses/preview", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"rule": nil, "response": nil, "unknownPlaceholders": []string{}, "email": false,
			"request": map[string]any{"id": nil, "method": "POST", "path": "/", "receivedAt": 1, "sample": true},
		})
	})
	preview, err := api.client().Endpoints.PreviewResponse(context.Background(), "acme-test", webhookscc.PreviewResponseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if preview.Rule != nil || preview.Response != nil || preview.Request.ID != "" || !preview.Request.Sample {
		t.Errorf("preview = %+v", preview)
	}
}

func TestInvalidSlugsNeverReachTheAPI(t *testing.T) {
	client := newFakeAPI(t).client()
	for _, slug := range []string{"", "../admin", "a/b", "a?b"} {
		if _, err := client.Endpoints.Get(context.Background(), slug); err == nil {
			t.Errorf("Get(%q) succeeded", slug)
		}
		if _, err := client.Endpoints.Favorite(context.Background(), slug); err == nil {
			t.Errorf("Favorite(%q) succeeded", slug)
		}
		if _, err := client.Endpoints.Unfavorite(context.Background(), slug); err == nil {
			t.Errorf("Unfavorite(%q) succeeded", slug)
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

// A POST that failed with a 5xx, a dropped connection or a timeout may have
// gone through, so it is not repeated; a GET is.
func TestRetriesRepeatOnlyWhatIsSafeToRepeat(t *testing.T) {
	failures := map[string]http.HandlerFunc{
		"5xx": func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		},
		"dropped connection": func(w http.ResponseWriter, r *http.Request) {
			if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
				conn.Close()
			}
		},
		"timeout": func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() },
	}
	for name, fail := range failures {
		t.Run(name, func(t *testing.T) {
			api := newFakeAPI(t)
			var posts, gets atomic.Int32
			api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
				posts.Add(1)
				fail(w, r)
			})
			api.handle("GET /api/endpoints/acme", func(w http.ResponseWriter, r *http.Request) {
				if gets.Add(1) == 1 {
					fail(w, r)
					return
				}
				writeJSON(w, 200, map[string]any{"id": "e1", "slug": "acme"})
			})
			client := api.client(
				webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 3, Backoff: time.Millisecond}),
				webhookscc.WithTimeout(200*time.Millisecond),
			)
			if _, err := client.Endpoints.Create(context.Background(), webhookscc.CreateEndpointOptions{Name: "acme"}); err == nil {
				t.Error("Create should fail")
			}
			if posts.Load() != 1 {
				t.Errorf("POST sent %d times", posts.Load())
			}
			if _, err := client.Endpoints.Get(context.Background(), "acme"); err != nil {
				t.Errorf("Get: %v", err)
			}
			if gets.Load() != 2 {
				t.Errorf("GET sent %d times", gets.Load())
			}
		})
	}
}

func TestRetriesRepeatAPostAfterA429(t *testing.T) {
	api := newFakeAPI(t)
	var posts atomic.Int32
	api.handle("POST /api/endpoints", func(w http.ResponseWriter, r *http.Request) {
		if posts.Add(1) == 1 {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		writeJSON(w, 200, map[string]any{"id": "e1", "slug": "acme"})
	})
	client := api.client(webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 2, Backoff: time.Millisecond}))
	if _, err := client.Endpoints.Create(context.Background(), webhookscc.CreateEndpointOptions{}); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 2 {
		t.Errorf("POST sent %d times", posts.Load())
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
	api.handle("GET /api/search/requests", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Search-Complete", "true")
		writeJSON(w, 200, []any{})
	})
	api.handle("GET /api/search/requests/count", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"count": 3, "exact": true, "searchedUntil": nil, "cursor": nil})
	})
	api.handle("DELETE /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	client := api.client()
	ctx := context.Background()
	from := time.UnixMilli(1767225000000)
	if _, err := client.Requests.Search(ctx, webhookscc.SearchOptions{Slug: "acme-test", Query: "invoice", From: from, Limit: 10, Order: "asc"}); err != nil {
		t.Fatal(err)
	}
	request, _ := api.last()
	if got := request.URL.Query().Encode(); got != "from=1767225000000&limit=10&order=asc&paged=true&q=invoice&slug=acme-test" {
		t.Errorf("search query = %s", got)
	}
	if count, err := client.Requests.Count(ctx, webhookscc.SearchOptions{Kind: webhookscc.KindEmail}); err != nil || count != 3 {
		t.Errorf("count = %d, %v", count, err)
	}
	request, _ = api.last()
	if got := request.URL.RawQuery; got != "kind=email&paged=true" {
		t.Errorf("count query = %s", got)
	}
	if err := client.Requests.Clear(ctx, "acme-test", webhookscc.ClearOptions{Before: from}); err != nil {
		t.Fatal(err)
	}
	request, _ = api.last()
	if request.URL.RawQuery != "before=1767225000000" {
		t.Errorf("clear query = %s", request.URL.RawQuery)
	}
}

// searchPages answers a search with one scripted page per call and records
// each call's query.
type searchPages struct {
	mu      sync.Mutex
	queries []string
}

type scriptedPage struct {
	ids      []string
	complete bool
	cursor   string
	until    int64
}

func (p *searchPages) serve(api *fakeAPI, pages ...scriptedPage) {
	api.handle("GET /api/search/requests", func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.queries = append(p.queries, r.URL.Query().Encode())
		page := pages[min(len(p.queries), len(pages))-1]
		p.mu.Unlock()
		w.Header().Set("X-Search-Complete", strconv.FormatBool(page.complete))
		if page.cursor != "" {
			w.Header().Set("X-Search-Cursor", page.cursor)
		}
		if page.until != 0 {
			w.Header().Set("X-Search-Searched-Until", strconv.FormatInt(page.until, 10))
		}
		requests := []any{}
		for _, id := range page.ids {
			requests = append(requests, requestJSON(id, 1767225000000, map[string]any{"slug": "acme-test"}))
		}
		writeJSON(w, 200, requests)
	})
}

func requestIDs(requests []webhookscc.Request) string {
	ids := make([]string, len(requests))
	for i, request := range requests {
		ids[i] = request.ID
	}
	return strings.Join(ids, ",")
}

func TestSearchPageReadsOnePageAndItsProgress(t *testing.T) {
	api := newFakeAPI(t)
	var pages searchPages
	pages.serve(api, scriptedPage{ids: []string{"r1", "r2"}, cursor: "c1.mac", until: 1767225000000})
	client := api.client()
	ctx := context.Background()
	opts := webhookscc.SearchOptions{Query: "invoice", Limit: 20, Offset: 5, Order: "asc"}
	page, err := client.Requests.SearchPage(ctx, opts, "")
	if err != nil {
		t.Fatal(err)
	}
	if requestIDs(page.Requests) != "r1,r2" || page.Requests[0].Slug != "acme-test" {
		t.Errorf("requests = %+v", page.Requests)
	}
	if page.Complete || page.Cursor != "c1.mac" || !page.SearchedUntil.Equal(time.UnixMilli(1767225000000)) {
		t.Errorf("progress = %v %q %v", page.Complete, page.Cursor, page.SearchedUntil)
	}
	// With a cursor, the offset is the cursor's to carry.
	if _, err := client.Requests.SearchPage(ctx, opts, page.Cursor); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"limit=20&offset=5&order=asc&paged=true&q=invoice",
		"cursor=c1.mac&limit=20&order=asc&paged=true&q=invoice",
	}
	if !slices.Equal(pages.queries, want) {
		t.Errorf("queries = %q", pages.queries)
	}
}

func TestSearchPageReadsTheProgressHeaders(t *testing.T) {
	cases := []struct {
		headers  map[string]string
		complete bool
		until    int64
		cursor   string
	}{
		{map[string]string{"X-Search-Complete": "true"}, true, 0, ""},
		{map[string]string{"X-Search-Complete": "false", "X-Search-Cursor": "c"}, false, 0, "c"},
		{map[string]string{"X-Search-Complete": "TRUE", "X-Search-Searched-Until": "1767225600000"}, true, 1767225600000, ""},
		{map[string]string{"X-Search-Complete": "false", "X-Search-Searched-Until": "soon"}, false, 0, ""},
		// A server from before the cursor sends no progress: that answer is all there is.
		{nil, true, 0, ""},
	}
	for _, c := range cases {
		api := newFakeAPI(t)
		api.handle("GET /api/search/requests", func(w http.ResponseWriter, r *http.Request) {
			for name, value := range c.headers {
				w.Header().Set(name, value)
			}
			writeJSON(w, 200, []any{})
		})
		page, err := api.client().Requests.SearchPage(context.Background(), webhookscc.SearchOptions{Query: "x"}, "")
		if err != nil {
			t.Fatal(err)
		}
		if page.Complete != c.complete || page.Cursor != c.cursor || len(page.Requests) != 0 {
			t.Errorf("%v: page = %+v", c.headers, page)
		}
		if c.until == 0 && !page.SearchedUntil.IsZero() || c.until != 0 && page.SearchedUntil.UnixMilli() != c.until {
			t.Errorf("%v: searched until %v", c.headers, page.SearchedUntil)
		}
	}
}

func TestSearchFollowsTheCursorUntilItHasTheLimit(t *testing.T) {
	api := newFakeAPI(t)
	var pages searchPages
	pages.serve(api,
		scriptedPage{ids: []string{"r1", "r2"}, cursor: "c1"},
		scriptedPage{cursor: "c2"},
		scriptedPage{ids: []string{"r3", "r4", "r5"}, cursor: "c3"},
	)
	found, err := api.client().Requests.Search(context.Background(), webhookscc.SearchOptions{Query: "invoice", Limit: 4, Offset: 10})
	if err != nil {
		t.Fatal(err)
	}
	if requestIDs(found) != "r1,r2,r3,r4" {
		t.Errorf("found %s", requestIDs(found))
	}
	want := []string{
		"limit=4&offset=10&paged=true&q=invoice",
		"cursor=c1&limit=2&paged=true&q=invoice",
		"cursor=c2&limit=2&paged=true&q=invoice",
	}
	if !slices.Equal(pages.queries, want) {
		t.Errorf("queries = %q", pages.queries)
	}
}

func TestSearchStopsWhenTheSearchIsComplete(t *testing.T) {
	api := newFakeAPI(t)
	var pages searchPages
	pages.serve(api, scriptedPage{ids: []string{"r1"}, cursor: "c1"}, scriptedPage{ids: []string{"r2"}, complete: true})
	found, err := api.client().Requests.Search(context.Background(), webhookscc.SearchOptions{Slug: "acme-test"})
	if err != nil || requestIDs(found) != "r1,r2" {
		t.Errorf("found %s, %v", requestIDs(found), err)
	}
	// The default limit is the server's on the first page, and what is left of 50 after.
	want := []string{"paged=true&slug=acme-test", "cursor=c1&limit=49&paged=true&slug=acme-test"}
	if !slices.Equal(pages.queries, want) {
		t.Errorf("queries = %q", pages.queries)
	}
}

func TestCountAddsUpTheStretches(t *testing.T) {
	api := newFakeAPI(t)
	answers := []map[string]any{
		{"count": 3, "exact": false, "searchedUntil": 1767225002000, "cursor": "c1"},
		{"count": 0, "exact": false, "searchedUntil": 1767225001000, "cursor": "c2"},
		{"count": 4, "exact": true, "searchedUntil": nil, "cursor": nil},
	}
	var mu sync.Mutex
	var queries []string
	api.handle("GET /api/search/requests/count", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries = append(queries, r.URL.Query().Encode())
		answer := answers[min(len(queries), len(answers))-1]
		mu.Unlock()
		writeJSON(w, 200, answer)
	})
	client := api.client()
	ctx := context.Background()
	opts := webhookscc.SearchOptions{Query: "invoice", Kind: webhookscc.KindEmail}
	if count, err := client.Requests.Count(ctx, opts); err != nil || count != 7 {
		t.Errorf("count = %d, %v", count, err)
	}
	want := []string{
		"kind=email&paged=true&q=invoice",
		"cursor=c1&kind=email&paged=true&q=invoice",
		"cursor=c2&kind=email&paged=true&q=invoice",
	}
	if !slices.Equal(queries, want) {
		t.Errorf("queries = %q", queries)
	}

	queries = nil
	first, err := client.Requests.CountPage(ctx, opts, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.Count != 3 || first.Exact || first.Cursor != "c1" || first.SearchedUntil.UnixMilli() != 1767225002000 {
		t.Errorf("first count page = %+v", first)
	}
	if _, err := client.Requests.CountPage(ctx, opts, "c1"); err != nil {
		t.Fatal(err)
	}
	last, err := client.Requests.CountPage(ctx, opts, "c2")
	if err != nil {
		t.Fatal(err)
	}
	if last.Count != 4 || !last.Exact || last.Cursor != "" || !last.SearchedUntil.IsZero() {
		t.Errorf("last count page = %+v", last)
	}
}

func TestCountPageReadsAnAnswerFromBeforeTheCursor(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/search/requests/count", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]int{"count": 3}) })
	page, err := api.client().Requests.CountPage(context.Background(), webhookscc.SearchOptions{}, "")
	if err != nil || page.Count != 3 || !page.Exact {
		t.Errorf("page = %+v, %v", page, err)
	}
}

func TestAnInvalidCursorHasItsOwnError(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/search/requests", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") != "" {
			writeJSON(w, 400, map[string]string{"error": "invalid_cursor"})
			return
		}
		writeJSON(w, 400, map[string]string{"error": "invalid_q"})
	})
	api.handle("GET /api/search/requests/count", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 400, map[string]string{"error": "invalid_cursor"})
	})
	client := api.client()
	ctx := context.Background()
	_, err := client.Requests.SearchPage(ctx, webhookscc.SearchOptions{Query: "x"}, "tampered")
	var apiErr *webhookscc.Error
	if !errors.Is(err, webhookscc.ErrInvalidCursor) || !errors.As(err, &apiErr) || apiErr.StatusCode != 400 {
		t.Errorf("search page: %v", err)
	}
	if _, err := client.Requests.CountPage(ctx, webhookscc.SearchOptions{Query: "x"}, "tampered"); !errors.Is(err, webhookscc.ErrInvalidCursor) {
		t.Errorf("count page: %v", err)
	}
	// Another 400 is not an invalid cursor.
	if _, err := client.Requests.SearchPage(ctx, webhookscc.SearchOptions{Query: "x"}, ""); err == nil || errors.Is(err, webhookscc.ErrInvalidCursor) || !strings.Contains(err.Error(), "invalid_q") {
		t.Errorf("another 400: %v", err)
	}
}

func TestABusySearchIsRetriedAfterRetryAfter(t *testing.T) {
	api := newFakeAPI(t)
	var calls atomic.Int32
	api.handle("GET /api/search/requests", func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, 429, map[string]string{"error": "search_busy"})
			return
		}
		w.Header().Set("X-Search-Complete", "true")
		writeJSON(w, 200, []any{requestJSON("r1", 1767225000000, nil)})
	})
	ctx := context.Background()
	started := time.Now()
	client := api.client(webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 2, Backoff: time.Millisecond}))
	found, err := client.Requests.Search(ctx, webhookscc.SearchOptions{Query: "x"})
	if err != nil || requestIDs(found) != "r1" {
		t.Fatalf("found %s, %v", requestIDs(found), err)
	}
	if waited := time.Since(started); waited < time.Second {
		t.Errorf("retried after %s, before the second Retry-After asked for", waited)
	}
	// Without retries it is the rate-limit error, with the wait the server asked for.
	calls.Store(0)
	_, err = api.client().Requests.SearchPage(ctx, webhookscc.SearchOptions{Query: "x"}, "")
	var apiErr *webhookscc.Error
	if !errors.Is(err, webhookscc.ErrRateLimited) || !errors.As(err, &apiErr) || apiErr.RetryAfter != time.Second {
		t.Errorf("busy without retries: %v", err)
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
func TestWaitForKeepsPollingAfterAPollTimesOut(t *testing.T) {
	api := newFakeAPI(t)
	var polls atomic.Int32
	api.handle("GET /api/endpoints/acme/requests", func(w http.ResponseWriter, r *http.Request) {
		if polls.Add(1) == 1 {
			<-r.Context().Done()
			return
		}
		writeJSON(w, 200, []map[string]any{requestJSON("r1", time.Now().UnixMilli(), nil)})
	})
	client := api.client(webhookscc.WithTimeout(50 * time.Millisecond))
	request, err := client.Requests.WaitFor(context.Background(), "acme", webhookscc.WaitOptions{
		Timeout:      2 * time.Second,
		PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.ID != "r1" || polls.Load() != 2 {
		t.Errorf("request %q after %d polls", request.ID, polls.Load())
	}
}

// Without Before the server clears up to its own clock: a repeat would delete
// what arrived after a clear that went through.
func TestClearIsRepeatedOnlyWithABeforeTime(t *testing.T) {
	for _, tc := range []struct {
		name   string
		before time.Time
		sent   int32
	}{
		{"without before", time.Time{}, 1},
		{"with before", time.UnixMilli(1000), 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newFakeAPI(t)
			var calls atomic.Int32
			api.handle("DELETE /api/endpoints/acme/requests", func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					http.Error(w, "unavailable", http.StatusServiceUnavailable)
					return
				}
				writeJSON(w, 200, map[string]any{"deleted": 1, "complete": true})
			})
			client := api.client(webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 2, Backoff: time.Millisecond}))
			err := client.Requests.Clear(context.Background(), "acme", webhookscc.ClearOptions{Before: tc.before})
			if (err == nil) != (tc.sent == 2) {
				t.Errorf("err = %v", err)
			}
			if calls.Load() != tc.sent {
				t.Errorf("DELETE sent %d times", calls.Load())
			}
		})
	}
}

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

func TestUpdateRefusesNullForSettingsThatAlwaysHaveAValue(t *testing.T) {
	client := newFakeAPI(t).client()
	_, err := client.Endpoints.Update(context.Background(), "acme-test", webhookscc.UpdateEndpointOptions{ForwardEnabled: webhookscc.Null[bool]()})
	if err == nil || !strings.Contains(err.Error(), "cannot be cleared") {
		t.Errorf("err = %v", err)
	}
}

func TestUsageReadsTheOtherAllowances(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"used": 0, "limit": 50, "remaining": 50, "plan": "free", "periodEnd": nil,
			"parsedPages": map[string]any{
				"used": 3, "limit": 20, "creditPages": 0,
				"overage":  map[string]any{"active": false, "used": 0, "max": 0},
				"resetsAt": "2026-11-29T09:30:00.123Z",
			},
			"previewData": map[string]any{
				"bytes": 1024, "limitBytes": 1073741824, "over": false,
				"resetsAt": "2026-12-01T00:00:00.000Z",
			},
			"aiAssists": nil,
		})
	})
	usage, err := api.client().Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	resets := time.Date(2026, 11, 29, 9, 30, 0, 123_000_000, time.UTC)
	if p := usage.ParsedPages; p == nil || p.Used != 3 || p.Limit != 20 || !p.ResetsAt.Equal(resets) {
		t.Errorf("ParsedPages = %+v", usage.ParsedPages)
	}
	want := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	if p := usage.PreviewData; p == nil || p.LimitBytes != 1073741824 || !p.ResetsAt.Equal(want) {
		t.Errorf("PreviewData = %+v", usage.PreviewData)
	}
	if usage.AIAssists != nil {
		t.Errorf("AIAssists = %+v, want nil", usage.AIAssists)
	}

	// Written and read back, it is the same usage.
	written, err := json.Marshal(usage)
	if err != nil {
		t.Fatal(err)
	}
	var again webhookscc.Usage
	if err := json.Unmarshal(written, &again); err != nil {
		t.Fatal(err)
	}
	if *again.ParsedPages != *usage.ParsedPages || *again.PreviewData != *usage.PreviewData || again.AIAssists != nil {
		t.Errorf("round trip = %s", written)
	}
}
