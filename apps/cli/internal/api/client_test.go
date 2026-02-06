package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"webhooks.cc/cli/internal/auth"
)

// ---------------------------------------------------------------------------
// NewClient URL validation
// ---------------------------------------------------------------------------

func TestNewClient_DefaultURL(t *testing.T) {
	t.Setenv("WHK_API_URL", "")
	c := NewClient()
	if c.BaseURL() != defaultBaseURL {
		t.Errorf("expected default URL %q, got %q", defaultBaseURL, c.BaseURL())
	}
}

func TestNewClient_EnvOverride(t *testing.T) {
	t.Setenv("WHK_API_URL", "https://custom.example.com")
	c := NewClient()
	if c.BaseURL() != "https://custom.example.com" {
		t.Errorf("expected custom URL, got %q", c.BaseURL())
	}
}

func TestNewClient_InvalidEnvFallsBack(t *testing.T) {
	t.Setenv("WHK_API_URL", "not-a-url")
	c := NewClient()
	if c.BaseURL() != defaultBaseURL {
		t.Errorf("expected fallback to default URL, got %q", c.BaseURL())
	}
}

func TestNewClient_TrailingSlashStripped(t *testing.T) {
	t.Setenv("WHK_API_URL", "https://example.com/")
	c := NewClient()
	if strings.HasSuffix(c.BaseURL(), "/") {
		t.Errorf("trailing slash should be stripped, got %q", c.BaseURL())
	}
}

// ---------------------------------------------------------------------------
// WebhookURL
// ---------------------------------------------------------------------------

func TestWebhookURL_Default(t *testing.T) {
	t.Setenv("WHK_WEBHOOK_URL", "")
	c := NewClient()
	if c.WebhookURL() != defaultWebhookURL {
		t.Errorf("expected default webhook URL %q, got %q", defaultWebhookURL, c.WebhookURL())
	}
}

func TestWebhookURL_EnvOverride(t *testing.T) {
	t.Setenv("WHK_WEBHOOK_URL", "https://custom-webhook.example.com")
	c := NewClient()
	if c.WebhookURL() != "https://custom-webhook.example.com" {
		t.Errorf("expected custom webhook URL, got %q", c.WebhookURL())
	}
}

func TestWebhookURL_InvalidEnvFallsBack(t *testing.T) {
	t.Setenv("WHK_WEBHOOK_URL", "not-a-valid-url")
	c := NewClient()
	if c.WebhookURL() != defaultWebhookURL {
		t.Errorf("expected fallback to default webhook URL, got %q", c.WebhookURL())
	}
}

func TestWebhookURL_TrailingSlashStripped(t *testing.T) {
	t.Setenv("WHK_WEBHOOK_URL", "https://webhook.example.com/")
	c := NewClient()
	url := c.WebhookURL()
	if strings.HasSuffix(url, "/") {
		t.Errorf("trailing slash should be stripped, got %q", url)
	}
}

// ---------------------------------------------------------------------------
// Device auth methods with mock HTTP server
// ---------------------------------------------------------------------------

func setupTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()

	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	return &Client{
		baseURL:    server.URL,
		httpClient: server.Client(),
	}
}

func TestCreateDeviceCode(t *testing.T) {
	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/device-code" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(DeviceCodeResponse{
			DeviceCode:      "dev-code-123",
			UserCode:        "ABCD-1234",
			ExpiresAt:       1700000000000,
			VerificationURL: "https://webhooks.cc/verify",
		})
	}))

	resp, err := c.CreateDeviceCode(context.Background())
	if err != nil {
		t.Fatalf("CreateDeviceCode: %v", err)
	}
	if resp.DeviceCode != "dev-code-123" {
		t.Errorf("DeviceCode = %q, want dev-code-123", resp.DeviceCode)
	}
	if resp.UserCode != "ABCD-1234" {
		t.Errorf("UserCode = %q, want ABCD-1234", resp.UserCode)
	}
	if resp.VerificationURL != "https://webhooks.cc/verify" {
		t.Errorf("VerificationURL = %q", resp.VerificationURL)
	}
}

func TestPollDeviceCode(t *testing.T) {
	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/auth/device-poll") {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		code := r.URL.Query().Get("code")
		if code != "dev-code-123" {
			t.Errorf("expected code=dev-code-123, got %q", code)
		}
		_ = json.NewEncoder(w).Encode(PollResponse{Status: "authorized"})
	}))

	resp, err := c.PollDeviceCode(context.Background(), "dev-code-123")
	if err != nil {
		t.Fatalf("PollDeviceCode: %v", err)
	}
	if resp.Status != "authorized" {
		t.Errorf("Status = %q, want authorized", resp.Status)
	}
}

func TestClaimDeviceCode(t *testing.T) {
	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/device-claim" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("failed to decode request body: %v", err)
			http.Error(w, "bad request", 400)
			return
		}
		if body["deviceCode"] != "dev-code-456" {
			t.Errorf("expected deviceCode=dev-code-456, got %q", body["deviceCode"])
		}

		_ = json.NewEncoder(w).Encode(ClaimResponse{
			APIKey: "api-key-789",
			UserID: "user-abc",
			Email:  "user@example.com",
		})
	}))

	resp, err := c.ClaimDeviceCode(context.Background(), "dev-code-456")
	if err != nil {
		t.Fatalf("ClaimDeviceCode: %v", err)
	}
	if resp.APIKey != "api-key-789" {
		t.Errorf("APIKey = %q, want api-key-789", resp.APIKey)
	}
	if resp.UserID != "user-abc" {
		t.Errorf("UserID = %q, want user-abc", resp.UserID)
	}
	if resp.Email != "user@example.com" {
		t.Errorf("Email = %q, want user@example.com", resp.Email)
	}
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

func TestErrorHandling_4xxWithStatusCode(t *testing.T) {
	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error": "forbidden"}`))
	}))

	_, err := c.CreateDeviceCode(context.Background())
	if err == nil {
		t.Fatal("expected error for 403")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error should contain status code, got %q", err.Error())
	}
}

func TestErrorHandling_BodyTruncatedAt200Chars(t *testing.T) {
	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(strings.Repeat("x", 500)))
	}))

	_, err := c.CreateDeviceCode(context.Background())
	if err == nil {
		t.Fatal("expected error for 500")
	}
	// The error message body should be truncated
	if !strings.Contains(err.Error(), "...") {
		t.Errorf("expected truncated body with '...', got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// Authenticated requests
// ---------------------------------------------------------------------------

func TestAuthenticatedRequest_UsesToken(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	// Save a test token
	if err := auth.SaveToken(&auth.Token{AccessToken: "my-api-key"}); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	var receivedAuth string
	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode([]map[string]string{})
	}))

	_, err := c.ListEndpointsWithContext(context.Background())
	if err != nil {
		t.Fatalf("ListEndpoints: %v", err)
	}

	if receivedAuth != "Bearer my-api-key" {
		t.Errorf("expected Bearer my-api-key, got %q", receivedAuth)
	}
}

func TestAuthenticatedRequest_NoToken(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	c := setupTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	_, err := c.ListEndpointsWithContext(context.Background())
	if err == nil {
		t.Fatal("expected error when not logged in")
	}
	if !strings.Contains(err.Error(), "not logged in") {
		t.Errorf("expected 'not logged in' error, got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// URL validation edge cases
// ---------------------------------------------------------------------------

func TestNewClient_HttpSchemeAccepted(t *testing.T) {
	t.Setenv("WHK_API_URL", "http://localhost:3000")
	c := NewClient()
	if c.BaseURL() != "http://localhost:3000" {
		t.Errorf("HTTP scheme should be accepted, got %q", c.BaseURL())
	}
}

func TestNewClient_NoHostFallsBack(t *testing.T) {
	t.Setenv("WHK_API_URL", "https://")
	c := NewClient()
	if c.BaseURL() != defaultBaseURL {
		t.Errorf("URL with no host should fallback, got %q", c.BaseURL())
	}
}

func TestNewClient_FtpSchemeRejected(t *testing.T) {
	t.Setenv("WHK_API_URL", "ftp://files.example.com")
	c := NewClient()
	if c.BaseURL() != defaultBaseURL {
		t.Errorf("FTP scheme should be rejected, got %q", c.BaseURL())
	}
}
