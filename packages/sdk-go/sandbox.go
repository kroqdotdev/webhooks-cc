package webhookscc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"webhooks.cc/go/agent"
	"webhooks.cc/go/internal/agentfile"
)

const (
	// sandboxRequestsPerEndpoint is what one sandbox endpoint captures
	// before it answers 429, as on the server.
	sandboxRequestsPerEndpoint = 25
	// sandboxMaxList is the most requests a sandbox list returns.
	sandboxMaxList = 100
	// claimGrace is how long past a code's expiry a wait without a deadline
	// keeps polling, for clock skew; the server answers expired_token by then.
	claimGrace = time.Minute
)

// Sandbox is webhook capture without an account, for AI agents (auth.md
// v0.6): up to 3 endpoints, 25 captured requests each and 100 in all, gone
// 24 hours after registration. Sandbox endpoints only capture: no mock
// responses, notifications, signature checks, email or forwarding.
//
//	sandbox, err := webhookscc.NewSandbox(ctx, webhookscc.WithClientName("my-agent"))
//	if err != nil {
//		return err
//	}
//	endpoint, err := sandbox.Endpoints.Create(ctx)
//	if err != nil {
//		return err
//	}
//	triggerWebhook(endpoint.URL)
//	request, err := sandbox.Requests.WaitFor(ctx, endpoint.Slug, webhookscc.WaitOptions{Timeout: time.Minute})
//
// Claim and WaitForClaim connect the agent to a human's account and return
// a Client for it. A Sandbox is safe for concurrent use.
type Sandbox struct {
	// Endpoints creates, lists, reads and deletes sandbox endpoints.
	Endpoints *SandboxEndpointsService
	// Requests lists, reads and waits for what sandbox endpoints captured.
	Requests *SandboxRequestsService

	opts           []Option
	c              *Client
	registrationID string
	expiresAt      time.Time

	mu sync.Mutex
	// claimToken is this process's own registration's; "" for a sandbox
	// loaded from the credential file, which never holds one.
	claimToken string
	pending    *pendingClaim
	closed     bool
}

// pendingClaim is the claim Claim started and WaitForClaim waits for.
type pendingClaim struct {
	registrationID string
	claimToken     string
	email          string
	attempt        ClaimAttempt
}

// ClaimAttempt is a code for the human. Show VerificationURI and UserCode
// together; the human opens the page, signs in (or signs up) and enters the
// code.
type ClaimAttempt struct {
	UserCode        string
	VerificationURI string
	// ExpiresAt is when the code stops working (15 minutes).
	ExpiresAt time.Time
	// Interval is how often the wait polls.
	Interval time.Duration
	// MovesEndpoints reports whether completing the claim moves the sandbox
	// endpoints, with what they captured, into the account. It is false for
	// a sandbox loaded from the credential file: only the process that
	// registered holds the claim token, so Claim connects a new registration
	// and the sandbox endpoints stay in the sandbox until they expire.
	MovesEndpoints bool
}

func claimAttempt(attempt agent.ClaimAttempt, moves bool) *ClaimAttempt {
	return &ClaimAttempt{
		UserCode:        attempt.UserCode,
		VerificationURI: attempt.VerificationURI,
		ExpiresAt:       attempt.ExpiresAt,
		Interval:        attempt.Interval,
		MovesEndpoints:  moves,
	}
}

// NewSandbox returns a sandbox. It reuses the live sandbox registration in
// the agent credential file for the base URL, if there is one, and
// otherwise registers anonymously, which takes a few seconds of proof of
// work, and saves the registration there for the next process. Anonymous
// registration is limited to 5 per hour per IP address.
//
// It takes the client options; WithClientName names the agent, and
// WithAgentFile("") registers without reading or writing the file.
func NewSandbox(ctx context.Context, opts ...Option) (*Sandbox, error) {
	c, err := configure(opts)
	if err != nil {
		return nil, err
	}
	c.sandbox = true
	c.apiKey = ""
	s := &Sandbox{opts: opts, c: c}
	s.Endpoints = &SandboxEndpointsService{s: s}
	s.Requests = &SandboxRequestsService{s: s}

	store := c.agentStore()
	if saved := store.Load(c.issuer(), time.Now()).Sandbox; saved != nil {
		s.use(*saved)
		_, err := c.tokens.token(ctx)
		if err == nil {
			return s, nil
		}
		if !isInvalidGrant(err) {
			return nil, err
		}
		// The registration expired, was revoked or was claimed, and its slot
		// left the file: register a new one.
	}

	registration, err := c.agentSteps().RegisterAnonymous(ctx, c.clientName)
	if err != nil {
		return nil, err
	}
	slot := agentfile.Slot{
		RegistrationID:    registration.RegistrationID,
		IdentityAssertion: registration.IdentityAssertion,
		AssertionExpires:  registration.AssertionExpires.UTC().Format(agentfile.TimeFormat),
		Scope:             strings.Join(registration.PreClaimScopes, " "),
		ClientName:        c.clientName,
		SavedAt:           time.Now().UTC().Format(agentfile.TimeFormat),
	}
	// Saved before the exchange, so a registration is never lost to a
	// failure after it.
	_ = store.Save(c.issuer(), agentfile.Sandbox, slot)
	s.use(slot)
	s.claimToken = registration.ClaimToken
	// Fail early, with the server's reason, if no token can be had.
	if _, err := c.tokens.token(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Sandbox) use(slot agentfile.Slot) {
	s.c.tokens = s.c.newTokenSource(agentfile.Sandbox, slot)
	s.registrationID = slot.RegistrationID
	s.expiresAt, _ = agentfile.ParseTime(slot.AssertionExpires)
}

// RegistrationID identifies the registration, for logs; the server never
// asks for it.
func (s *Sandbox) RegistrationID() string { return s.registrationID }

// ExpiresAt is when the sandbox, its endpoints and what they captured are
// deleted.
func (s *Sandbox) ExpiresAt() time.Time { return s.expiresAt }

func (s *Sandbox) api(ctx context.Context, method, path string, query url.Values, body, out any) error {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return &SandboxError{StatusCode: http.StatusForbidden, Code: "sandbox_closed", Message: "this sandbox was claimed; use the client WaitForClaim returned"}
	}
	return s.c.api(ctx, method, "/agent/sandbox"+path, query, body, out)
}

// Claim starts connecting this agent to the account of the human with this
// email; only someone signed in with that address can complete it. Show
// them the attempt's VerificationURI and UserCode, then call WaitForClaim.
// Calling Claim again gives a new code and the old one stops working.
//
// A sandbox this process registered moves its endpoints into the account.
// One loaded from the credential file has no claim token, so Claim starts a
// service_auth registration for the email instead (MovesEndpoints false).
func (s *Sandbox) Claim(ctx context.Context, email string) (*ClaimAttempt, error) {
	if email == "" {
		return nil, errors.New("webhooks.cc: Claim needs the email address of the human who connects the agent")
	}
	s.mu.Lock()
	closed, claimToken, pending := s.closed, s.claimToken, s.pending
	s.mu.Unlock()
	if closed {
		return nil, &SandboxError{StatusCode: http.StatusForbidden, Code: "sandbox_closed", Message: "this sandbox was claimed already"}
	}
	steps := s.c.agentSteps()
	var next *pendingClaim
	switch {
	case claimToken != "":
		attempt, err := steps.StartClaim(ctx, claimToken, email)
		if err != nil {
			return nil, err
		}
		next = &pendingClaim{registrationID: s.registrationID, claimToken: claimToken, email: email, attempt: *claimAttempt(*attempt, true)}
	case pending != nil && pending.email == email:
		// A new code for the service_auth registration already started.
		attempt, err := steps.StartClaim(ctx, pending.claimToken, email)
		if err != nil {
			return nil, err
		}
		next = &pendingClaim{registrationID: pending.registrationID, claimToken: pending.claimToken, email: email, attempt: *claimAttempt(*attempt, false)}
	default:
		registration, err := steps.RegisterServiceAuth(ctx, email, s.c.clientName)
		if err != nil {
			return nil, err
		}
		next = &pendingClaim{registrationID: registration.RegistrationID, claimToken: registration.ClaimToken, email: email, attempt: *claimAttempt(registration.Claim, false)}
	}
	s.mu.Lock()
	s.pending = next
	s.mu.Unlock()
	attempt := next.attempt
	return &attempt, nil
}

// WaitForClaim waits until the human enters the code from Claim, then
// returns a Client acting for their account (90 days; its token renews
// itself) and saves the connection in the agent credential file, where New
// and Connected find it. When the claim moved the sandbox endpoints, they
// are that account's endpoints now and this Sandbox stops working.
//
// It fails with an AgentAuthError with Code expired_token when the code ran
// out (call Claim again) or access_denied when the human declined. Without
// a deadline on ctx it gives up shortly after the code expires, with a
// TimeoutError.
func (s *Sandbox) WaitForClaim(ctx context.Context) (*Client, error) {
	s.mu.Lock()
	pending := s.pending
	s.mu.Unlock()
	if pending == nil {
		return nil, errors.New("webhooks.cc: call Sandbox.Claim before WaitForClaim")
	}
	claimed, err := waitForClaim(ctx, s.c.agentSteps(), pending.claimToken, pending.attempt)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.pending == pending {
		s.pending = nil
	}
	if pending.attempt.MovesEndpoints {
		// The pre-claim tokens are gone, and so is the claim token.
		s.closed = true
		s.claimToken = ""
	}
	s.mu.Unlock()
	return connectedClient(s.opts, pending.registrationID, pending.email, claimed)
}

// RevokeToken drops the sandbox's current access token. The next call
// exchanges a new one.
func (s *Sandbox) RevokeToken(ctx context.Context) error {
	token := s.c.tokens.current()
	if token == "" {
		return nil
	}
	if err := s.c.agentSteps().Revoke(ctx, token); err != nil {
		return err
	}
	s.c.tokens.forget(token)
	return nil
}

// waitForClaim polls a claim until it completes. Without a deadline on ctx
// it stops shortly after the code expires.
func waitForClaim(ctx context.Context, steps *agent.Client, claimToken string, attempt ClaimAttempt) (*agent.Claimed, error) {
	waitCtx := ctx
	var limit time.Duration
	if _, ok := ctx.Deadline(); !ok && !attempt.ExpiresAt.IsZero() {
		deadline := attempt.ExpiresAt.Add(claimGrace)
		limit = time.Until(deadline)
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	claimed, err := steps.WaitForClaim(waitCtx, claimToken, attempt.Interval)
	if err != nil && ctx.Err() == nil && waitCtx.Err() != nil {
		return nil, &TimeoutError{After: limit, message: "the code expired before the human entered it; start a new claim"}
	}
	return claimed, err
}

// connectedClient saves a completed claim as the claimed slot (and drops
// the sandbox slot when it held the same registration), and returns a
// client acting for the account.
func connectedClient(opts []Option, registrationID, email string, claimed *agent.Claimed) (*Client, error) {
	c, err := configure(opts)
	if err != nil {
		return nil, err
	}
	c.apiKey = ""
	slot := agentfile.Slot{
		RegistrationID:     registrationID,
		IdentityAssertion:  claimed.IdentityAssertion,
		AssertionExpires:   claimed.AssertionExpires.UTC().Format(agentfile.TimeFormat),
		Scope:              claimed.Token.Scope,
		Email:              email,
		ClientName:         c.clientName,
		SavedAt:            time.Now().UTC().Format(agentfile.TimeFormat),
		AccessToken:        claimed.Token.AccessToken,
		AccessTokenExpires: claimed.Token.ExpiresAt.UTC().Format(agentfile.TimeFormat),
	}
	store := c.agentStore()
	_ = store.Save(c.issuer(), agentfile.Claimed, slot)
	_ = store.Remove(c.issuer(), agentfile.Sandbox, registrationID)
	c.tokens = c.newTokenSource(agentfile.Claimed, slot)
	return c, nil
}

// SandboxLimits are the registration-wide limits and what is used of them.
type SandboxLimits struct {
	// ExpiresAt is when the registration and its endpoints are deleted.
	ExpiresAt    time.Time
	MaxEndpoints int
	// RequestLimit is what one endpoint captures.
	RequestLimit int
	// BudgetUsed and BudgetLimit count captures across the registration.
	BudgetUsed  int
	BudgetLimit int
}

// SandboxEndpoint is a sandbox endpoint: the usual endpoint fields, what it
// captured so far, and the registration's limits.
type SandboxEndpoint struct {
	Endpoint
	RequestCount int
	Limits       SandboxLimits
}

// UnmarshalJSON reads a sandbox endpoint as the API returns it.
func (e *SandboxEndpoint) UnmarshalJSON(data []byte) error {
	var endpoint Endpoint
	if err := json.Unmarshal(data, &endpoint); err != nil {
		return err
	}
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	limits := o.object("sandbox")
	budget := limits.object("budget")
	*e = SandboxEndpoint{
		Endpoint:     endpoint,
		RequestCount: int(o.num("requestCount")),
		Limits: SandboxLimits{
			ExpiresAt:    limits.millis("expiresAt"),
			MaxEndpoints: int(limits.num("maxEndpoints")),
			RequestLimit: int(limits.num("requestLimit")),
			BudgetUsed:   int(budget.num("used")),
			BudgetLimit:  int(budget.num("limit")),
		},
	}
	return nil
}

// SandboxEndpointsService creates, lists, reads and deletes sandbox
// endpoints. Use it as sandbox.Endpoints.
type SandboxEndpointsService struct{ s *Sandbox }

func (e *SandboxEndpointsService) withURL(endpoint *SandboxEndpoint) *SandboxEndpoint {
	if endpoint.URL == "" && endpoint.Slug != "" {
		endpoint.URL = e.s.c.webhookURL + "/w/" + endpoint.Slug
	}
	return endpoint
}

// Create creates a capture endpoint. It fails with a SandboxError
// sandbox_endpoint_limit at 3 live endpoints, or sandbox_full when the
// shared sandbox is full.
func (e *SandboxEndpointsService) Create(ctx context.Context) (*SandboxEndpoint, error) {
	var endpoint SandboxEndpoint
	if err := e.s.api(ctx, http.MethodPost, "/endpoints", nil, struct{}{}, &endpoint); err != nil {
		return nil, err
	}
	return e.withURL(&endpoint), nil
}

// List returns the registration's live endpoints, newest first.
func (e *SandboxEndpointsService) List(ctx context.Context) ([]SandboxEndpoint, error) {
	var response struct {
		Endpoints []SandboxEndpoint `json:"endpoints"`
	}
	if err := e.s.api(ctx, http.MethodGet, "/endpoints", nil, nil, &response); err != nil {
		return nil, err
	}
	for i := range response.Endpoints {
		e.withURL(&response.Endpoints[i])
	}
	return response.Endpoints, nil
}

// Get returns one endpoint; a SandboxError not_found when it is not this
// registration's.
func (e *SandboxEndpointsService) Get(ctx context.Context, slug string) (*SandboxEndpoint, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return nil, err
	}
	var endpoint SandboxEndpoint
	if err := e.s.api(ctx, http.MethodGet, "/endpoints/"+slug, nil, nil, &endpoint); err != nil {
		return nil, err
	}
	return e.withURL(&endpoint), nil
}

// Delete deletes an endpoint and what it captured, freeing a slot. The
// registration's request budget is not refunded.
func (e *SandboxEndpointsService) Delete(ctx context.Context, slug string) error {
	if err := validateSegment(slug, "slug"); err != nil {
		return err
	}
	return e.s.api(ctx, http.MethodDelete, "/endpoints/"+slug, nil, nil, nil)
}

// SandboxRequestsService lists, reads and waits for captured requests. Use
// it as sandbox.Requests.
type SandboxRequestsService struct{ s *Sandbox }

// SandboxListOptions narrow SandboxRequestsService.List. Both are optional.
type SandboxListOptions struct {
	// Limit caps the list (the server returns at most 100).
	Limit int
	// Since keeps requests received at or after this time.
	Since time.Time
}

// List returns the requests an endpoint captured, newest first.
func (r *SandboxRequestsService) List(ctx context.Context, slug string, opts SandboxListOptions) ([]Request, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	query := url.Values{}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if !opts.Since.IsZero() {
		query.Set("since", strconv.FormatInt(max(0, opts.Since.UnixMilli()), 10))
	}
	var requests []Request
	if err := r.s.api(ctx, http.MethodGet, "/endpoints/"+slug+"/requests", query, nil, &requests); err != nil {
		return nil, err
	}
	return requests, nil
}

// Get returns one captured request.
func (r *SandboxRequestsService) Get(ctx context.Context, id string) (*Request, error) {
	if err := validateSegment(id, "request id"); err != nil {
		return nil, err
	}
	var request Request
	if err := r.s.api(ctx, http.MethodGet, "/requests/"+id, nil, nil, &request); err != nil {
		return nil, err
	}
	return &request, nil
}

// WaitFor polls until a request (matching opts.Match, if set) arrives, like
// Client.Requests.WaitFor. When time runs out it returns a TimeoutError.
func (r *SandboxRequestsService) WaitFor(ctx context.Context, slug string, opts WaitOptions) (*Request, error) {
	requests, err := r.WaitForAll(ctx, slug, 1, opts)
	if err != nil {
		return nil, err
	}
	return &requests[0], nil
}

// WaitForAll polls until count matching requests have arrived and returns
// them oldest first. A sandbox endpoint captures at most 25, so count may
// be at most 25.
func (r *SandboxRequestsService) WaitForAll(ctx context.Context, slug string, count int, opts WaitOptions) ([]Request, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	if count > sandboxRequestsPerEndpoint {
		return nil, fmt.Errorf("webhooks.cc: a sandbox endpoint captures at most %d requests, so count must be at most %d", sandboxRequestsPerEndpoint, sandboxRequestsPerEndpoint)
	}
	limit := min(sandboxMaxList, waitListLimit(count))
	return collect(ctx, func(ctx context.Context, since time.Time) ([]Request, error) {
		return r.List(ctx, slug, SandboxListOptions{Since: since, Limit: limit})
	}, count, durationOr(opts.Timeout, defaultWaitTimeout), durationOr(opts.PollInterval, defaultWaitPoll), opts.Match, opts.Since)
}

// sandboxErrorFromResponse reads a sandbox refusal's { error,
// error_description } body.
func sandboxErrorFromResponse(response *apiResponse) *SandboxError {
	refusal := &SandboxError{
		StatusCode: response.status,
		Code:       "http_" + strconv.Itoa(response.status),
		Message:    fmt.Sprintf("sandbox request failed (HTTP %d)", response.status),
	}
	var body struct {
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if json.Unmarshal(response.body, &body) == nil {
		if body.Error != "" {
			refusal.Code = body.Error
		}
		if body.Description != "" {
			refusal.Message = body.Description
		}
	}
	return refusal
}
