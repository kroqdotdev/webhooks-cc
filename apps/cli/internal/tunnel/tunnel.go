// Package tunnel forwards captured webhook requests to local development servers.
// It replays requests against a configurable target URL, filtering security-sensitive
// headers to prevent credential leakage from captured webhooks.
package tunnel

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"webhooks.cc/shared/types"
)

// maxResponseBodySize limits the response body to prevent memory exhaustion
const maxResponseBodySize = 100 * 1024 * 1024 // 100MB

// sensitiveHeaders that should not be forwarded to local services (lowercase for case-insensitive matching)
// These headers from captured webhooks could expose credentials or cause security issues
var sensitiveHeaders = map[string]bool{
	"authorization":       true,
	"cookie":              true,
	"set-cookie":          true,
	"x-api-key":           true,
	"proxy-authorization": true,
	"x-auth-token":        true,
	"x-access-token":      true,
}

// Tunnel forwards captured webhook requests to a local target URL.
// Filters security-sensitive headers (Authorization, Cookie, etc.)
// before forwarding to prevent credential leakage.
type Tunnel struct {
	endpointSlug string
	targetURL    string
	httpClient   *http.Client
}

// New creates a Tunnel that forwards requests to the given target URL.
func New(endpointSlug, targetURL string) *Tunnel {
	return &Tunnel{
		endpointSlug: endpointSlug,
		targetURL:    targetURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Forward sends a captured request to the target URL
func (t *Tunnel) Forward(req *types.CapturedRequest) (*ForwardResult, error) {
	start := time.Now()

	// Parse the base target URL
	base, err := url.Parse(t.targetURL)
	if err != nil {
		return nil, fmt.Errorf("invalid target URL: %w", err)
	}

	// Safely join the path to prevent path traversal attacks
	// url.JoinPath properly handles ".." and other malicious path segments
	targetURL, err := url.JoinPath(base.String(), req.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid request path: %w", err)
	}

	// Create the forwarded request
	httpReq, err := http.NewRequest(req.Method, targetURL, bytes.NewBufferString(req.Body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Copy headers (except Host and sensitive security headers)
	// We filter sensitive headers to prevent forwarding credentials from
	// captured webhooks to the local target service
	// Use case-insensitive matching since HTTP headers are case-insensitive per RFC 7230
	for key, value := range req.Headers {
		keyLower := strings.ToLower(key)
		if keyLower != "host" && !sensitiveHeaders[keyLower] {
			httpReq.Header.Set(key, value)
		}
	}

	// Send the request
	resp, err := t.httpClient.Do(httpReq)
	if err != nil {
		return &ForwardResult{
			Success:  false,
			Error:    err.Error(),
			Duration: time.Since(start),
		}, nil
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBodySize))
	if err != nil {
		return &ForwardResult{
			Success:  false,
			Error:    fmt.Sprintf("failed to read response: %v", err),
			Duration: time.Since(start),
		}, nil
	}

	return &ForwardResult{
		Success:    true,
		StatusCode: resp.StatusCode,
		Duration:   time.Since(start),
		BodySize:   len(body),
	}, nil
}

// ForwardResult contains the outcome of forwarding a request.
// On failure, Success is false and Error describes what went wrong.
type ForwardResult struct {
	Success    bool
	StatusCode int
	Duration   time.Duration
	BodySize   int
	Error      string
}

// String returns a formatted status for terminal display.
func (r *ForwardResult) String() string {
	if !r.Success {
		return fmt.Sprintf("FAILED: %s", r.Error)
	}
	return fmt.Sprintf("%d (%s)", r.StatusCode, r.Duration.Round(time.Millisecond))
}
