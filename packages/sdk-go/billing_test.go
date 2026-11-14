package webhookscc_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

const checkoutID = "11111111-2222-4333-8444-555555555555"

func checkoutAnswer(status string) map[string]any {
	link := map[string]any{
		"id":        checkoutID,
		"status":    status,
		"kind":      "plan",
		"summary":   "The Pro plan, billed monthly.",
		"item":      map[string]any{"kind": "plan", "plan": "pro", "interval": "month"},
		"teamId":    nil,
		"url":       nil,
		"createdAt": "2026-11-14T12:00:00.000Z",
		"expiresAt": "2026-11-14T13:00:00.000Z",
		"paidAt":    nil,
	}
	if status == "open" {
		link["url"] = "https://polar.sh/checkout/polar_c_x"
	}
	return map[string]any{"checkout": link}
}

func TestCreateCheckoutSendsOnlyWhatIsSet(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/billing/checkouts", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(checkoutAnswer("open"))
	})
	link, err := api.client().Billing.CreateCheckout(context.Background(), webhookscc.CheckoutItem{
		Kind: webhookscc.CheckoutPlan, Plan: "pro",
	})
	if err != nil {
		t.Fatal(err)
	}
	if link.URL != "https://polar.sh/checkout/polar_c_x" || link.Status != "open" || link.TeamID != "" {
		t.Fatalf("link = %+v", link)
	}
	_, body := api.last()
	if body != `{"kind":"plan","plan":"pro"}` {
		t.Fatalf("body = %s", body)
	}
}

func TestWaitForCheckout(t *testing.T) {
	api := newFakeAPI(t)
	var polls atomic.Int32
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		status := "open"
		if polls.Add(1) > 1 {
			status = "paid"
		}
		_ = json.NewEncoder(w).Encode(checkoutAnswer(status))
	})
	link, err := api.client().Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{PollInterval: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if link.Status != "paid" || link.URL != "" || polls.Load() != 2 {
		t.Fatalf("link = %+v after %d polls", link, polls.Load())
	}
}

func TestWaitForCheckoutEnds(t *testing.T) {
	api := newFakeAPI(t)
	status := "expired"
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(checkoutAnswer(status))
	})
	client := api.client()
	if _, err := client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{}); !errors.Is(err, webhookscc.ErrCheckoutExpired) {
		t.Fatalf("err = %v, want ErrCheckoutExpired", err)
	}
	status = "open"
	_, err := client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{Timeout: time.Millisecond})
	if !errors.Is(err, webhookscc.ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if _, err := client.Billing.GetCheckout(context.Background(), "../approvals"); err == nil {
		t.Fatal("an id that is not a segment was sent")
	}
}
