package webhookscc_test

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"regexp"
	"strings"
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

func TestEmailsCarryTheirFieldsAndReplyText(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/requests/{id}", func(w http.ResponseWriter, r *http.Request) {
		email := emailJSON(r.PathValue("id"), 1767225600000, "run-1", "Re: Invoice INV-2041", nil)
		email["emailFields"] = map[string]any{"invoice": "INV-2041", "total": nil}
		email["replyText"] = "Thanks, paid."
		writeJSON(w, 200, email)
	})
	email, err := api.client().Emails.Get(context.Background(), "m1")
	if err != nil {
		t.Fatal(err)
	}
	if request, _ := api.last(); request.URL.RawQuery != "extracts=true" {
		t.Errorf("query = %q", request.URL.RawQuery)
	}
	if want := map[string]string{"invoice": "INV-2041", "total": ""}; !reflect.DeepEqual(email.EmailFields, want) {
		t.Errorf("fields = %#v", email.EmailFields)
	}
	if email.ReplyText != "Thanks, paid." {
		t.Errorf("reply = %q", email.ReplyText)
	}
	var plain webhookscc.Request
	if err := json.Unmarshal([]byte(`{"id":"m2","kind":"email","emailFields":null,"replyText":null}`), &plain); err != nil {
		t.Fatal(err)
	}
	if plain.EmailFields != nil || plain.ReplyText != "" {
		t.Errorf("request = %+v", plain)
	}
}

func TestEmailsRenderPostsTheFormat(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/requests/{id}/render", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"format": "postmark", "method": "POST",
			"headers": map[string]string{"content-type": "application/json", "user-agent": "webhooks.cc"},
			"body":    `{"Subject":"Hi"}`,
		})
	})
	client := api.client()
	ctx := context.Background()
	rendered, err := client.Emails.Render(ctx, "m1", webhookscc.RenderEmailOptions{Format: webhookscc.FormatPostmark})
	if err != nil {
		t.Fatal(err)
	}
	if request, body := api.last(); request.URL.Path != "/api/requests/m1/render" || body != `{"format":"postmark"}` {
		t.Errorf("sent %s %s", request.URL.Path, body)
	}
	if rendered.Format != webhookscc.FormatPostmark || rendered.Method != "POST" || rendered.Body != `{"Subject":"Hi"}` ||
		rendered.Headers["content-type"] != "application/json" || !strings.Contains(string(rendered.Raw), `"format":"postmark"`) {
		t.Errorf("rendered = %+v", rendered)
	}
	if _, err := client.Emails.Render(ctx, "m1", webhookscc.RenderEmailOptions{Format: webhookscc.FormatMailgun, MailgunSigningKey: "key-acme-test"}); err != nil {
		t.Fatal(err)
	}
	if _, body := api.last(); body != `{"format":"mailgun","mailgunSigningKey":"key-acme-test"}` {
		t.Errorf("body = %s", body)
	}
	for _, opts := range []webhookscc.RenderEmailOptions{{}, {Format: webhookscc.FormatChat}, {Format: "resend"}} {
		if _, err := client.Emails.Render(ctx, "m1", opts); err == nil || !strings.Contains(err.Error(), "unknown inbound format") {
			t.Errorf("%q: err = %v", opts.Format, err)
		}
	}
	if _, err := client.Emails.Render(ctx, "../m1", webhookscc.RenderEmailOptions{Format: webhookscc.FormatJSON}); err == nil {
		t.Error("a bad id should be refused")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if len(api.calls) != 2 {
		t.Errorf("%d requests reached the API", len(api.calls))
	}
}

func TestEmailFieldIssues(t *testing.T) {
	valid := []webhookscc.EmailField{
		{Name: "invoice", From: "subject", Pattern: `(INV-\d+)`},
		{Name: "mailer", From: "header", Header: "X-Mailer", Pattern: ".+"},
	}
	if issues := webhookscc.EmailFieldIssues(valid); issues != nil {
		t.Errorf("issues = %q", issues)
	}
	got := webhookscc.EmailFieldIssues([]webhookscc.EmailField{
		{Name: "invoice", From: "subject", Pattern: "x"},
		{Name: "invoice", From: "body"},
		{Name: strings.Repeat("a", 41), From: "header", Pattern: "x"},
		{Name: "total", From: "text", Header: "X-Total", Pattern: strings.Repeat("x", 301)},
		{Name: "astral", From: "text", Pattern: strings.Repeat("\U0001F600", 151)},
		{Name: "invoice\n", From: "subject", Pattern: "x"},
	})
	want := []string{
		`field 2: the name "invoice" is used twice`,
		"field 2: from must be one of subject, text, html, from, to, header",
		"field 2: pattern is required",
		"field 3: name must be letters, digits and _, start with a letter, at most 40 characters",
		"field 3: header must be a header name",
		`field 4: header is only for from "header"`,
		"field 4: pattern is longer than 300 characters",
		"field 5: pattern is longer than 300 characters",
		"field 6: name must be letters, digits and _, start with a letter, at most 40 characters",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("issues =\n%q\nwant\n%q", got, want)
	}
	if got := webhookscc.EmailFieldIssues(make([]webhookscc.EmailField, 21)); !reflect.DeepEqual(got, []string{"at most 20 fields"}) {
		t.Errorf("issues = %q", got)
	}
}

func TestUpdateSendsEmailFieldsAndRefusesABadList(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("PATCH /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "ep_1", "slug": r.PathValue("slug"), "emailFields": []any{
			map[string]any{"name": "invoice", "from": "subject", "pattern": `(INV-\d+)`},
			map[string]any{"name": "mailer", "from": "header", "header": "X-Mailer", "pattern": ".+"},
		}})
	})
	client := api.client()
	ctx := context.Background()
	fields := []webhookscc.EmailField{
		{Name: "invoice", From: "subject", Pattern: `(INV-\d+)`},
		{Name: "mailer", From: "header", Header: "X-Mailer", Pattern: ".+"},
	}
	endpoint, err := client.Endpoints.Update(ctx, "acme-test", webhookscc.UpdateEndpointOptions{EmailFields: webhookscc.Value(fields)})
	if err != nil {
		t.Fatal(err)
	}
	if _, body := api.last(); body != `{"emailFields":[{"name":"invoice","from":"subject","pattern":"(INV-\\d+)"},`+
		`{"name":"mailer","from":"header","header":"X-Mailer","pattern":".+"}]}` {
		t.Errorf("body = %s", body)
	}
	if !reflect.DeepEqual(endpoint.EmailFields, fields) {
		t.Errorf("fields = %+v", endpoint.EmailFields)
	}
	if _, err := client.Endpoints.Update(ctx, "acme-test", webhookscc.UpdateEndpointOptions{EmailFields: webhookscc.Null[[]webhookscc.EmailField]()}); err != nil {
		t.Fatal(err)
	}
	if _, body := api.last(); body != `{"emailFields":null}` {
		t.Errorf("body = %s", body)
	}
	_, err = client.Endpoints.Update(ctx, "acme-test", webhookscc.UpdateEndpointOptions{
		EmailFields: webhookscc.Value([]webhookscc.EmailField{{Name: "1x", From: "subject", Pattern: "x"}}),
	})
	if err == nil || !strings.Contains(err.Error(), "EmailFields: field 1: name") {
		t.Errorf("err = %v", err)
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if len(api.calls) != 2 {
		t.Errorf("%d requests reached the API", len(api.calls))
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
