package webhookscc_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	webhookscc "webhooks.cc/go"
)

var ordersLayout = webhookscc.Layout{
	ID:   "orders",
	Name: "Orders",
	Match: &webhookscc.DestinationFilter{Conditions: []webhookscc.ResponseRuleCondition{
		{Field: "email", Name: "subject", Op: "contains", Value: "Order"},
	}},
	Fields:    []webhookscc.EmailField{{Name: "order", From: "subject", Pattern: `Order (\d+)`}},
	LineItems: &webhookscc.LineItemsSpec{From: "attachment", Attachment: "*.csv"},
}

func TestUpdateSendsRetentionAndLayouts(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("PATCH /api/endpoints/{slug}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"id": "ep_1", "slug": "acme", "retentionDays": 3, "retentionCapDays": 31,
			"deleteAfterDelivery": false, "layoutsCap": 2,
			"layouts": []any{map[string]any{"id": "orders", "name": "Orders", "parseAttachments": true}},
		})
	})
	endpoint, err := api.client().Endpoints.Update(context.Background(), "acme", webhookscc.UpdateEndpointOptions{
		RetentionDays: webhookscc.Value(3),
		Layouts:       webhookscc.Value([]webhookscc.Layout{ordersLayout}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, body := api.last()
	var sent map[string]any
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["retentionDays"] != float64(3) {
		t.Errorf("retentionDays = %v", sent["retentionDays"])
	}
	layouts := sent["layouts"].([]any)
	first := layouts[0].(map[string]any)
	if first["id"] != "orders" || first["lineItems"].(map[string]any)["attachment"] != "*.csv" {
		t.Errorf("layouts = %s", body)
	}
	if endpoint.RetentionDays == nil || *endpoint.RetentionDays != 3 || endpoint.RetentionCapDays != 31 {
		t.Errorf("retention = %v, %d", endpoint.RetentionDays, endpoint.RetentionCapDays)
	}
	if len(endpoint.Layouts) != 1 || !endpoint.Layouts[0].ParseAttachments || endpoint.LayoutsCap != 2 {
		t.Errorf("layouts = %+v, cap %d", endpoint.Layouts, endpoint.LayoutsCap)
	}
}

func TestPreviewLayoutsAndParsedRequests(t *testing.T) {
	parsed := map[string]any{
		"status":          "matched",
		"layout":          map[string]any{"id": "orders", "name": "Orders"},
		"fields":          map[string]any{"order": "1", "total": nil},
		"lineItems":       []any{map[string]any{"sku": "A-1", "qty": "2"}},
		"lineItemColumns": []any{"sku", "qty"},
		"attachments": []any{
			map[string]any{"index": 0, "filename": "o.csv", "format": "csv", "pages": 1,
				"sheets": []any{map[string]any{"name": nil, "rows": []any{[]any{"sku"}, []any{"A-1"}}, "rowCount": 2, "truncated": false}}},
			map[string]any{"index": 1, "filename": "b.pdf", "format": "pdf", "pages": 0, "error": "limit"},
		},
		"pages":     1,
		"truncated": true,
	}
	api := newFakeAPI(t)
	api.handle("POST /api/endpoints/{slug}/layouts/preview", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"problems": []any{}, "layoutsCap": 2,
			"request": map[string]any{"id": "req_1", "subject": "Order 1", "receivedAt": 1}, "parsed": parsed,
		})
	})
	api.handle("GET /api/requests/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"id": "req_1", "endpointId": "ep_1", "method": "EMAIL", "path": "acme@mailhooks.cc",
			"headers": map[string]any{}, "queryParams": map[string]any{}, "ip": "192.0.2.1", "size": 1,
			"receivedAt": 1, "kind": "email",
			"email": map[string]any{"subject": "Order 1", "stored": true,
				"attachments": []any{map[string]any{"filename": "o.csv", "contentType": "text/csv", "size": 3, "url": "https://x/a"}}},
			"parsed": parsed,
		})
	})
	client := api.client()
	ctx := context.Background()

	preview, err := client.Endpoints.PreviewLayouts(ctx, "acme", webhookscc.PreviewLayoutsOptions{RequestID: "req_1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, body := api.last(); body != `{"requestId":"req_1"}` {
		t.Errorf("body = %s", body)
	}
	if preview.Request == nil || preview.Request.ID != "req_1" || preview.Parsed == nil {
		t.Fatalf("preview = %+v", preview)
	}
	if preview.Request.Subject != "Order 1" || preview.Request.ReceivedAt.UnixMilli() != 1 {
		t.Errorf("request = %+v", preview.Request)
	}
	p := preview.Parsed
	if p.Layout.ID != "orders" || p.Fields["order"] != "1" || p.Fields["total"] != "" {
		t.Errorf("fields = %+v", p.Fields)
	}
	if len(p.LineItemColumns) != 2 || p.LineItemColumns[0] != "sku" || p.LineItems[0]["qty"] != "2" {
		t.Errorf("line items = %+v %+v", p.LineItemColumns, p.LineItems)
	}
	if p.Attachments[0].Sheets[0].RowCount != 2 || p.Attachments[1].Error != "limit" {
		t.Errorf("attachments = %+v", p.Attachments)
	}
	if !p.Truncated || p.Partial {
		t.Errorf("truncated = %v, partial = %v", p.Truncated, p.Partial)
	}

	request, err := client.Requests.Get(ctx, "req_1")
	if err != nil {
		t.Fatal(err)
	}
	if request.Parsed == nil || request.Parsed.Status != "matched" {
		t.Errorf("parsed = %+v", request.Parsed)
	}
	if !request.Email.Stored || request.Email.Attachments[0].URL != "https://x/a" {
		t.Errorf("email = %+v", request.Email)
	}
	// What MarshalJSON writes, UnmarshalJSON reads back.
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var again webhookscc.Request
	if err := json.Unmarshal(data, &again); err != nil {
		t.Fatal(err)
	}
	if again.Parsed == nil || again.Parsed.Pages != 1 || !again.Parsed.Truncated || !again.Email.Stored {
		t.Errorf("round trip = %+v", again.Parsed)
	}
}
