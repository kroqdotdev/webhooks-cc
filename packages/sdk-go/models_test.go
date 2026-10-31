package webhookscc_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

// What json.Marshal writes, the SDK reads back the same.
func TestModelsRoundTripThroughJSON(t *testing.T) {
	verified := true
	request := webhookscc.Request{
		ID: "r1", EndpointID: "ep_1", Slug: "acme-test", Method: "EMAIL", Path: "acme-test+run@mailhooks.cc",
		Headers: webhookscc.Headers{"X-A": "1"}, Body: "hi", QueryParams: map[string]string{"q": "1"},
		IP: "203.0.113.7", Size: 2, ReceivedAt: time.UnixMilli(1767225600123), ContentType: "text/plain",
		BodyRaw: "aGk=", SignatureVerified: &verified, SigningProvider: "stripe", Kind: webhookscc.KindEmail,
		Email: &webhookscc.EmailCapture{
			Subject: "Hi", From: []webhookscc.EmailAddress{{Name: "Acme", Address: "a@acme.test"}},
			To: []webhookscc.EmailAddress{{Address: "b@example.com"}}, Tag: "run", Text: "code 123",
			Attachments: []webhookscc.EmailAttachment{{Filename: "a.txt", ContentType: "text/plain", Size: 3}},
			Auth:        json.RawMessage(`{"spf":"pass"}`), Truncated: map[string]bool{"html": true},
		},
		Extracts:    &webhookscc.EmailExtracts{Codes: []string{"123"}, Links: []webhookscc.ExtractedLink{{URL: "https://acme.test/x", Action: true}}},
		EmailFields: map[string]string{"invoice": "INV-2041", "total": ""},
		ReplyText:   "Thanks, paid.",
	}
	endpoint := webhookscc.Endpoint{
		ID: "ep_1", Slug: "acme-test", Name: "Acme", CreatedAt: time.UnixMilli(1767225600000),
		ExpiresAt: time.UnixMilli(1767229200000), IsEphemeral: true,
		MockResponse:  &webhookscc.MockResponse{Status: 201, Body: "ok", Headers: map[string]string{"x": "y"}, Delay: 250 * time.Millisecond},
		ResponseRules: []webhookscc.ResponseRule{{Conditions: []webhookscc.ResponseRuleCondition{{Field: "method", Op: "eq", Value: ""}}, Response: webhookscc.MockResponse{Status: 200, Headers: map[string]string{}}}},
		SharedWith:    []webhookscc.TeamShare{{TeamID: "t1", TeamName: "Acme"}},
		EmailFields: []webhookscc.EmailField{
			{Name: "invoice", From: "subject", Pattern: `(INV-\d+)`},
			{Name: "mailer", From: "header", Header: "X-Mailer", Pattern: ".+"},
		},
	}
	usage := webhookscc.Usage{Used: 1, Limit: 100, Remaining: 99, Plan: "free"}
	preview := webhookscc.ResponsePreview{
		Rule:                &webhookscc.PreviewRule{Index: 2, Name: "pings"},
		Response:            &webhookscc.MockResponse{Status: 202, Body: "evt_1", Headers: map[string]string{"x": "y"}, Delay: time.Second},
		UnknownPlaceholders: []string{"json.nope"},
		Request:             webhookscc.PreviewRequest{ID: "r1", Method: "POST", Path: "/hooks", ReceivedAt: time.UnixMilli(1767225600123)},
	}
	sample := webhookscc.ResponsePreview{
		Rule:    &webhookscc.PreviewRule{},
		Email:   true,
		Request: webhookscc.PreviewRequest{Method: "EMAIL", Path: "acme-test@mailhooks.cc", Sample: true},
	}

	destination := webhookscc.Destination{
		ID: "d1", Position: 2, Name: "Invoices", Enabled: true, URL: "https://hooks.acme.test/invoices",
		HasSecret: true, HasMailgunSigningKey: true, HTTP: true, Format: webhookscc.FormatTemplate,
		Filter: &webhookscc.DestinationFilter{Logic: "or", Conditions: []webhookscc.ResponseRuleCondition{
			{Field: "email", Name: "subject", Op: "contains", Value: "invoice"},
		}},
		BodyTemplate: json.RawMessage(`{"invoice":"{{ json.id }}"}`), MessageTemplate: "{{ method }} {{ path }}",
		Headers:    []webhookscc.DestinationHeader{{Name: "x-env", Value: "****"}},
		AppendPath: true, Retry: time.Hour, KeepOrder: true, SentField: "data.created", Throttle: time.Minute,
		Delay: 30 * time.Second, Attachments: webhookscc.AttachmentsInline, Role: "forward", CreatedAt: time.UnixMilli(1767225600000), UpdatedAt: time.UnixMilli(1767225660000),
		Summary: &webhookscc.DestinationSummary{Last24h: webhookscc.DeliveryCounts{Delivered: 3, Failed: 1, Skipped: 2}, Pending: 4},
	}
	destinationPreview := webhookscc.DestinationPreview{
		Request: webhookscc.DestinationRequest{
			ID: "r1", Kind: webhookscc.KindEmail, Method: "EMAIL", Path: "acme-test@mailhooks.cc", Subject: "Hi",
			ReceivedAt: time.UnixMilli(1767225600123),
		},
		TakesKind: true, FilterPasses: true, Format: webhookscc.FormatJSON,
		Delivery: &webhookscc.PreviewedDelivery{Method: "POST", URL: "https://hooks.acme.test/invoices", Headers: map[string]string{"a": "b"}, Body: "{}"},
	}
	unsent := webhookscc.DestinationPreview{
		Request: webhookscc.DestinationRequest{Kind: webhookscc.KindHTTP, Method: "POST", Path: "/", Sample: true},
		Format:  webhookscc.FormatTemplate, Error: "json.nope is missing",
	}
	testResult := webhookscc.DestinationTestResult{
		Status: 204, Duration: 12 * time.Millisecond, Excerpt: "ok", Delivered: true, FilterPasses: true,
		Kind: webhookscc.KindHTTP, Format: webhookscc.FormatAsReceived, URL: "https://hooks.acme.test/invoices/x",
		Target:  "hooks.acme.test/invoices/x",
		Request: webhookscc.DestinationRequest{ID: "r1", Kind: webhookscc.KindHTTP, Method: "POST", Path: "/x", ReceivedAt: time.UnixMilli(1767225600123)},
		Sender:  &webhookscc.SenderTime{At: time.UnixMilli(1767225600000), Source: "webhook-timestamp", WholeSeconds: true},
	}
	rendered := webhookscc.RenderedEmail{
		Format: webhookscc.FormatMailgun, Method: "POST", Body: "recipient=acme-test%40mailhooks.cc",
		Headers: map[string]string{"content-type": "application/x-www-form-urlencoded", "user-agent": "webhooks.cc"},
	}
	failedTest := webhookscc.DestinationTestResult{
		Duration: 10 * time.Second, Error: "timed out", Sample: true,
		Request: webhookscc.DestinationRequest{Method: "POST", Path: "/", Sample: true},
	}

	layoutsPreview := webhookscc.LayoutsPreview{
		Problems: []string{"layouts[1]: name is required"}, LayoutsCap: 2,
		Request: &webhookscc.LayoutsPreviewRequest{ID: "r1", Subject: "Order 1", ReceivedAt: time.UnixMilli(1767225600123)},
		Parsed: &webhookscc.ParsedEmail{
			Status: "matched", Layout: &webhookscc.ParsedLayout{ID: "orders", Name: "Orders"},
			Fields: map[string]string{"order": "1"}, LineItems: []map[string]string{{"sku": "A-1"}},
			LineItemColumns: []string{"sku"}, Pages: 1, Truncated: true, Partial: true,
			Attachments: []webhookscc.ParsedAttachment{{Index: 0, Filename: "o.csv", Format: "csv", Pages: 1,
				Sheets: []webhookscc.ParsedSheet{{Rows: [][]string{{"sku"}, {"A-1"}}, RowCount: 2}}}},
		},
	}

	for _, value := range []any{&request, &endpoint, &usage, &preview, &sample, &destination, &destinationPreview, &unsent, &testResult, &failedTest, &rendered, &layoutsPreview} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		back := reflect.New(reflect.TypeOf(value).Elem())
		if err := json.Unmarshal(data, back.Interface()); err != nil {
			t.Fatal(err)
		}
		clearRaw(back.Elem())
		if !reflect.DeepEqual(reflect.ValueOf(value).Elem().Interface(), back.Elem().Interface()) {
			t.Errorf("%T did not round-trip:\n%s\n%+v", value, data, back.Elem().Interface())
		}
	}
}

// clearRaw zeroes the Raw fields UnmarshalJSON fills, recursively.
func clearRaw(v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer:
		if !v.IsNil() {
			clearRaw(v.Elem())
		}
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).Name == "Raw" {
				v.Field(i).SetZero()
				continue
			}
			clearRaw(v.Field(i))
		}
	}
}
