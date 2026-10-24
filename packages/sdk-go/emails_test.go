package webhookscc_test

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

func TestFormatEmailAddress(t *testing.T) {
	cases := []struct{ slug, tag, domain, want string }{
		{"My-App", "", "", "my-app@mailhooks.cc"},
		{"my-app", "run-42", "", "my-app+run-42@mailhooks.cc"},
		{"my-app", "Run.42", "mailhooks.localhost", "my-app+Run.42@mailhooks.localhost"},
	}
	for _, c := range cases {
		got, err := webhookscc.FormatEmailAddress(c.slug, c.tag, c.domain)
		if err != nil || got != c.want {
			t.Errorf("FormatEmailAddress(%q, %q) = %q, %v; want %q", c.slug, c.tag, got, err, c.want)
		}
	}
	for _, tag := range []string{"has space", "a@b", "quote\"", "x,y", string(make([]byte, 70))} {
		if _, err := webhookscc.FormatEmailAddress("my-app", tag, ""); err == nil {
			t.Errorf("tag %q should be refused", tag)
		}
	}
	if _, err := webhookscc.FormatEmailAddress("../x", "", ""); err == nil {
		t.Error("a bad slug should be refused")
	}
}

func emailJSON(id string, receivedAt int64, tag, subject string, extracts any) map[string]any {
	return requestJSON(id, receivedAt, map[string]any{
		"method": "EMAIL", "kind": "email", "path": "acme-test+" + tag + "@mailhooks.cc",
		"email": map[string]any{
			"subject": subject, "tag": tag,
			"from": []any{map[string]any{"name": "Acme", "address": "no-reply@acme.test"}},
			"to":   []any{map[string]any{"name": nil, "address": "user@example.com"}},
		},
		"extracts": extracts,
	})
}

func TestEmailsWaitForFiltersAndExtracts(t *testing.T) {
	api := newFakeAPI(t)
	now := time.Now().UnixMilli()
	api.handle("GET /api/endpoints/{slug}/requests", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("kind") != "email" {
			http.Error(w, "kind should be email", http.StatusBadRequest)
			return
		}
		writeJSON(w, 200, []any{
			emailJSON("other-run", now, "run-1", "Confirm your email", nil),
			emailJSON("mine", now+1, "run-2", "Confirm your email", map[string]any{
				"codes": []string{"482913"},
				"links": []any{map[string]any{"url": "https://app.example.com/confirm?token=abc", "label": "Confirm", "action": true}},
			}),
		})
	})
	client := api.client()
	email, err := client.Emails.WaitFor(context.Background(), "acme-test", webhookscc.EmailQuery{
		Tag: "run-2", SubjectPattern: regexp.MustCompile(`^Confirm`), From: "NO-REPLY@acme.test", PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if email.ID != "mine" || email.Email.From[0].String() != "Acme <no-reply@acme.test>" {
		t.Errorf("email = %+v", email)
	}
	if code, err := webhookscc.ExtractCode(email); err != nil || code != "482913" {
		t.Errorf("code = %q, %v", code, err)
	}
	if link, err := webhookscc.ExtractActionLink(email); err != nil || link != "https://app.example.com/confirm?token=abc" {
		t.Errorf("link = %q, %v", link, err)
	}
	other, err := client.Emails.Latest(context.Background(), "acme-test", webhookscc.EmailQuery{Tag: "run-1"})
	if err != nil || other == nil || other.ID != "other-run" {
		t.Fatalf("latest = %+v, %v", other, err)
	}
	if _, err := webhookscc.ExtractCode(other); err == nil {
		t.Error("an email without extracts should say so")
	}
	none, err := client.Emails.Latest(context.Background(), "acme-test", webhookscc.EmailQuery{Untagged: true})
	if err != nil || none != nil {
		t.Errorf("untagged = %+v, %v", none, err)
	}
	address, err := client.Emails.AddressOf(&webhookscc.Endpoint{Slug: "acme-test", EmailAddress: "acme-test@mailhooks.localhost"}, "run-3")
	if err != nil || address != "acme-test+run-3@mailhooks.localhost" {
		t.Errorf("address = %q, %v", address, err)
	}
}

func TestExtractsNeedAnEmail(t *testing.T) {
	var request webhookscc.Request
	if err := json.Unmarshal([]byte(`{"id":"r1","method":"POST","path":"/","kind":"http"}`), &request); err != nil {
		t.Fatal(err)
	}
	if _, err := webhookscc.ExtractLink(&request); err == nil {
		t.Error("an HTTP request has no extracts")
	}
}

func TestRequestDecodingIsLenient(t *testing.T) {
	var request webhookscc.Request
	data := `{"_id":"legacy","endpointId":"ep_1","method":"POST","headers":{"X-A":"1","X-N":5},"receivedAt":"soon","signatureVerified":"yes","size":12.0,"extra":true}`
	if err := json.Unmarshal([]byte(data), &request); err != nil {
		t.Fatal(err)
	}
	if request.ID != "legacy" || request.Path != "/" || request.IP != "unknown" || request.Header("x-a") != "1" || len(request.Headers) != 1 {
		t.Errorf("request = %+v", request)
	}
	if !request.ReceivedAt.IsZero() || request.SignatureVerified != nil || request.Size != 12 || string(request.Raw) != data {
		t.Errorf("request = %+v", request)
	}
}
