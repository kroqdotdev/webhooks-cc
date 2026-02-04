// Package stream provides Server-Sent Events (SSE) connectivity for real-time
// webhook notifications. It maintains a persistent connection to the webhooks.cc
// API and delivers captured requests as they arrive.
package stream

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"webhooks.cc/shared/types"
)

// StatusError represents an HTTP status code error from the SSE endpoint.
type StatusError struct {
	Code int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("unexpected status: %d", e.Code)
}

const (
	scannerInitBufSize = 64 * 1024    // 64KB initial scanner buffer
	scannerMaxBufSize  = 1024 * 1024  // 1MB max line size for large webhook bodies
	maxDebugDataLen    = 200          // truncate debug log data to avoid leaking sensitive payloads
	initialBackoff     = 1 * time.Second
	maxBackoff         = 30 * time.Second
)

// debugLog conditionally logs debug messages if WHK_DEBUG is set
var debugLog = func() func(format string, args ...any) {
	if os.Getenv("WHK_DEBUG") != "" {
		return func(format string, args ...any) {
			log.Printf("[DEBUG] "+format, args...)
		}
	}
	return func(format string, args ...any) {} // no-op
}()

// Stream manages a Server-Sent Events connection to receive webhook notifications.
// It handles connection timeouts, automatic reconnection with exponential backoff,
// and SSE message parsing.
type Stream struct {
	endpointSlug string
	baseURL      string
	token        string
	client       *http.Client
}

// RequestHandler processes captured webhook requests as they arrive.
// Handlers are called synchronously from a single goroutine — they must not
// be stored or called from other goroutines.
type RequestHandler func(req *types.CapturedRequest)

// New creates a Stream that listens for webhooks on the given endpoint.
// The token authenticates with the webhooks.cc API.
// The transport is reused across reconnections for connection pooling.
func New(endpointSlug, baseURL, token string) *Stream {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       5 * time.Minute,
	}
	return &Stream{
		endpointSlug: endpointSlug,
		baseURL:      baseURL,
		token:        token,
		client: &http.Client{
			Timeout:   0, // No overall timeout for SSE long-polling
			Transport: transport,
		},
	}
}

// Listen connects to the real-time stream and calls handler for each request.
// It automatically reconnects with exponential backoff on connection loss.
// It respects the provided context for cancellation and graceful shutdown.
func (s *Stream) Listen(ctx context.Context, handler RequestHandler) error {
	backoff := initialBackoff
	for {
		connectStart := time.Now()
		err := s.connect(ctx, handler)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Non-retryable errors (e.g., 401, 404)
		var statusErr *StatusError
		if err != nil && errors.As(err, &statusErr) {
			if statusErr.Code == 401 || statusErr.Code == 403 || statusErr.Code == 404 {
				return err
			}
		}
		// Reset backoff if connection was alive for a meaningful duration
		if time.Since(connectStart) > 30*time.Second {
			backoff = initialBackoff
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "Connection lost: %v, reconnecting in %v...\n", err, backoff)
		} else {
			fmt.Fprintf(os.Stderr, "Connection closed, reconnecting in %v...\n", backoff)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = backoff * 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// connect performs a single SSE connection attempt and processes messages
// until the connection is lost or context is cancelled.
func (s *Stream) connect(ctx context.Context, handler RequestHandler) error {
	escapedSlug := url.PathEscape(s.endpointSlug)
	streamURL := fmt.Sprintf("%s/api/stream/%s", s.baseURL, escapedSlug)

	req, err := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return &StatusError{Code: resp.StatusCode}
	}

	// Channel to signal scanner goroutine completion
	done := make(chan struct{})
	errChan := make(chan error, 1)

	go func() {
		defer close(done)
		scanner := bufio.NewScanner(resp.Body)
		buf := make([]byte, scannerInitBufSize)
		scanner.Buffer(buf, scannerMaxBufSize)

		var currentEvent string
		var dataLines []string

		for scanner.Scan() {
			select {
			case <-ctx.Done():
				return
			default:
			}

			line := scanner.Text()

			// Empty line marks end of an SSE message — process accumulated data
			if len(line) == 0 {
				if currentEvent == "request" && len(dataLines) > 0 {
					data := strings.Join(dataLines, "\n")
					var capturedReq types.CapturedRequest
					if err := json.Unmarshal([]byte(data), &capturedReq); err != nil {
						truncated := data
						if len(truncated) > maxDebugDataLen {
							truncated = truncated[:maxDebugDataLen] + "..."
						}
						debugLog("SSE parse error: %v (data: %s)", err, truncated)
					} else {
						handler(&capturedReq)
					}
				}
				currentEvent = ""
				dataLines = nil
				continue
			}

			// Skip comments (keepalive pings)
			if line[0] == ':' {
				continue
			}

			// Track SSE event type
			if strings.HasPrefix(line, "event:") {
				currentEvent = strings.TrimSpace(line[6:])
				continue
			}

			// Accumulate data lines (SSE spec allows multi-line data)
			if strings.HasPrefix(line, "data:") {
				d := line[5:]
				if len(d) > 0 && d[0] == ' ' {
					d = d[1:]
				}
				dataLines = append(dataLines, d)
			}
		}
		if err := scanner.Err(); err != nil {
			errChan <- err
		}
	}()

	// Wait for either context cancellation or scanner completion
	select {
	case <-ctx.Done():
		_ = resp.Body.Close() // Unblock scanner.Scan() in case context cancellation doesn't interrupt the read
		<-done
		return ctx.Err()
	case <-done:
		select {
		case err := <-errChan:
			return err
		default:
			return nil
		}
	}
}

// FormatRequest returns a formatted string for terminal output
func FormatRequest(req *types.CapturedRequest) string {
	t := time.UnixMilli(req.ReceivedAt).Format("15:04:05")
	return fmt.Sprintf("%s  %-6s %s  %s",
		t,
		colorMethod(req.Method),
		req.Path,
		formatBytes(req.Size),
	)
}

// methodColors is a package-level map to avoid allocating on every call.
var methodColors = map[string]string{
	"GET":    "\033[32m", // Green
	"POST":   "\033[34m", // Blue
	"PUT":    "\033[33m", // Yellow
	"DELETE": "\033[31m", // Red
	"PATCH":  "\033[35m", // Magenta
}

// colorMethod returns the method string with ANSI color codes for terminal display.
func colorMethod(method string) string {
	color, ok := methodColors[method]
	if !ok {
		return method
	}
	return fmt.Sprintf("%s%s\033[0m", color, method)
}

// formatBytes converts a byte count to a human-readable string (e.g., "1.5kb").
func formatBytes(size int) string {
	switch {
	case size < 1024:
		return fmt.Sprintf("%db", size)
	case size < 1024*1024:
		return fmt.Sprintf("%.1fkb", float64(size)/1024)
	default:
		return fmt.Sprintf("%.1fmb", float64(size)/(1024*1024))
	}
}
