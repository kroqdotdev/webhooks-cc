package webhookscc_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
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
		"opened":    status != "open",
		"createdAt": "2026-11-14T12:00:00.000Z",
		// Expired a minute ago: a late payment may still land.
		"expiresAt": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano),
		"paidAt":    nil,
		"bought":    nil,
		"matches":   nil,
	}
	if status == "open" {
		link["url"] = "https://webhooks.cc/checkout/" + checkoutID
	}
	if status == "paid" {
		link["bought"] = map[string]any{"product": "prod_teams", "seats": 5, "units": nil, "amount": 3500, "currency": "usd"}
		link["matches"] = false
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
	// Our page, opened signed in; never Polar's checkout.
	if link.URL != "https://webhooks.cc/checkout/"+checkoutID || link.Status != "open" || link.TeamID != "" || link.Bought != nil || link.Matches != nil {
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
	if link.Bought == nil || link.Bought.Seats == nil || *link.Bought.Seats != 5 || link.Bought.Units != nil || link.Matches == nil || *link.Matches {
		t.Fatalf("bought = %+v, matches = %v", link.Bought, link.Matches)
	}
}

// A payment Polar confirms late can still turn an expired link paid.
func TestWaitForCheckoutKeepsPollingAnExpiredLink(t *testing.T) {
	api := newFakeAPI(t)
	var polls atomic.Int32
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		status := "expired"
		if polls.Add(1) > 1 {
			status = "paid"
		}
		_ = json.NewEncoder(w).Encode(checkoutAnswer(status))
	})
	link, err := api.client().Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{PollInterval: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if link.Status != "paid" || polls.Load() != 2 {
		t.Fatalf("link = %+v after %d polls", link, polls.Load())
	}
}

// An expired link no late payment can turn paid ends the wait at once.
func TestWaitForCheckoutEndsAtOnceWhenNoLatePaymentCanLand(t *testing.T) {
	for name, change := range map[string]func(map[string]any){
		"never opened": func(link map[string]any) { link["opened"] = false },
		"expired an hour ago": func(link map[string]any) {
			link["expiresAt"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
		},
	} {
		t.Run(name, func(t *testing.T) {
			api := newFakeAPI(t)
			var polls atomic.Int32
			api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				answer := checkoutAnswer("expired")
				if polls.Add(1) > 1 {
					answer = checkoutAnswer("paid")
				}
				change(answer["checkout"].(map[string]any))
				_ = json.NewEncoder(w).Encode(answer)
			})
			_, err := api.client().Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{PollInterval: time.Second})
			if !errors.Is(err, webhookscc.ErrCheckoutExpired) || polls.Load() != 1 {
				t.Fatalf("err = %v after %d polls, want ErrCheckoutExpired after 1", err, polls.Load())
			}
		})
	}
}

// A poll answering paid after the wait's deadline never makes the wait succeed.
func TestWaitForCheckoutBoundsEachPollByItsDeadline(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(5 * time.Second):
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(checkoutAnswer("paid"))
	})
	started := time.Now()
	link, err := api.client().Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{Timeout: 300 * time.Millisecond})
	var timeout *webhookscc.TimeoutError
	if !errors.As(err, &timeout) || link != nil {
		t.Fatalf("link = %+v, err = %v, want a *TimeoutError", link, err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("the wait took %v past its 300ms timeout", elapsed)
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
	if _, err := client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{ExpiredGrace: -1}); !errors.Is(err, webhookscc.ErrCheckoutExpired) {
		t.Fatalf("err = %v, want ErrCheckoutExpired", err)
	}
	// A wait that runs out while the link reads expired says it expired.
	if _, err := client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{Timeout: 1500 * time.Millisecond, PollInterval: time.Second}); !errors.Is(err, webhookscc.ErrCheckoutExpired) {
		t.Fatalf("err = %v, want ErrCheckoutExpired", err)
	}
	status = "superseded"
	_, superseded := client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{})
	if !errors.Is(superseded, webhookscc.ErrCheckoutSuperseded) || !errors.Is(superseded, webhookscc.ErrCheckoutExpired) {
		t.Fatalf("err = %v, want ErrCheckoutSuperseded, which is also ErrCheckoutExpired", superseded)
	}
	// It never promises a refund: refunds are reviewed.
	if msg := superseded.Error(); !strings.Contains(msg, "a refund is under review") || strings.Contains(msg, "goes back") {
		t.Fatalf("err = %q, want the refund under review", msg)
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

func TestWaitForCheckoutKeepsPollingThroughFailuresForNow(t *testing.T) {
	api := newFakeAPI(t)
	var polls atomic.Int32
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		switch polls.Add(1) {
		case 1:
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "busy"})
		case 2:
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "slow down"})
		case 3:
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "bad gateway"})
		default:
			writeJSON(w, http.StatusOK, checkoutAnswer("paid"))
		}
	})
	// No retries of the client's own: the wait itself asks again.
	client := api.client(webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 1}))
	link, err := client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{PollInterval: time.Second, Timeout: 10 * time.Second})
	if err != nil || link.Status != "paid" {
		t.Fatalf("link = %+v, err = %v", link, err)
	}
	if n := polls.Load(); n != 4 {
		t.Fatalf("polls = %d, want 4", n)
	}
}

func TestWaitForCheckoutKeepsPollingThroughTheNetwork(t *testing.T) {
	api := newFakeAPI(t)
	url := api.server.URL
	api.server.Close() // every poll fails to connect
	client, err := webhookscc.New(webhookscc.WithAPIKey("whcc_test"), webhookscc.WithBaseURL(url+"/"),
		webhookscc.WithRetry(webhookscc.RetryOptions{MaxAttempts: 1}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{PollInterval: time.Second, Timeout: 1500 * time.Millisecond})
	if !errors.Is(err, webhookscc.ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout once the deadline passed", err)
	}
}

func TestWaitForCheckoutEndsOnARefusal(t *testing.T) {
	api := newFakeAPI(t)
	var polls atomic.Int32
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		polls.Add(1)
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Checkout link not found"})
	})
	_, err := api.client().Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{PollInterval: time.Second, Timeout: 10 * time.Second})
	if !errors.Is(err, webhookscc.ErrNotFound) || polls.Load() != 1 {
		t.Fatalf("err = %v after %d polls, want ErrNotFound at once", err, polls.Load())
	}
}

func TestWaitForCheckoutSaysAnUnsettledLinkMayHaveBeenPaid(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		answer := checkoutAnswer("expired")
		link := answer["checkout"].(map[string]any)
		link["expiredReason"] = "unsettled"
		// A day past its expiry: no more polling.
		link["expiresAt"] = time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)
		writeJSON(w, http.StatusOK, answer)
	})
	_, err := api.client().Billing.WaitForCheckout(context.Background(), checkoutID, webhookscc.WaitForCheckoutOptions{})
	if !errors.Is(err, webhookscc.ErrCheckoutUnsettled) || !errors.Is(err, webhookscc.ErrCheckoutExpired) {
		t.Fatalf("err = %v, want ErrCheckoutUnsettled, which is also ErrCheckoutExpired", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "if the person paid, it is still applied") || !strings.Contains(msg, "has been alerted") {
		t.Fatalf("err = %q", msg)
	}
	link, err := api.client().Billing.GetCheckout(context.Background(), checkoutID)
	if err != nil || link.ExpiredReason != "unsettled" {
		t.Fatalf("link = %+v, err = %v", link, err)
	}
}

func TestCancelCheckout(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("DELETE /api/billing/checkouts/"+checkoutID, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(checkoutAnswer("expired"))
	})
	client := api.client()
	link, err := client.Billing.CancelCheckout(context.Background(), checkoutID)
	if err != nil {
		t.Fatal(err)
	}
	if link.Status != "expired" || link.URL != "" {
		t.Fatalf("link = %+v", link)
	}
	if _, err := client.Billing.CancelCheckout(context.Background(), "../approvals"); err == nil {
		t.Fatal("an id that is not a segment was sent")
	}
}
