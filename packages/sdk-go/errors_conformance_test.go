package webhookscc

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"webhooks.cc/go/internal/conformance"
	"webhooks.cc/go/internal/webtext"
)

// Where this SDK differs from the TypeScript one on purpose, by vector name.
var (
	// Go counts bytes for the 30-character hint threshold, TypeScript UTF-16
	// units, so a short message with non-ASCII text can get no hint here.
	errorHintDiffers = map[string]string{
		"404 20 accented letters": "20 letters are 40 bytes, over 30 here; TypeScript counts 20 UTF-16 units",
	}
	// Go reads a code only from "error", wherever it is in the body;
	// TypeScript only from a leading "error" that is a code, or a "code" field.
	errorCodeDiffers = map[string]string{
		"502 a code field beside a sentence": "the code field is not read",
		"429 search_busy as a code field":    "the code field is not read",
		"400 message before invalid_cursor":  "error is read wherever it is in the body",
	}
)

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

			apiErr := errorFromResponse(&apiResponse{status: status, header: http.Header{}, body: body}, "/endpoints/acme")
			if apiErr.StatusCode != status {
				t.Errorf("status %d", apiErr.StatusCode)
			}
			code := ""
			if want.Code != nil {
				code = *want.Code
			}
			codeAgrees := (want.Code == nil || apiErr.code == code) &&
				errors.Is(apiErr, ErrInvalidCursor) == (status == http.StatusBadRequest && code == "invalid_cursor") &&
				isBusySearch(apiErr) == (status == http.StatusTooManyRequests && code == "search_busy")
			// A listed difference that no longer differs fails too, so the list stays true.
			if _, differs := errorCodeDiffers[vector.Name]; codeAgrees == differs {
				t.Errorf("code %q agrees %v, listed as a difference %v", apiErr.code, codeAgrees, differs)
			}

			// A 429's message is this SDK's own rate-limit text.
			if status == http.StatusTooManyRequests {
				return
			}
			hinted := (status == http.StatusUnauthorized || status == http.StatusNotFound) && apiErr.Message != plain
			if _, differs := errorHintDiffers[vector.Name]; differs {
				if hinted == want.Hinted {
					t.Errorf("hinted %v, listed as a difference", hinted)
				}
				return
			}
			if hinted != want.Hinted {
				t.Fatalf("hinted %v, want %v (message %q)", hinted, want.Hinted, apiErr.Message)
			}
			// Go trims the message, as JavaScript's trim() does, before its hint.
			if hinted && !strings.HasPrefix(apiErr.Message, webtext.JSTrim(plain)) {
				t.Errorf("message %q does not start with %q", apiErr.Message, plain)
			}
			if !hinted && apiErr.Message != plain {
				t.Errorf("message %q, want %q", apiErr.Message, plain)
			}
		})
	}
	for _, list := range []map[string]string{errorHintDiffers, errorCodeDiffers} {
		for name := range list {
			if !names[name] {
				t.Errorf("no vector named %q", name)
			}
		}
	}
}
