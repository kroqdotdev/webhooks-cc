// Package api provides a client for interacting with the webhooks.cc API.
// It handles authentication, request signing, and response parsing for
// endpoint management operations.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"webhooks.cc/cli/internal/auth"
	"webhooks.cc/shared/types"
)

const (
	defaultBaseURL         = "https://webhooks.cc"
	defaultWebhookURL      = "https://go.webhooks.cc"
	httpTimeout            = 30 * time.Second
	maxErrorResponseSize   = 1024 * 1024    // 1MB for error responses
	maxSuccessResponseSize = 10 * 1024 * 1024 // 10MB for success responses
)

// Client provides methods to interact with the webhooks.cc API.
// Create a new Client using NewClient().
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// NewClient creates a new API client. By default it connects to
// https://webhooks.cc, but this can be overridden by setting the
// WHK_API_URL environment variable for self-hosted deployments.
func NewClient() *Client {
	baseURL := os.Getenv("WHK_API_URL")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}

	// Strip trailing slash to prevent double slashes in URLs
	baseURL = strings.TrimSuffix(baseURL, "/")

	// Validate URL format early to provide clear error messages
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		fmt.Fprintf(os.Stderr, "Warning: WHK_API_URL is invalid (%q), using default %s\n", baseURL, defaultBaseURL)
		baseURL = defaultBaseURL
	}

	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: httpTimeout,
		},
	}
}

// BaseURL returns the configured API base URL for use by the stream package.
func (c *Client) BaseURL() string {
	return c.baseURL
}

// WebhookURL returns the URL where webhooks are received (go.webhooks.cc).
// This can be overridden with the WHK_WEBHOOK_URL environment variable.
func (c *Client) WebhookURL() string {
	if envURL := os.Getenv("WHK_WEBHOOK_URL"); envURL != "" {
		trimmed := strings.TrimSuffix(envURL, "/")
		parsed, err := url.Parse(trimmed)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			fmt.Fprintf(os.Stderr, "Warning: WHK_WEBHOOK_URL is invalid (%q), using default %s\n", trimmed, defaultWebhookURL)
			return defaultWebhookURL
		}
		return trimmed
	}
	return defaultWebhookURL
}

func (c *Client) getToken() (string, error) {
	token, err := auth.LoadToken()
	if err != nil {
		return "", fmt.Errorf("not logged in: %w", err)
	}
	return token.AccessToken, nil
}

func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}, result interface{}, authenticated bool) error {
	var token string
	if authenticated {
		var err error
		token, err = c.getToken()
		if err != nil {
			return err
		}
	}

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	if authenticated {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")

	return c.executeRequest(req, result)
}

func (c *Client) executeRequest(req *http.Request, result interface{}) error {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseSize))
		if err != nil {
			return fmt.Errorf("API error (%d): failed to read response", resp.StatusCode)
		}
		// Truncate long error bodies for readability
		bodyStr := string(body)
		if len(bodyStr) > 200 {
			bodyStr = bodyStr[:200] + "..."
		}
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, bodyStr)
	}

	if result != nil {
		limitedReader := io.LimitReader(resp.Body, maxSuccessResponseSize)
		if err := json.NewDecoder(limitedReader).Decode(result); err != nil {
			return fmt.Errorf("failed to parse response: %w", err)
		}
	}

	return nil
}

func (c *Client) request(ctx context.Context, method, path string, body interface{}, result interface{}) error {
	return c.doRequest(ctx, method, path, body, result, true)
}

func (c *Client) requestNoAuth(ctx context.Context, method, path string, body interface{}, result interface{}) error {
	return c.doRequest(ctx, method, path, body, result, false)
}

// --- Device auth methods ---

// DeviceCodeResponse is returned by CreateDeviceCode
type DeviceCodeResponse struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	ExpiresAt       int64  `json:"expiresAt"`
	VerificationURL string `json:"verificationUrl"`
}

// PollResponse is returned by PollDeviceCode
type PollResponse struct {
	Status string `json:"status"`
}

// ClaimResponse is returned by ClaimDeviceCode
type ClaimResponse struct {
	APIKey string `json:"apiKey"`
	UserID string `json:"userId"`
	Email  string `json:"email"`
}

// CreateDeviceCode initiates the device authorization flow
func (c *Client) CreateDeviceCode(ctx context.Context) (*DeviceCodeResponse, error) {
	var result DeviceCodeResponse
	err := c.requestNoAuth(ctx, "POST", "/api/auth/device-code", nil, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// PollDeviceCode checks the status of a device authorization request
func (c *Client) PollDeviceCode(ctx context.Context, deviceCode string) (*PollResponse, error) {
	var result PollResponse
	err := c.requestNoAuth(ctx, "GET", "/api/auth/device-poll?code="+url.QueryEscape(deviceCode), nil, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// ClaimDeviceCode exchanges an authorized device code for an API key
func (c *Client) ClaimDeviceCode(ctx context.Context, deviceCode string) (*ClaimResponse, error) {
	var result ClaimResponse
	err := c.requestNoAuth(ctx, "POST", "/api/auth/device-claim", map[string]string{"deviceCode": deviceCode}, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// --- Endpoint CRUD ---

// Endpoint represents a webhook endpoint in the webhooks.cc system.
type Endpoint struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// CreateEndpoint creates a new endpoint
func (c *Client) CreateEndpoint(name string) (*Endpoint, error) {
	return c.CreateEndpointWithContext(context.Background(), name)
}

// CreateEndpointWithContext creates a new endpoint with context for cancellation
func (c *Client) CreateEndpointWithContext(ctx context.Context, name string) (*Endpoint, error) {
	var result Endpoint
	err := c.request(ctx, "POST", "/api/endpoints", map[string]string{"name": name}, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// ListEndpoints returns all endpoints for the user
func (c *Client) ListEndpoints() ([]Endpoint, error) {
	return c.ListEndpointsWithContext(context.Background())
}

// ListEndpointsWithContext returns all endpoints for the user with context for cancellation
func (c *Client) ListEndpointsWithContext(ctx context.Context) ([]Endpoint, error) {
	var result []Endpoint
	err := c.request(ctx, "GET", "/api/endpoints", nil, &result)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// DeleteEndpoint deletes an endpoint
func (c *Client) DeleteEndpoint(slug string) error {
	return c.DeleteEndpointWithContext(context.Background(), slug)
}

// DeleteEndpointWithContext deletes an endpoint with context for cancellation
func (c *Client) DeleteEndpointWithContext(ctx context.Context, slug string) error {
	// Escape the slug to prevent path injection attacks
	return c.request(ctx, "DELETE", "/api/endpoints/"+url.PathEscape(slug), nil, nil)
}

// --- Request methods ---

// GetRequest fetches a single captured request by ID
func (c *Client) GetRequest(ctx context.Context, requestID string) (*types.CapturedRequest, error) {
	var result types.CapturedRequest
	err := c.request(ctx, "GET", "/api/requests/"+url.PathEscape(requestID), nil, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}
