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
)

const (
	defaultBaseURL         = "https://webhooks.cc"
	httpTimeout            = 30 * time.Second
	maxErrorResponseSize   = 1024 * 1024  // 1MB for error responses
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
	if _, err := url.Parse(baseURL); err != nil {
		// Fall back to default if WHK_API_URL is malformed
		baseURL = defaultBaseURL
	}

	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: httpTimeout,
		},
	}
}

func (c *Client) getToken() (string, error) {
	token, err := auth.LoadToken()
	if err != nil {
		return "", fmt.Errorf("not logged in: %w", err)
	}
	return token.AccessToken, nil
}

func (c *Client) request(ctx context.Context, method, path string, body interface{}, result interface{}) error {
	token, err := c.getToken()
	if err != nil {
		return err
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

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

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
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	if result != nil {
		limitedReader := io.LimitReader(resp.Body, maxSuccessResponseSize)
		if err := json.NewDecoder(limitedReader).Decode(result); err != nil {
			return fmt.Errorf("failed to parse response: %w", err)
		}
	}

	return nil
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

// Endpoint represents a webhook endpoint in the webhooks.cc system.
type Endpoint struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
	URL  string `json:"url"`
}
