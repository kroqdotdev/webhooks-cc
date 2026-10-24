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
		Extracts: &webhookscc.EmailExtracts{Codes: []string{"123"}, Links: []webhookscc.ExtractedLink{{URL: "https://acme.test/x", Action: true}}},
	}
	endpoint := webhookscc.Endpoint{
		ID: "ep_1", Slug: "acme-test", Name: "Acme", CreatedAt: time.UnixMilli(1767225600000),
		ExpiresAt: time.UnixMilli(1767229200000), IsEphemeral: true,
		MockResponse:  &webhookscc.MockResponse{Status: 201, Body: "ok", Headers: map[string]string{"x": "y"}, Delay: 250 * time.Millisecond},
		ResponseRules: []webhookscc.ResponseRule{{Conditions: []webhookscc.ResponseRuleCondition{{Field: "method", Op: "eq", Value: ""}}, Response: webhookscc.MockResponse{Status: 200, Headers: map[string]string{}}}},
		SharedWith:    []webhookscc.TeamShare{{TeamID: "t1", TeamName: "Acme"}},
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

	for _, value := range []any{&request, &endpoint, &usage, &preview, &sample} {
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
