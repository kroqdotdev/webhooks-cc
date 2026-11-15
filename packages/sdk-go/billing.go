package webhookscc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ErrCheckoutExpired: a checkout link expired before the person paid. Make
// a new one if they still want it. Returned by BillingService.WaitForCheckout.
var ErrCheckoutExpired = errors.New("webhooks.cc: the checkout link expired before it was paid")

// ErrCheckoutSuperseded: a checkout link was paid, but the purchase was
// undone as a duplicate: the account already had that plan or add-on (or
// what it added to had ended), so its subscription was ended and a refund of
// what it charged is under review (monthly blocks bought twice stay as
// one-time blocks; a second overage subscription charged nothing). It also
// matches ErrCheckoutExpired, so code that handles a link that bought
// nothing handles this one. Returned by
// BillingService.WaitForCheckout.
var ErrCheckoutSuperseded = fmt.Errorf("%w: the account already had what it buys, so the purchase was undone: its subscription was ended and a refund is under review", ErrCheckoutExpired)

// BillingService makes checkout links. Paying stays with the person: an
// agent hands them a ready Polar checkout instead of sending them to find
// the right page, and nothing is charged until they enter their own card on
// Polar's page, so no approval is asked for. At most 5 links an hour and 3
// open at once per account; a team's purchases need the team's owner. Use
// it as client.Billing.
type BillingService struct{ c *Client }

// CheckoutKind names what a checkout link buys.
type CheckoutKind string

const (
	// CheckoutPlan is the Pro or Business plan (Plan, Interval).
	CheckoutPlan CheckoutKind = "plan"
	// CheckoutTeamPlan subscribes a team you own (TeamID, Seats, Plan team or team_business, Interval).
	CheckoutTeamPlan CheckoutKind = "team_plan"
	// CheckoutBlocks is one-time blocks (Blocks, Resource requests or pages): they never expire.
	CheckoutBlocks CheckoutKind = "blocks"
	// CheckoutMonthlyBlocks sets the monthly blocks to Blocks in all, only ever more than now.
	CheckoutMonthlyBlocks CheckoutKind = "monthly_blocks"
	// CheckoutOverage starts overage, with the account's stored maximum or the default.
	CheckoutOverage CheckoutKind = "overage"
)

// CheckoutItem is what a checkout link buys. Leave out what the kind does
// not take; TeamID makes it the team's purchase instead of the account's.
type CheckoutItem struct {
	Kind     CheckoutKind `json:"kind"`
	Plan     string       `json:"plan,omitempty"`
	Interval string       `json:"interval,omitempty"`
	Seats    int          `json:"seats,omitempty"`
	Blocks   int          `json:"blocks,omitempty"`
	Resource string       `json:"resource,omitempty"`
	TeamID   string       `json:"teamId,omitempty"`
}

// CheckoutBought is what a paid link's order or subscription holds, as
// Polar reported it. Amount is in cents, before tax, and nil for an API key
// or agent token (only a browser session reads what was paid). Fields Polar
// did not report are nil.
type CheckoutBought struct {
	Product  string `json:"product"`
	Seats    *int   `json:"seats"`
	Units    *int   `json:"units"`
	Amount   *int   `json:"amount"`
	Currency string `json:"currency"`
}

// CheckoutLink is a checkout link: hand URL to the person, who opens it
// signed in as the account's owner (the team's owner for a team) and pays on
// Polar's page. URL is our page, empty once the link is no longer open;
// Polar's checkout is never in it. Status is "open", "paid", "expired" or
// "superseded" (paid, but undone as a duplicate, a refund under review);
// Summary says in one sentence what it buys. Once paid, Bought is what the
// order or subscription holds and Matches whether that is what the link
// asked for (nil when unknown).
type CheckoutLink struct {
	ID        string          `json:"id"`
	Status    string          `json:"status"`
	Kind      CheckoutKind    `json:"kind"`
	Summary   string          `json:"summary"`
	Item      map[string]any  `json:"item"`
	TeamID    string          `json:"teamId"`
	URL       string          `json:"url"`
	CreatedAt string          `json:"createdAt"`
	ExpiresAt string          `json:"expiresAt"`
	PaidAt    string          `json:"paidAt"`
	Bought    *CheckoutBought `json:"bought"`
	Matches   *bool           `json:"matches"`
}

// CreateCheckout makes a checkout link for something the account, or a team
// you own, can buy. Show the person its URL, which they open signed in as the
// account's owner, then WaitForCheckout.
func (s *BillingService) CreateCheckout(ctx context.Context, item CheckoutItem) (*CheckoutLink, error) {
	var out struct {
		Checkout CheckoutLink `json:"checkout"`
	}
	if err := s.c.api(ctx, http.MethodPost, "/billing/checkouts", nil, item, &out); err != nil {
		return nil, err
	}
	return &out.Checkout, nil
}

// GetCheckout says where a checkout link stands: open, paid, expired or
// superseded, what it buys and, once paid, what was bought.
func (s *BillingService) GetCheckout(ctx context.Context, id string) (*CheckoutLink, error) {
	if err := validateSegment(id, "checkout id"); err != nil {
		return nil, err
	}
	var out struct {
		Checkout CheckoutLink `json:"checkout"`
	}
	if err := s.c.api(ctx, http.MethodGet, "/billing/checkouts/"+id, nil, nil, &out); err != nil {
		return nil, err
	}
	return &out.Checkout, nil
}

// CancelCheckout cancels a checkout link the person has not opened yet, so
// it can no longer be paid, and returns it (now "expired"). One already
// opened has a Polar checkout that cannot be ended: the server answers 409
// (it expires on its own), as it does for a paid link.
func (s *BillingService) CancelCheckout(ctx context.Context, id string) (*CheckoutLink, error) {
	if err := validateSegment(id, "checkout id"); err != nil {
		return nil, err
	}
	var out struct {
		Checkout CheckoutLink `json:"checkout"`
	}
	if err := s.c.api(ctx, http.MethodDelete, "/billing/checkouts/"+id, nil, nil, &out); err != nil {
		return nil, err
	}
	return &out.Checkout, nil
}

// WaitForCheckoutOptions say how long WaitForCheckout waits.
type WaitForCheckoutOptions struct {
	// Timeout gives up after this long (0: until the link expires).
	Timeout time.Duration
	// PollInterval is the time between polls (default 3 seconds, at least 1).
	PollInterval time.Duration
}

// WaitForCheckout waits until the person pays and returns the paid link. It
// returns an error matching ErrCheckoutExpired when the link expires first,
// ErrCheckoutSuperseded when its purchase was undone as a duplicate, and a *TimeoutError when opts.Timeout passes first.
func (s *BillingService) WaitForCheckout(ctx context.Context, id string, opts WaitForCheckoutOptions) (*CheckoutLink, error) {
	if err := validateSegment(id, "checkout id"); err != nil {
		return nil, err
	}
	poll := max(time.Second, durationOr(opts.PollInterval, 3*time.Second))
	var deadline time.Time
	if opts.Timeout > 0 {
		deadline = time.Now().Add(opts.Timeout)
	}
	timedOut := func() error {
		return &TimeoutError{After: opts.Timeout, message: "timed out waiting for the checkout to be paid"}
	}
	for {
		checkout, err := s.GetCheckout(ctx, id)
		if err != nil {
			return nil, err
		}
		switch checkout.Status {
		case "paid":
			return checkout, nil
		case "expired":
			return nil, ErrCheckoutExpired
		case "superseded":
			return nil, ErrCheckoutSuperseded
		}
		wait := poll
		if !deadline.IsZero() {
			left := time.Until(deadline)
			if left <= 0 {
				return nil, timedOut()
			}
			wait = min(wait, left)
		}
		if err := sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
}
