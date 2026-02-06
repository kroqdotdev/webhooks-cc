package tunnel

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"webhooks.cc/shared/types"
)

func TestForward_SensitiveHeadersStripped(t *testing.T) {
	var receivedHeaders http.Header
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		w.WriteHeader(200)
	}))
	t.Cleanup(target.Close)

	tun := New("test-slug", target.URL)

	req := &types.CapturedRequest{
		Method: "POST",
		Path:   "/webhook",
		Headers: map[string]string{
			"Content-Type":        "application/json",
			"Authorization":       "Bearer secret-token",
			"Cookie":              "session=abc123",
			"Set-Cookie":          "other=value",
			"X-Api-Key":           "api-key-123",
			"Proxy-Authorization": "Basic creds",
			"X-Auth-Token":        "auth-tok",
			"X-Access-Token":      "access-tok",
			"X-Custom-Header":     "safe-value",
		},
		Body: `{"test": true}`,
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if !result.Success {
		t.Fatalf("Forward failed: %s", result.Error)
	}

	// Sensitive headers should not be forwarded
	sensitiveList := []string{
		"Authorization", "Cookie", "Set-Cookie",
		"X-Api-Key", "Proxy-Authorization", "X-Auth-Token", "X-Access-Token",
	}
	for _, h := range sensitiveList {
		if v := receivedHeaders.Get(h); v != "" {
			t.Errorf("sensitive header %s should not be forwarded, got %q", h, v)
		}
	}

	// Non-sensitive headers should be forwarded
	if v := receivedHeaders.Get("X-Custom-Header"); v != "safe-value" {
		t.Errorf("X-Custom-Header should be forwarded, got %q", v)
	}
	if v := receivedHeaders.Get("Content-Type"); v != "application/json" {
		t.Errorf("Content-Type should be forwarded, got %q", v)
	}
}

func TestForward_HostHeaderNotForwarded(t *testing.T) {
	var receivedHost string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHost = r.Host
		w.WriteHeader(200)
	}))
	t.Cleanup(target.Close)

	tun := New("test-slug", target.URL)

	req := &types.CapturedRequest{
		Method: "GET",
		Path:   "/",
		Headers: map[string]string{
			"Host": "webhook-sender.example.com",
		},
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if !result.Success {
		t.Fatalf("Forward failed: %s", result.Error)
	}

	// Host should be the target server, not the captured webhook's host
	if receivedHost == "webhook-sender.example.com" {
		t.Error("Host header from captured webhook should not be forwarded")
	}
}

func TestForward_CaseInsensitiveHeaderMatching(t *testing.T) {
	var receivedHeaders http.Header
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		w.WriteHeader(200)
	}))
	t.Cleanup(target.Close)

	tun := New("test-slug", target.URL)

	// Use different cases for sensitive headers
	req := &types.CapturedRequest{
		Method: "POST",
		Path:   "/",
		Headers: map[string]string{
			"AUTHORIZATION": "Bearer top-secret",
			"COOKIE":        "session=xyz",
			"x-api-key":     "key-123",
			"X-Safe":        "allowed",
		},
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if !result.Success {
		t.Fatalf("Forward failed: %s", result.Error)
	}

	if receivedHeaders.Get("Authorization") != "" {
		t.Error("AUTHORIZATION (uppercase) should be stripped")
	}
	if receivedHeaders.Get("Cookie") != "" {
		t.Error("COOKIE (uppercase) should be stripped")
	}
	if receivedHeaders.Get("X-Api-Key") != "" {
		t.Error("x-api-key (lowercase) should be stripped")
	}
	if receivedHeaders.Get("X-Safe") != "allowed" {
		t.Error("X-Safe should be forwarded")
	}
}

func TestForward_QueryParams(t *testing.T) {
	var receivedQuery string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedQuery = r.URL.RawQuery
		w.WriteHeader(200)
	}))
	t.Cleanup(target.Close)

	tun := New("test-slug", target.URL)

	req := &types.CapturedRequest{
		Method: "GET",
		Path:   "/endpoint",
		QueryParams: map[string]string{
			"key":   "value",
			"other": "param",
		},
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if !result.Success {
		t.Fatalf("Forward failed: %s", result.Error)
	}

	if !strings.Contains(receivedQuery, "key=value") {
		t.Errorf("expected key=value in query, got %q", receivedQuery)
	}
	if !strings.Contains(receivedQuery, "other=param") {
		t.Errorf("expected other=param in query, got %q", receivedQuery)
	}
}

func TestForward_PathJoining(t *testing.T) {
	var receivedPath string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.WriteHeader(200)
	}))
	t.Cleanup(target.Close)

	tun := New("test-slug", target.URL+"/base")

	req := &types.CapturedRequest{
		Method: "GET",
		Path:   "/sub/path",
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if !result.Success {
		t.Fatalf("Forward failed: %s", result.Error)
	}

	if receivedPath != "/base/sub/path" {
		t.Errorf("expected /base/sub/path, got %q", receivedPath)
	}
}

func TestForward_BodyForwarded(t *testing.T) {
	var receivedBody string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		receivedBody = string(body)
		w.WriteHeader(200)
	}))
	t.Cleanup(target.Close)

	tun := New("test-slug", target.URL)
	bodyContent := `{"webhook": "data", "id": 42}`

	req := &types.CapturedRequest{
		Method: "POST",
		Path:   "/",
		Body:   bodyContent,
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if !result.Success {
		t.Fatalf("Forward failed: %s", result.Error)
	}

	if receivedBody != bodyContent {
		t.Errorf("body mismatch: got %q, want %q", receivedBody, bodyContent)
	}
}

func TestForwardResult_String_Success(t *testing.T) {
	r := &ForwardResult{
		Success:    true,
		StatusCode: 200,
		Duration:   150 * time.Millisecond,
	}

	s := r.String()
	if !strings.Contains(s, "200") {
		t.Errorf("expected status code in string, got %q", s)
	}
	if !strings.Contains(s, "150ms") {
		t.Errorf("expected duration in string, got %q", s)
	}
}

func TestForwardResult_String_Failure(t *testing.T) {
	r := &ForwardResult{
		Success: false,
		Error:   "connection refused",
	}

	s := r.String()
	if !strings.HasPrefix(s, "FAILED:") {
		t.Errorf("expected FAILED: prefix, got %q", s)
	}
	if !strings.Contains(s, "connection refused") {
		t.Errorf("expected error message in string, got %q", s)
	}
}

func TestForward_TargetDown(t *testing.T) {
	tun := New("test-slug", "http://127.0.0.1:1") // nothing listening

	req := &types.CapturedRequest{
		Method: "GET",
		Path:   "/",
	}

	result, err := tun.Forward(req)
	if err != nil {
		t.Fatalf("Forward should return result not error for connection failure: %v", err)
	}
	if result.Success {
		t.Error("expected Success=false for unreachable target")
	}
	if result.Error == "" {
		t.Error("expected error message for unreachable target")
	}
}

func TestForward_ResponseStatusCode(t *testing.T) {
	codes := []int{200, 201, 204, 400, 404, 500}
	for _, code := range codes {
		t.Run(fmt.Sprintf("status_%d", code), func(t *testing.T) {
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
				_, _ = w.Write([]byte("body"))
			}))
			t.Cleanup(target.Close)

			tun := New("test-slug", target.URL)
			req := &types.CapturedRequest{Method: "GET", Path: "/"}

			result, err := tun.Forward(req)
			if err != nil {
				t.Fatalf("Forward: %v", err)
			}
			if !result.Success {
				t.Fatalf("expected success, got error: %s", result.Error)
			}
			if result.StatusCode != code {
				t.Errorf("expected status %d, got %d", code, result.StatusCode)
			}
		})
	}
}
