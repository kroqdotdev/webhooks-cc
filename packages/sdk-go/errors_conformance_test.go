package webhookscc

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"webhooks.cc/go/internal/conformance"
	"webhooks.cc/go/internal/webtext"
)

// Where this SDK differs from the TypeScript one, and why, by vector name.
// Go reads a code only from "error", never from a "code" field.
var errorCodeDiffers = map[string]string{
	"502 a code field beside a sentence": "the code field is not read",
	"429 search_busy as a code field":    "the code field is not read",
}

// Not compared at all: a 429's message is this SDK's own rate-limit text.
// Go trims a message, as JavaScript's trim() does, before its hint, so a
// hinted message starts with the trimmed text.

func TestErrorsConformance(t *testing.T) {
	var file struct {
		Version int `json:"version"`
		Vectors []struct {
			Name     string `json:"name"`
			Status   int    `json:"status"`
			Body     string `json:"body"`
			Expected struct {
				Message string  `json:"message"`
				Code    *string `json:"code"`
				Hinted  bool    `json:"hinted"`
			} `json:"expected"`
		} `json:"vectors"`
	}
	conformance.Load(t, "errors.json", &file)
	if file.Version != 1 {
		t.Fatalf("errors.json version %d; this test reads version 1", file.Version)
	}
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	names := map[string]bool{}
	for _, vector := range file.Vectors {
		names[vector.Name] = true
		t.Run(vector.Name, func(t *testing.T) {
			status, body, want := vector.Status, []byte(vector.Body), vector.Expected
			plain := plainErrorText(status, body)
			if plain != want.Message {
				t.Fatalf("message %q, want %q", plain, want.Message)
			}

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/endpoints/acme" {
					t.Errorf("path %s", r.URL.Path)
				}
				w.WriteHeader(status)
				_, _ = w.Write(body)
			}))
			defer server.Close()
			client, err := New(WithAPIKey("whcc_conformance"), WithBaseURL(server.URL+"/"))
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Endpoints.Get(context.Background(), "acme")
			var apiErr *Error
			if !errors.As(err, &apiErr) {
				t.Fatalf("error %v", err)
			}
			if apiErr.StatusCode != status {
				t.Errorf("status %d", apiErr.StatusCode)
			}

			code := ""
			if want.Code != nil {
				code = *want.Code
			}
			codeAgrees := apiErr.code == code &&
				errors.Is(apiErr, ErrInvalidCursor) == (status == http.StatusBadRequest && apiErr.code == "invalid_cursor") &&
				isBusySearch(apiErr) == (status == http.StatusTooManyRequests && apiErr.code == "search_busy")
			// A listed difference that no longer differs fails too, so the list stays true.
			if _, differs := errorCodeDiffers[vector.Name]; codeAgrees == differs {
				t.Errorf("code %q, want %q, listed as a difference %v", apiErr.code, code, differs)
			}

			if status == http.StatusTooManyRequests {
				return
			}
			hinted := (status == http.StatusUnauthorized || status == http.StatusNotFound) && apiErr.Message != plain
			if hinted != want.Hinted {
				t.Fatalf("hinted %v, want %v (message %q)", hinted, want.Hinted, apiErr.Message)
			}
			if hinted && !strings.HasPrefix(apiErr.Message, webtext.JSTrim(plain)) {
				t.Errorf("message %q does not start with %q", apiErr.Message, plain)
			}
			if !hinted && apiErr.Message != plain {
				t.Errorf("message %q, want %q", apiErr.Message, plain)
			}
		})
	}
	for name := range errorCodeDiffers {
		if !names[name] {
			t.Errorf("no vector named %q", name)
		}
	}
}
