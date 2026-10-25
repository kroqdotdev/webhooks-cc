package webhookscc_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

const destinationID = "4f0e7c1a-0000-4000-8000-000000000010"

func destinationJSON(extra map[string]any) map[string]any {
	destination := map[string]any{
		"id": destinationID, "endpointId": "ep_1", "position": 1, "name": "Invoices", "enabled": true,
		"url": "https://hooks.acme.test/invoices", "hasSecret": true, "http": true, "email": false,
		"format": "template",
		"filter": map[string]any{"logic": "or", "conditions": []map[string]any{
			{"field": "body_path", "path": "type", "op": "eq", "value": "invoice.paid"},
			{"field": "signature", "op": "eq", "value": "verified"},
		}},
		"bodyTemplate":    map[string]any{"invoice": "{{ json.data.object.id }}"},
		"messageTemplate": nil, "headers": []map[string]any{{"name": "x-env", "value": "****"}},
		"appendPath": true, "retrySeconds": 3600, "keepOrder": false, "sentField": nil,
		"throttleSeconds": 60, "delaySeconds": 0, "role": nil,
		"createdAt": 1767225600000, "updatedAt": 1767225660000,
	}
	for key, value := range extra {
		destination[key] = value
	}
	return destination
}

func TestDestinationsCallTheirRoutes(t *testing.T) {
	api := newFakeAPI(t)
	list := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []any{destinationJSON(nil)})
	}
	one := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, destinationJSON(nil))
	}
	secret := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"secret": "whsec_c2VjcmV0"})
	}
	api.handle("GET /api/endpoints/{slug}/destinations", list)
	api.handle("POST /api/endpoints/{slug}/destinations", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 201, destinationJSON(nil))
	})
	api.handle("GET /api/endpoints/{slug}/destinations/{id}", one)
	api.handle("PATCH /api/endpoints/{slug}/destinations/{id}", one)
	api.handle("DELETE /api/endpoints/{slug}/destinations/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"deleted": true})
	})
	api.handle("PUT /api/endpoints/{slug}/destinations/order", list)
	api.handle("GET /api/endpoints/{slug}/destinations/{id}/secret", secret)
	api.handle("POST /api/endpoints/{slug}/destinations/{id}/secret", secret)
	api.handle("POST /api/endpoints/{slug}/destinations/{id}/test", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": 204, "durationMs": 12, "delivered": true})
	})
	api.handle("POST /api/endpoints/{slug}/destinations/preview", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"request": map[string]any{}, "format": "json"})
	})
	client := api.client()
	ctx := context.Background()
	base := "/api/endpoints/acme-test/destinations"
	path := base + "/" + destinationID
	expect := func(method, target, body string) {
		t.Helper()
		request, sent := api.last()
		got := request.URL.Path
		if request.URL.RawQuery != "" {
			got += "?" + request.URL.RawQuery
		}
		if request.Method != method || got != target || sent != body {
			t.Errorf("sent %s %s %s, want %s %s %s", request.Method, got, sent, method, target, body)
		}
	}

	destinations, err := client.Destinations.List(ctx, "acme-test", webhookscc.ListDestinationsOptions{})
	if err != nil || len(destinations) != 1 || destinations[0].ID != destinationID {
		t.Fatalf("List = %+v, %v", destinations, err)
	}
	expect("GET", base, "")
	if _, err := client.Destinations.List(ctx, "acme-test", webhookscc.ListDestinationsOptions{Summary: true}); err != nil {
		t.Fatal(err)
	}
	expect("GET", base+"?summary=true", "")
	if _, err := client.Destinations.Get(ctx, "acme-test", destinationID); err != nil {
		t.Fatal(err)
	}
	expect("GET", path, "")

	value := "test"
	_, err = client.Destinations.Create(ctx, "acme-test", webhookscc.DestinationInput{
		URL:   webhookscc.Value("https://hooks.acme.test/invoices"),
		Email: webhookscc.Value(false),
		Filter: webhookscc.Value(webhookscc.DestinationFilter{
			Conditions: []webhookscc.ResponseRuleCondition{{Field: "kind", Op: "eq", Value: "http"}},
		}),
		Format:       webhookscc.Value(webhookscc.FormatTemplate),
		BodyTemplate: webhookscc.Value(json.RawMessage(`{"invoice": "{{ json.id }}"}`)),
		Headers:      webhookscc.Value([]webhookscc.DestinationHeaderInput{{Name: "x-env", Value: &value}}),
		Retry:        webhookscc.Value(time.Hour),
		Throttle:     webhookscc.Value(time.Minute),
		Delay:        webhookscc.Value(30 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	expect("POST", base, `{"bodyTemplate":{"invoice":"{{ json.id }}"},"delaySeconds":30,"email":false,`+
		`"filter":{"conditions":[{"field":"kind","op":"eq","value":"http"}]},"format":"template",`+
		`"headers":[{"name":"x-env","value":"test"}],"retrySeconds":3600,"throttleSeconds":60,`+
		`"url":"https://hooks.acme.test/invoices"}`)

	_, err = client.Destinations.Update(ctx, "acme-test", destinationID, webhookscc.DestinationInput{
		Name:    webhookscc.Null[string](),
		Enabled: webhookscc.Value(false),
		Headers: webhookscc.Value([]webhookscc.DestinationHeaderInput{{Name: "x-env"}}),
		Retry:   webhookscc.Value(time.Duration(0)),
	})
	if err != nil {
		t.Fatal(err)
	}
	expect("PATCH", path, `{"enabled":false,"headers":[{"name":"x-env","value":null}],"name":null,"retrySeconds":0}`)

	if err := client.Destinations.Delete(ctx, "acme-test", destinationID); err != nil {
		t.Fatal(err)
	}
	expect("DELETE", path, "")
	if _, err := client.Destinations.Reorder(ctx, "acme-test", []string{destinationID, "4f0e7c1a-0000-4000-8000-000000000011"}); err != nil {
		t.Fatal(err)
	}
	expect("PUT", base+"/order", `{"ids":["`+destinationID+`","4f0e7c1a-0000-4000-8000-000000000011"]}`)

	if got, err := client.Destinations.Secret(ctx, "acme-test", destinationID); err != nil || got != "whsec_c2VjcmV0" {
		t.Errorf("Secret = %q, %v", got, err)
	}
	expect("GET", path+"/secret", "")
	if _, err := client.Destinations.RotateSecret(ctx, "acme-test", destinationID); err != nil {
		t.Fatal(err)
	}
	expect("POST", path+"/secret", "")

	result, err := client.Destinations.Test(ctx, "acme-test", destinationID, webhookscc.TestDestinationOptions{})
	if err != nil || result.Status != 204 || !result.Delivered || result.Duration != 12*time.Millisecond {
		t.Errorf("Test = %+v, %v", result, err)
	}
	expect("POST", path+"/test", "{}")
	if _, err := client.Destinations.Test(ctx, "acme-test", destinationID, webhookscc.TestDestinationOptions{Kind: webhookscc.KindEmail, RequestID: "r1"}); err != nil {
		t.Fatal(err)
	}
	expect("POST", path+"/test", `{"kind":"email","requestId":"r1"}`)

	_, err = client.Destinations.Preview(ctx, "acme-test", webhookscc.PreviewDestinationOptions{
		DestinationID: destinationID,
		Destination: webhookscc.DestinationInput{
			Format:     webhookscc.Value(webhookscc.FormatJSON),
			Filter:     webhookscc.Null[webhookscc.DestinationFilter](),
			AppendPath: webhookscc.Value(false),
		},
		RequestID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}
	expect("POST", base+"/preview", `{"destination":{"appendPath":false,"filter":null,"format":"json"},`+
		`"destinationId":"`+destinationID+`","requestId":"r1"}`)
	if _, err := client.Destinations.Preview(ctx, "acme-test", webhookscc.PreviewDestinationOptions{
		Destination: webhookscc.DestinationInput{URL: webhookscc.Value("https://hooks.acme.test/new")},
	}); err != nil {
		t.Fatal(err)
	}
	expect("POST", base+"/preview", `{"destination":{"url":"https://hooks.acme.test/new"}}`)
	if _, err := client.Destinations.Preview(ctx, "acme-test", webhookscc.PreviewDestinationOptions{DestinationID: destinationID}); err != nil {
		t.Fatal(err)
	}
	expect("POST", base+"/preview", `{"destinationId":"`+destinationID+`"}`)
}

func TestDestinationsAreParsed(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/endpoints/{slug}/destinations", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []any{destinationJSON(map[string]any{
			"summary": map[string]any{"last24h": map[string]int{"delivered": 3, "failed": 1, "skipped": 2}, "pending": 4},
		})})
	})
	destinations, err := api.client().Destinations.List(context.Background(), "acme-test", webhookscc.ListDestinationsOptions{Summary: true})
	if err != nil || len(destinations) != 1 {
		t.Fatalf("List = %+v, %v", destinations, err)
	}
	d := destinations[0]
	if d.ID != destinationID || d.Position != 1 || d.Name != "Invoices" || !d.Enabled || !d.HasSecret || !d.HTTP || d.Email {
		t.Errorf("destination = %+v", d)
	}
	if d.Format != webhookscc.FormatTemplate || d.MessageTemplate != "" || d.SentField != "" || d.Role != "" {
		t.Errorf("destination = %+v", d)
	}
	if d.Filter == nil || d.Filter.Logic != "or" || len(d.Filter.Conditions) != 2 ||
		d.Filter.Conditions[0] != (webhookscc.ResponseRuleCondition{Field: "body_path", Path: "type", Op: "eq", Value: "invoice.paid"}) {
		t.Errorf("filter = %+v", d.Filter)
	}
	if string(d.BodyTemplate) != `{"invoice":"{{ json.data.object.id }}"}` {
		t.Errorf("body template = %s", d.BodyTemplate)
	}
	if len(d.Headers) != 1 || d.Headers[0] != (webhookscc.DestinationHeader{Name: "x-env", Value: "****"}) {
		t.Errorf("headers = %+v", d.Headers)
	}
	if !d.AppendPath || d.KeepOrder || d.Retry != time.Hour || d.Throttle != time.Minute || d.Delay != 0 {
		t.Errorf("destination = %+v", d)
	}
	if d.CreatedAt.UnixMilli() != 1767225600000 || d.UpdatedAt.UnixMilli() != 1767225660000 {
		t.Errorf("times = %v, %v", d.CreatedAt, d.UpdatedAt)
	}
	if d.Summary == nil || d.Summary.Last24h != (webhookscc.DeliveryCounts{Delivered: 3, Failed: 1, Skipped: 2}) || d.Summary.Pending != 4 {
		t.Errorf("summary = %+v", d.Summary)
	}
	if !strings.Contains(string(d.Raw), `"endpointId":"ep_1"`) {
		t.Errorf("raw = %s", d.Raw)
	}

	var plain webhookscc.Destination
	data, _ := json.Marshal(destinationJSON(map[string]any{"filter": nil, "bodyTemplate": nil, "role": "forward"}))
	if err := json.Unmarshal(data, &plain); err != nil {
		t.Fatal(err)
	}
	if plain.Filter != nil || plain.BodyTemplate != nil || plain.Summary != nil || plain.Role != "forward" {
		t.Errorf("destination = %+v", plain)
	}
}

func TestDestinationPreviewAndTestResultsAreParsed(t *testing.T) {
	var preview webhookscc.DestinationPreview
	err := json.Unmarshal([]byte(`{
		"request": {"id": null, "kind": "email", "method": "EMAIL", "path": "acme-test@mailhooks.cc",
			"subject": "Invoice 42", "receivedAt": 1767225600000, "sample": true},
		"takesKind": true, "filterPasses": false, "format": "template",
		"delivery": {"method": "POST", "url": "https://hooks.acme.test/invoices",
			"headers": {"content-type": "application/json"}, "body": null, "bodyBase64": "/w=="},
		"error": null
	}`), &preview)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Request.ID != "" || !preview.Request.Sample || preview.Request.Kind != webhookscc.KindEmail ||
		preview.Request.Subject != "Invoice 42" || preview.Request.ReceivedAt.UnixMilli() != 1767225600000 {
		t.Errorf("request = %+v", preview.Request)
	}
	if !preview.TakesKind || preview.FilterPasses || preview.Format != webhookscc.FormatTemplate || preview.Error != "" {
		t.Errorf("preview = %+v", preview)
	}
	if preview.Delivery == nil || preview.Delivery.Headers["content-type"] != "application/json" ||
		preview.Delivery.Body != "" || string(preview.Delivery.BodyBytes()) != "\xff" {
		t.Errorf("delivery = %+v", preview.Delivery)
	}

	var unsent webhookscc.DestinationPreview
	if err := json.Unmarshal([]byte(`{"request": {}, "format": "template", "delivery": null, "error": "json.nope is missing"}`), &unsent); err != nil {
		t.Fatal(err)
	}
	if unsent.Delivery != nil || unsent.Error != "json.nope is missing" {
		t.Errorf("preview = %+v", unsent)
	}

	var result webhookscc.DestinationTestResult
	err = json.Unmarshal([]byte(`{
		"status": null, "durationMs": 10000, "excerpt": null, "error": "timed out", "delivered": false,
		"url": "https://hooks.acme.test/invoices", "sample": false, "kind": "http", "format": "as_received",
		"target": "hooks.acme.test/invoices", "filterPasses": true,
		"request": {"id": "r1", "method": "POST", "path": "/stripe", "subject": null, "receivedAt": 1767225600000},
		"sender": {"at": 1767225599950, "source": "webhook-timestamp", "wholeSeconds": true}
	}`), &result)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 0 || result.Error != "timed out" || result.Delivered || result.Duration != 10*time.Second || !result.FilterPasses {
		t.Errorf("result = %+v", result)
	}
	if result.Kind != webhookscc.KindHTTP || result.Format != webhookscc.FormatAsReceived || result.Target != "hooks.acme.test/invoices" {
		t.Errorf("result = %+v", result)
	}
	if result.Request.ID != "r1" || result.Request.Kind != webhookscc.KindHTTP || result.Request.Sample || result.Request.Path != "/stripe" {
		t.Errorf("request = %+v", result.Request)
	}
	if result.Sender == nil || result.Sender.At.UnixMilli() != 1767225599950 || !result.Sender.WholeSeconds {
		t.Errorf("sender = %+v", result.Sender)
	}
}

func TestDestinationInputIsCheckedBeforeSending(t *testing.T) {
	api := newFakeAPI(t)
	client := api.client()
	ctx := context.Background()
	checks := map[string]func() error{
		"no URL": func() error {
			_, err := client.Destinations.Create(ctx, "acme-test", webhookscc.DestinationInput{})
			return err
		},
		"a cleared URL": func() error {
			_, err := client.Destinations.Update(ctx, "acme-test", destinationID, webhookscc.DestinationInput{URL: webhookscc.Null[string]()})
			return err
		},
		"a bad logic": func() error {
			_, err := client.Destinations.Update(ctx, "acme-test", destinationID, webhookscc.DestinationInput{
				Filter: webhookscc.Value(webhookscc.DestinationFilter{Logic: "xor"}),
			})
			return err
		},
		"a fraction of a second": func() error {
			_, err := client.Destinations.Update(ctx, "acme-test", destinationID, webhookscc.DestinationInput{Delay: webhookscc.Value(1500 * time.Millisecond)})
			return err
		},
		"a negative throttle": func() error {
			_, err := client.Destinations.Preview(ctx, "acme-test", webhookscc.PreviewDestinationOptions{
				Destination: webhookscc.DestinationInput{Throttle: webhookscc.Value(-time.Second)},
			})
			return err
		},
		"an invalid destination ID": func() error {
			_, err := client.Destinations.Get(ctx, "acme-test", "../secret")
			return err
		},
		"an invalid slug": func() error {
			_, err := client.Destinations.List(ctx, "../admin", webhookscc.ListDestinationsOptions{})
			return err
		},
	}
	for name, check := range checks {
		if err := check(); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if len(api.calls) != 0 {
		t.Errorf("%d requests reached the API", len(api.calls))
	}
}
