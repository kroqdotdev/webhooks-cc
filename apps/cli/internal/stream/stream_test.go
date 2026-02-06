package stream

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"webhooks.cc/shared/types"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// runSSETest creates a mock SSE server with the given data, connects, and
// returns the captured requests. Reduces boilerplate across SSE parsing tests.
func runSSETest(t *testing.T, sseData string) []*types.CapturedRequest {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(sseData))
	}))
	t.Cleanup(server.Close)

	s := New("test-slug", server.URL, "token")
	s.client = server.Client()
	s.baseURL = server.URL

	var mu sync.Mutex
	var received []*types.CapturedRequest
	handler := func(req *types.CapturedRequest) {
		mu.Lock()
		received = append(received, req)
		mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = s.connect(ctx, handler)

	mu.Lock()
	defer mu.Unlock()
	return received
}

// ---------------------------------------------------------------------------
// SSE parsing via connect()
// ---------------------------------------------------------------------------

func TestStream_SingleDataLine(t *testing.T) {
	received := runSSETest(t, `event: request
data: {"_id":"req-1","method":"POST","path":"/hook","headers":{},"queryParams":{},"ip":"1.2.3.4","size":42,"receivedAt":1700000000000}

`)
	if len(received) != 1 {
		t.Fatalf("expected 1 request, got %d", len(received))
	}
	if received[0].Method != "POST" {
		t.Errorf("expected POST, got %s", received[0].Method)
	}
	if received[0].Path != "/hook" {
		t.Errorf("expected /hook, got %s", received[0].Path)
	}
}

func TestStream_MultiLineData(t *testing.T) {
	// SSE spec: multiple "data:" lines are joined with \n
	// Split at a JSON whitespace-safe boundary (between key-value pairs)
	received := runSSETest(t, `event: request
data: {"_id":"req-2","method":"GET","path":"/multi",
data: "headers":{},"queryParams":{},"ip":"5.6.7.8",
data: "size":0,"receivedAt":1700000000000}

`)
	if len(received) != 1 {
		t.Fatalf("expected 1 request from multi-line data, got %d", len(received))
	}
	if received[0].Method != "GET" {
		t.Errorf("expected GET, got %s", received[0].Method)
	}
}

func TestStream_KeepaliveSkipped(t *testing.T) {
	received := runSSETest(t, `:ping
:keepalive
event: request
data: {"_id":"req-3","method":"PUT","path":"/after-ping","headers":{},"queryParams":{},"ip":"1.1.1.1","size":0,"receivedAt":1700000000000}

`)
	if len(received) != 1 {
		t.Fatalf("expected 1 request (keepalive skipped), got %d", len(received))
	}
	if received[0].Path != "/after-ping" {
		t.Errorf("expected /after-ping, got %s", received[0].Path)
	}
}

func TestStream_NonRequestEventIgnored(t *testing.T) {
	received := runSSETest(t, `event: heartbeat
data: {"_id":"ignored","method":"GET","path":"/nope","headers":{},"queryParams":{},"ip":"0","size":0,"receivedAt":0}

event: request
data: {"_id":"kept","method":"DELETE","path":"/yes","headers":{},"queryParams":{},"ip":"1","size":0,"receivedAt":0}

`)
	if len(received) != 1 {
		t.Fatalf("expected 1 request (non-request event ignored), got %d", len(received))
	}
	if received[0].Method != "DELETE" {
		t.Errorf("expected DELETE, got %s", received[0].Method)
	}
}

func TestStream_MalformedJSON_NoHandler(t *testing.T) {
	received := runSSETest(t, `event: request
data: {this is not valid json!!!}

event: request
data: {"_id":"valid","method":"PATCH","path":"/ok","headers":{},"queryParams":{},"ip":"2","size":0,"receivedAt":0}

`)
	// Malformed JSON should be skipped, only valid one received
	if len(received) != 1 {
		t.Fatalf("expected 1 request (malformed skipped), got %d", len(received))
	}
	if received[0].Method != "PATCH" {
		t.Errorf("expected PATCH, got %s", received[0].Method)
	}
}

// ---------------------------------------------------------------------------
// Non-retryable status codes
// ---------------------------------------------------------------------------

func TestStream_NonRetryableStatusCodes(t *testing.T) {
	codes := []int{401, 403, 404}
	for _, code := range codes {
		t.Run(fmt.Sprintf("status_%d", code), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
			}))
			t.Cleanup(server.Close)

			s := New("test-slug", server.URL, "token")
			s.client = server.Client()
			s.baseURL = server.URL

			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()

			err := s.connect(ctx, func(req *types.CapturedRequest) {})
			if err == nil {
				t.Fatalf("expected error for status %d", code)
			}

			statusErr, ok := err.(*StatusError)
			if !ok {
				t.Fatalf("expected *StatusError, got %T: %v", err, err)
			}
			if statusErr.Code != code {
				t.Errorf("expected code %d, got %d", code, statusErr.Code)
			}
		})
	}
}

func TestStatusError_Error(t *testing.T) {
	e := &StatusError{Code: 401}
	if !strings.Contains(e.Error(), "401") {
		t.Errorf("expected 401 in error message, got %q", e.Error())
	}
}

// ---------------------------------------------------------------------------
// FormatRequest
// ---------------------------------------------------------------------------

func TestFormatRequest(t *testing.T) {
	req := &types.CapturedRequest{
		Method:     "POST",
		Path:       "/webhook",
		Size:       1536,
		ReceivedAt: 1700000000000,
	}

	s := FormatRequest(req)
	if !strings.Contains(s, "POST") {
		t.Errorf("expected POST in output, got %q", s)
	}
	if !strings.Contains(s, "/webhook") {
		t.Errorf("expected /webhook in output, got %q", s)
	}
	if !strings.Contains(s, "1.5kb") {
		t.Errorf("expected 1.5kb in output, got %q", s)
	}
}

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

func TestFormatBytes(t *testing.T) {
	tests := []struct {
		size int
		want string
	}{
		{0, "0b"},
		{100, "100b"},
		{1023, "1023b"},
		{1024, "1.0kb"},
		{1536, "1.5kb"},
		{1024 * 1024, "1.0mb"},
		{1536 * 1024, "1.5mb"},
		{10 * 1024 * 1024, "10.0mb"},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("%d", tt.size), func(t *testing.T) {
			got := formatBytes(tt.size)
			if got != tt.want {
				t.Errorf("formatBytes(%d) = %q, want %q", tt.size, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// colorMethod
// ---------------------------------------------------------------------------

func TestColorMethod(t *testing.T) {
	tests := []struct {
		method     string
		hasAnsi    bool
	}{
		{"GET", true},
		{"POST", true},
		{"PUT", true},
		{"DELETE", true},
		{"PATCH", true},
		{"OPTIONS", false},
		{"HEAD", false},
		{"CUSTOM", false},
	}

	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			result := colorMethod(tt.method)
			hasEscape := strings.Contains(result, "\033[")
			if hasEscape != tt.hasAnsi {
				t.Errorf("colorMethod(%q) ANSI = %v, want %v (result=%q)", tt.method, hasEscape, tt.hasAnsi, result)
			}
			// Should always contain the method name
			if !strings.Contains(result, tt.method) {
				t.Errorf("colorMethod(%q) should contain method name, got %q", tt.method, result)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Listen with non-retryable error
// ---------------------------------------------------------------------------

func TestListen_NonRetryable_Returns(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	t.Cleanup(server.Close)

	s := New("test-slug", server.URL, "bad-token")
	s.client = server.Client()
	s.baseURL = server.URL

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := s.Listen(ctx, func(req *types.CapturedRequest) {})
	if err == nil {
		t.Fatal("expected error from Listen for 401")
	}

	statusErr, ok := err.(*StatusError)
	if !ok {
		t.Fatalf("expected *StatusError, got %T: %v", err, err)
	}
	if statusErr.Code != 401 {
		t.Errorf("expected 401, got %d", statusErr.Code)
	}
}
