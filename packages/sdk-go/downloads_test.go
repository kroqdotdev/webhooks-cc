package webhookscc_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

// Not UTF-8, with a NUL and CRLFs: what comes back must be these bytes.
var storedBytes = []byte("Subject: Order 1\r\n\r\n\x00\xff\xfe not UTF-8\r\n")

func TestRawReturnsTheMessageBytesUnchanged(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/requests/{id}/raw", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "message/rfc822")
		w.Header().Set("Content-Disposition", `attachment; filename="email-6f1c0a2b.eml"`)
		_, _ = w.Write(storedBytes)
	})
	raw, err := api.client().Requests.Raw(context.Background(), "req_1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, storedBytes) {
		t.Errorf("raw = %q", raw)
	}
	request, _ := api.last()
	if request.URL.Path != "/api/requests/req_1/raw" || request.Header.Get("Authorization") != "Bearer whcc_test" {
		t.Errorf("request = %s %v", request.URL.Path, request.Header)
	}
}

func TestAttachmentReturnsItsBytesNameAndTypeUnchanged(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/requests/{id}/attachments/{index}", func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("index") {
		case "2":
			w.Header().Set("Content-Type", "text/csv")
			w.Header().Set("Content-Disposition", `attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`)
			_, _ = w.Write(storedBytes)
		case "0":
			// A name cut inside an escape keeps the plain one.
			w.Header()["Content-Type"] = nil
			w.Header().Set("Content-Disposition", `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A`)
			_, _ = w.Write([]byte("%PDF"))
		default:
			// No headers at all: the defaults. A nil Content-Type keeps
			// net/http from sniffing one.
			w.Header()["Content-Type"] = nil
		}
	})
	client := api.client()
	ctx := context.Background()

	download, err := client.Requests.Attachment(ctx, "req_1", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(download.Body, storedBytes) || download.Filename != "r\u00e9sum\u00e9.csv" || download.ContentType != "text/csv" {
		t.Errorf("download = %q %q %q", download.Body, download.Filename, download.ContentType)
	}
	if request, _ := api.last(); request.URL.Path != "/api/requests/req_1/attachments/2" {
		t.Errorf("path = %s", request.URL.Path)
	}

	cut, err := client.Requests.Attachment(ctx, "req_1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if cut.Filename != "r_sum_.pdf" || cut.ContentType != "application/octet-stream" || string(cut.Body) != "%PDF" {
		t.Errorf("cut = %q %q %q", cut.Body, cut.Filename, cut.ContentType)
	}

	empty, err := client.Requests.Attachment(ctx, "req_1", 99)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.Body) != 0 || empty.Filename != "" || empty.ContentType != "application/octet-stream" {
		t.Errorf("empty = %+v", empty)
	}
}

func TestDownloadsReturnTypedErrorsAndCheckTheirInput(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/requests/{id}/raw", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not_an_email"})
	})
	api.handle("GET /api/requests/{id}/attachments/{index}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_kept", "message": "This email's attachment contents were not kept."})
	})
	client := api.client()
	ctx := context.Background()

	_, err := client.Requests.Attachment(ctx, "req_1", 0)
	if !errors.Is(err, webhookscc.ErrNotFound) || !strings.Contains(err.Error(), "not_kept") {
		t.Errorf("404: %v", err)
	}
	_, err = client.Requests.Raw(ctx, "req_1")
	var apiErr *webhookscc.Error
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusBadRequest {
		t.Errorf("400: %v", err)
	}

	count := func() int {
		api.mu.Lock()
		defer api.mu.Unlock()
		return len(api.calls)
	}
	calls := count()
	for _, index := range []int{-1, 100} {
		if _, err := client.Requests.Attachment(ctx, "req_1", index); err == nil || !strings.Contains(err.Error(), "index") {
			t.Errorf("index %d: %v", index, err)
		}
	}
	if _, err := client.Requests.Raw(ctx, "../req_1"); err == nil {
		t.Error("a bad request id reached the API")
	}
	if refused := count() - calls; refused != 0 {
		t.Errorf("%d calls for input the SDK refuses", refused)
	}
}

func TestDownloadsAreRetriedLikeOtherReads(t *testing.T) {
	api := newFakeAPI(t)
	var calls atomic.Int32
	api.handle("GET /api/requests/{id}/raw", func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write(storedBytes)
	})
	client := api.client(webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 2, Backoff: time.Millisecond}))
	raw, err := client.Requests.Raw(context.Background(), "req_1")
	if err != nil || !bytes.Equal(raw, storedBytes) {
		t.Fatalf("raw = %q, %v", raw, err)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d", calls.Load())
	}
}
