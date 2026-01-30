package stream

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	"webhooks.cc/shared/types"
)

type Stream struct {
	endpointSlug string
	baseURL      string
	token        string
}

type RequestHandler func(req *types.CapturedRequest)

func New(endpointSlug, baseURL, token string) *Stream {
	return &Stream{
		endpointSlug: endpointSlug,
		baseURL:      baseURL,
		token:        token,
	}
}

// Listen connects to the real-time stream and calls handler for each request.
// It respects the provided context for cancellation and graceful shutdown.
func (s *Stream) Listen(ctx context.Context, handler RequestHandler) error {
	// URL-escape the slug to prevent injection
	escapedSlug := url.PathEscape(s.endpointSlug)
	streamURL := fmt.Sprintf("%s/api/stream/%s", s.baseURL, escapedSlug)

	req, err := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	// Configure HTTP client with connection timeouts but no overall timeout for SSE
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second, // Connection establishment timeout
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       5 * time.Minute,
	}
	client := &http.Client{
		Timeout:   0, // No overall timeout for SSE long-polling
		Transport: transport,
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	// Channel to signal scanner goroutine completion
	done := make(chan struct{})
	errChan := make(chan error, 1)

	go func() {
		defer close(done)
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			select {
			case <-ctx.Done():
				return
			default:
			}

			line := scanner.Text()

			// Skip empty lines and comments
			if len(line) == 0 || line[0] == ':' {
				continue
			}

			// Parse SSE data
			if len(line) > 5 && line[:5] == "data:" {
				data := line[5:]
				if len(data) > 0 && data[0] == ' ' {
					data = data[1:]
				}

				var capturedReq types.CapturedRequest
				if err := json.Unmarshal([]byte(data), &capturedReq); err != nil {
					continue
				}

				handler(&capturedReq)
			}
		}
		if err := scanner.Err(); err != nil {
			errChan <- err
		}
	}()

	// Wait for either context cancellation or scanner completion
	select {
	case <-ctx.Done():
		// Close the response body to unblock the scanner
		resp.Body.Close()
		<-done // Wait for goroutine to finish
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

func colorMethod(method string) string {
	// ANSI colors for methods
	colors := map[string]string{
		"GET":    "\033[32m", // Green
		"POST":   "\033[34m", // Blue
		"PUT":    "\033[33m", // Yellow
		"DELETE": "\033[31m", // Red
		"PATCH":  "\033[35m", // Magenta
	}

	reset := "\033[0m"
	color, ok := colors[method]
	if !ok {
		color = ""
		reset = ""
	}

	return fmt.Sprintf("%s%s%s", color, method, reset)
}

func formatBytes(size int) string {
	if size < 1024 {
		return fmt.Sprintf("%db", size)
	}
	return fmt.Sprintf("%.1fkb", float64(size)/1024)
}
