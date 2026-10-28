// Package agent runs the steps of webhooks.cc agent registration (auth.md
// v0.6, https://webhooks.cc/auth.md) one call each: discover, get and solve a
// proof-of-work challenge, register (anonymous or service_auth), exchange the
// identity assertion for an access token, start a claim and poll it, and
// revoke a token.
//
// Most callers want webhookscc.NewSandbox, webhookscc.Connect or
// webhookscc.Connected, which run these steps in order and keep the
// credentials in the file the other webhooks.cc tools share. Nothing here
// uses an API key, and nothing here touches that file.
//
//	steps := &agent.Client{}
//	registration, err := steps.RegisterAnonymous(ctx, "my-agent") // a few seconds of proof of work
//	if err != nil {
//		return err
//	}
//	token, err := steps.Exchange(ctx, registration.IdentityAssertion)
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the app the zero Client talks to.
const DefaultBaseURL = "https://webhooks.cc"

const (
	defaultTimeout   = 30 * time.Second
	defaultUserAgent = "webhooks-cc-go"
	defaultInterval  = 5 * time.Second
	// maxPollFailures is how many polls in a row may fail on the network or
	// with a 5xx before WaitForClaim gives up.
	maxPollFailures = 5
	maxResponseBody = 1 << 20

	jwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer"
	claimGrant     = "urn:workos:agent-auth:grant-type:claim"
)

// slowDownStep is how much longer a slow_down answer makes each wait (RFC
// 8628). A variable for the tests.
var slowDownStep = 5 * time.Second

// Client sends the registration steps. The zero value talks to
// https://webhooks.cc; it is safe for concurrent use.
type Client struct {
	// BaseURL is the webhooks.cc app (default https://webhooks.cc).
	BaseURL string
	// HTTPClient sends the requests (default: a new http.Client). Redirects
	// are never followed, whatever its CheckRedirect says, so an assertion or
	// a token only reaches the host it was meant for.
	HTTPClient *http.Client
	// Timeout bounds each request (default 30 seconds).
	Timeout time.Duration
	// UserAgent is sent with each request (default webhooks-cc-go).
	UserAgent string
}

// AuthError is a step the server refused. Code is auth.md's or OAuth's error
// code, such as invalid_grant or sandbox_full; a body without one gives
// http_<status>.
type AuthError struct {
	Code        string
	Status      int
	Description string
	// Details is the rest of the error body, such as a fresh challenge.
	Details map[string]any
	// RetryAfter is how long a 429 or 503 asked to wait, when it said.
	RetryAfter time.Duration
}

func (e *AuthError) Error() string {
	message := fmt.Sprintf("webhooks.cc agent: %s (HTTP %d)", e.Code, e.Status)
	if e.Description != "" {
		message += ": " + e.Description
	}
	return message
}

// Discovery is what the authorization server metadata says about agent
// registration (auth.md Step 1).
type Discovery struct {
	Issuer             string
	TokenEndpoint      string
	RevocationEndpoint string
	IdentityEndpoint   string
	ClaimEndpoint      string
	IdentityTypes      []string
	GrantTypes         []string
	// ChallengeEndpoint and SandboxEndpointsURL are webhooks.cc extensions.
	ChallengeEndpoint   string
	SandboxEndpointsURL string
}

// ClaimAttempt is a code for the human: show UserCode and VerificationURI
// together.
type ClaimAttempt struct {
	// RegistrationID is the registration being claimed (set by StartClaim).
	RegistrationID string
	UserCode       string
	// VerificationURI is the page where the human signs in and enters the code.
	VerificationURI string
	ExpiresAt       time.Time
	// Interval is how long to wait between claim polls.
	Interval time.Duration
}

// SandboxInfo describes the sandbox an anonymous registration may use.
type SandboxInfo struct {
	// Status is "available", or "full" when the shared sandbox has no free
	// endpoint slot.
	Status                 string
	EndpointsURL           string
	MaxEndpoints           int
	MaxRequestsPerEndpoint int
	MaxRequests            int
}

// AnonymousRegistration is a new anonymous registration.
type AnonymousRegistration struct {
	RegistrationID    string
	IdentityAssertion string
	AssertionExpires  time.Time
	// ClaimToken starts a claim and collects its result. Keep it in memory
	// only; auth.md asks that it is never persisted.
	ClaimToken        string
	ClaimTokenExpires time.Time
	PreClaimScopes    []string
	PostClaimScopes   []string
	Sandbox           SandboxInfo
}

// ServiceAuthRegistration is a registration for a human known by email.
// Nothing works until they complete the claim.
type ServiceAuthRegistration struct {
	RegistrationID string
	// ClaimToken polls the claim and starts new attempts; keep it in memory.
	ClaimToken        string
	ClaimTokenExpires time.Time
	PostClaimScopes   []string
	// Claim is the first attempt: show it to the human now.
	Claim ClaimAttempt
}

// Token is an access token exchanged from an identity assertion.
type Token struct {
	AccessToken string
	Scope       string
	ExpiresAt   time.Time
}

// Claimed is what a completed claim returns: a token acting for the human's
// account, and the claimed assertion that mints more (90 days).
type Claimed struct {
	Token             Token
	IdentityAssertion string
	AssertionExpires  time.Time
}

// ClaimStatus is the state of a claim, as one poll saw it.
type ClaimStatus string

const (
	ClaimPending  ClaimStatus = "pending"
	ClaimSlowDown ClaimStatus = "slow_down"
	ClaimExpired  ClaimStatus = "expired"
	ClaimDenied   ClaimStatus = "denied"
	ClaimClaimed  ClaimStatus = "claimed"
)

// ClaimPoll is one poll's answer. Claimed is set when Status is ClaimClaimed.
type ClaimPoll struct {
	Status  ClaimStatus
	Claimed *Claimed
}

// Discover reads the authorization server metadata (auth.md Step 1b).
func (c *Client) Discover(ctx context.Context) (*Discovery, error) {
	response, err := c.call(ctx, http.MethodGet, "/.well-known/oauth-authorization-server", nil, nil)
	if err != nil {
		return nil, err
	}
	if response.status != http.StatusOK {
		return nil, response.fail()
	}
	var doc struct {
		Issuer             string   `json:"issuer"`
		TokenEndpoint      string   `json:"token_endpoint"`
		RevocationEndpoint string   `json:"revocation_endpoint"`
		GrantTypes         []string `json:"grant_types_supported"`
		AgentAuth          struct {
			IdentityEndpoint string   `json:"identity_endpoint"`
			ClaimEndpoint    string   `json:"claim_endpoint"`
			IdentityTypes    []string `json:"identity_types_supported"`
			Anonymous        struct {
				ProofOfWork struct {
					ChallengeEndpoint string `json:"challenge_endpoint"`
				} `json:"proof_of_work"`
				Sandbox struct {
					EndpointsURL string `json:"endpoints_url"`
				} `json:"sandbox"`
			} `json:"anonymous"`
		} `json:"agent_auth"`
	}
	if err := response.decode(&doc); err != nil {
		return nil, err
	}
	if err := required(response.path, map[string]string{
		"issuer":                       doc.Issuer,
		"token_endpoint":               doc.TokenEndpoint,
		"revocation_endpoint":          doc.RevocationEndpoint,
		"agent_auth.identity_endpoint": doc.AgentAuth.IdentityEndpoint,
		"agent_auth.claim_endpoint":    doc.AgentAuth.ClaimEndpoint,
	}); err != nil {
		return nil, err
	}
	return &Discovery{
		Issuer:              doc.Issuer,
		TokenEndpoint:       doc.TokenEndpoint,
		RevocationEndpoint:  doc.RevocationEndpoint,
		IdentityEndpoint:    doc.AgentAuth.IdentityEndpoint,
		ClaimEndpoint:       doc.AgentAuth.ClaimEndpoint,
		IdentityTypes:       doc.AgentAuth.IdentityTypes,
		GrantTypes:          doc.GrantTypes,
		ChallengeEndpoint:   doc.AgentAuth.Anonymous.ProofOfWork.ChallengeEndpoint,
		SandboxEndpointsURL: doc.AgentAuth.Anonymous.Sandbox.EndpointsURL,
	}, nil
}

// Challenge fetches a fresh proof-of-work challenge for anonymous registration.
func (c *Client) Challenge(ctx context.Context) (*Challenge, error) {
	response, err := c.call(ctx, http.MethodPost, "/api/agent/identity/challenge", struct{}{}, nil)
	if err != nil {
		return nil, err
	}
	if response.status != http.StatusOK {
		return nil, response.fail()
	}
	var challenge Challenge
	if err := response.decode(&challenge); err != nil {
		return nil, err
	}
	return &challenge, nil
}

// RegisterAnonymous fetches a challenge, solves it (a few seconds of CPU) and
// registers anonymously (auth.md Step 3). When the server refuses the proof
// with a fresh challenge in the body (it expired while solving, for
// example), it solves that one and tries once more. clientName is shown to
// the human as self-reported (at most 64 characters; "" sends none).
func (c *Client) RegisterAnonymous(ctx context.Context, clientName string) (*AnonymousRegistration, error) {
	challenge, err := c.Challenge(ctx)
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		nonces, err := Solve(ctx, *challenge)
		if err != nil {
			return nil, err
		}
		body := map[string]any{
			"type":          "anonymous",
			"proof_of_work": map[string]any{"challenge": challenge.Challenge, "nonces": nonces},
		}
		if clientName != "" {
			body["client_name"] = clientName
		}
		response, err := c.call(ctx, http.MethodPost, "/api/agent/identity", body, nil)
		if err != nil {
			return nil, err
		}
		if response.status == http.StatusOK {
			return response.anonymousRegistration()
		}
		if attempt == 0 {
			if fresh := response.freshChallenge(); fresh != nil {
				challenge = fresh
				continue
			}
		}
		return nil, response.fail()
	}
}

// RegisterServiceAuth registers for a human you know by email (auth.md Step
// 2, service_auth). No proof of work and no sandbox: nothing works until
// that human signs in and enters the code in Claim.
func (c *Client) RegisterServiceAuth(ctx context.Context, email, clientName string) (*ServiceAuthRegistration, error) {
	body := map[string]any{"type": "service_auth", "login_hint": email}
	if clientName != "" {
		body["client_name"] = clientName
	}
	response, err := c.call(ctx, http.MethodPost, "/api/agent/identity", body, nil)
	if err != nil {
		return nil, err
	}
	if response.status != http.StatusOK {
		return nil, response.fail()
	}
	var raw struct {
		RegistrationID    string        `json:"registration_id"`
		ClaimToken        string        `json:"claim_token"`
		ClaimTokenExpires string        `json:"claim_token_expires"`
		PostClaimScopes   []string      `json:"post_claim_scopes"`
		Claim             *attemptBlock `json:"claim"`
	}
	if err := response.decode(&raw); err != nil {
		return nil, err
	}
	if err := required(response.path, map[string]string{"registration_id": raw.RegistrationID, "claim_token": raw.ClaimToken}); err != nil {
		return nil, err
	}
	attempt, err := raw.Claim.attempt(response.path, response.received)
	if err != nil {
		return nil, err
	}
	attempt.RegistrationID = raw.RegistrationID
	return &ServiceAuthRegistration{
		RegistrationID:    raw.RegistrationID,
		ClaimToken:        raw.ClaimToken,
		ClaimTokenExpires: parseTime(raw.ClaimTokenExpires),
		PostClaimScopes:   raw.PostClaimScopes,
		Claim:             attempt,
	}, nil
}

// Exchange trades an identity assertion for an access token (auth.md Step
// 5). An AuthError with Code invalid_grant means the registration expired,
// was revoked, or (for an anonymous one) was claimed.
func (c *Client) Exchange(ctx context.Context, assertion string) (*Token, error) {
	// No resource parameter: the server compares it with its own public URL,
	// which a client reaching it under another name would not match.
	form := url.Values{"grant_type": {jwtBearerGrant}, "assertion": {assertion}}
	response, err := c.call(ctx, http.MethodPost, "/api/oauth2/token", nil, form)
	if err != nil {
		return nil, err
	}
	if response.status != http.StatusOK {
		return nil, response.fail()
	}
	return response.token()
}

// Revoke drops one access token (RFC 7009). The assertion keeps working.
func (c *Client) Revoke(ctx context.Context, token string) error {
	form := url.Values{"token": {token}, "token_type_hint": {"access_token"}}
	response, err := c.call(ctx, http.MethodPost, "/api/oauth2/revoke", nil, form)
	if err != nil {
		return err
	}
	if response.status != http.StatusOK {
		return response.fail()
	}
	return nil
}

// StartClaim starts a claim attempt (auth.md Step 4a). Only someone signed in
// as email can complete it; a service_auth registration may pass "". Each
// call replaces the previous attempt, whose code stops working.
func (c *Client) StartClaim(ctx context.Context, claimToken, email string) (*ClaimAttempt, error) {
	body := map[string]any{"claim_token": claimToken}
	if email != "" {
		body["email"] = email
	}
	response, err := c.call(ctx, http.MethodPost, "/api/agent/identity/claim", body, nil)
	if err != nil {
		return nil, err
	}
	if response.status != http.StatusOK {
		return nil, response.fail()
	}
	var raw struct {
		RegistrationID string        `json:"registration_id"`
		ClaimAttempt   *attemptBlock `json:"claim_attempt"`
	}
	if err := response.decode(&raw); err != nil {
		return nil, err
	}
	if err := required(response.path, map[string]string{"registration_id": raw.RegistrationID}); err != nil {
		return nil, err
	}
	attempt, err := raw.ClaimAttempt.attempt(response.path, response.received)
	if err != nil {
		return nil, err
	}
	attempt.RegistrationID = raw.RegistrationID
	return &attempt, nil
}

// PollClaim polls the claim grant once (auth.md Step 4c).
func (c *Client) PollClaim(ctx context.Context, claimToken string) (*ClaimPoll, error) {
	form := url.Values{"grant_type": {claimGrant}, "claim_token": {claimToken}}
	response, err := c.call(ctx, http.MethodPost, "/api/oauth2/token", nil, form)
	if err != nil {
		return nil, err
	}
	if response.status == http.StatusOK {
		token, err := response.token()
		if err != nil {
			return nil, err
		}
		var raw struct {
			IdentityAssertion string `json:"identity_assertion"`
			AssertionExpires  string `json:"assertion_expires"`
		}
		if err := response.decode(&raw); err != nil {
			return nil, err
		}
		if err := required(response.path, map[string]string{"identity_assertion": raw.IdentityAssertion, "assertion_expires": raw.AssertionExpires}); err != nil {
			return nil, err
		}
		return &ClaimPoll{Status: ClaimClaimed, Claimed: &Claimed{
			Token:             *token,
			IdentityAssertion: raw.IdentityAssertion,
			AssertionExpires:  parseTime(raw.AssertionExpires),
		}}, nil
	}
	failure := response.fail()
	switch failure.Code {
	case "authorization_pending":
		return &ClaimPoll{Status: ClaimPending}, nil
	case "slow_down":
		return &ClaimPoll{Status: ClaimSlowDown}, nil
	case "expired_token":
		return &ClaimPoll{Status: ClaimExpired}, nil
	case "access_denied":
		return &ClaimPoll{Status: ClaimDenied}, nil
	}
	return nil, failure
}

// WaitForClaim polls until the human connects the agent, every interval
// (default 5 seconds, longer after a slow_down). It returns an AuthError
// with Code expired_token when the code ran out (start a new attempt) or
// access_denied when the human declined, and ctx's error when ctx ends. A
// poll that fails on the network or with a 5xx is repeated at the next
// interval, up to five in a row. The code lives 15 minutes, after which the
// server answers expired_token, so the wait always ends.
func (c *Client) WaitForClaim(ctx context.Context, claimToken string, interval time.Duration) (*Claimed, error) {
	if interval <= 0 {
		interval = defaultInterval
	}
	failures := 0
	for {
		poll, err := c.PollClaim(ctx, claimToken)
		switch {
		case err == nil:
			failures = 0
			switch poll.Status {
			case ClaimClaimed:
				return poll.Claimed, nil
			case ClaimExpired:
				return nil, &AuthError{Code: "expired_token", Status: http.StatusBadRequest, Description: "The code expired. Start a new claim."}
			case ClaimDenied:
				return nil, &AuthError{Code: "access_denied", Status: http.StatusBadRequest, Description: "The human declined."}
			case ClaimSlowDown:
				interval += slowDownStep
			}
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case transient(err) && failures < maxPollFailures-1:
			failures++
		default:
			return nil, err
		}
		if err := sleep(ctx, interval); err != nil {
			return nil, err
		}
	}
}

// transient reports whether a failed poll is worth repeating.
func transient(err error) bool {
	var authErr *AuthError
	if errors.As(err, &authErr) {
		return authErr.Status >= 500 || authErr.Status == http.StatusTooManyRequests
	}
	return true
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// --- transport ---------------------------------------------------------------------

type response struct {
	path     string
	status   int
	header   http.Header
	body     []byte
	received time.Time
}

// call sends one request with a JSON body or a form, and reads the answer.
func (c *Client) call(ctx context.Context, method, path string, jsonBody any, form url.Values) (*response, error) {
	var reader io.Reader
	contentType := ""
	switch {
	case jsonBody != nil:
		payload, err := json.Marshal(jsonBody)
		if err != nil {
			return nil, err
		}
		reader, contentType = bytes.NewReader(payload), "application/json"
	case form != nil:
		reader, contentType = strings.NewReader(form.Encode()), "application/x-www-form-urlencoded"
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, method, c.baseURL()+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	userAgent := c.UserAgent
	if userAgent == "" {
		userAgent = defaultUserAgent
	}
	request.Header.Set("User-Agent", userAgent)
	answer, err := c.httpClient().Do(request)
	if err == nil {
		defer answer.Body.Close()
		var body []byte
		if body, err = io.ReadAll(io.LimitReader(answer.Body, maxResponseBody)); err == nil {
			return &response{path: path, status: answer.StatusCode, header: answer.Header, body: body, received: time.Now()}, nil
		}
	}
	if ctx.Err() == nil && errors.Is(callCtx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("webhooks.cc agent: %s %s timed out after %s: %w", method, path, timeout, context.DeadlineExceeded)
	}
	return nil, err
}

func (c *Client) baseURL() string {
	if c.BaseURL == "" {
		return DefaultBaseURL
	}
	return strings.TrimRight(c.BaseURL, "/")
}

// httpClient is a copy of HTTPClient that never follows redirects.
func (c *Client) httpClient() *http.Client {
	var client http.Client
	if c.HTTPClient != nil {
		client = *c.HTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &client
}

func (r *response) decode(v any) error {
	if err := json.Unmarshal(r.body, v); err != nil {
		return fmt.Errorf("webhooks.cc agent: malformed response from %s: %w", r.path, err)
	}
	return nil
}

// fail turns an error answer into an AuthError. Bodies that are not JSON
// (a proxy's error page) leave only the status.
func (r *response) fail() *AuthError {
	failure := &AuthError{Code: "http_" + strconv.Itoa(r.status), Status: r.status}
	var body map[string]any
	if json.Unmarshal(r.body, &body) == nil {
		if code, ok := body["error"].(string); ok && code != "" {
			failure.Code = code
		}
		if description, ok := body["error_description"].(string); ok {
			failure.Description = description
		}
		delete(body, "error")
		delete(body, "error_description")
		if len(body) > 0 {
			failure.Details = body
		}
	}
	if seconds, err := strconv.Atoi(strings.TrimSpace(r.header.Get("Retry-After"))); err == nil && seconds > 0 {
		failure.RetryAfter = time.Duration(seconds) * time.Second
	}
	return failure
}

// freshChallenge is the challenge a refused anonymous registration carries,
// when the refusal is one a new proof fixes.
func (r *response) freshChallenge() *Challenge {
	var body struct {
		Error string `json:"error"`
		Challenge
	}
	if json.Unmarshal(r.body, &body) != nil || body.Challenge.Challenge == "" {
		return nil
	}
	if body.Error != "invalid_challenge" && body.Error != "proof_of_work_required" {
		return nil
	}
	return &body.Challenge
}

func (r *response) token() (*Token, error) {
	var raw struct {
		AccessToken string   `json:"access_token"`
		Scope       string   `json:"scope"`
		ExpiresIn   *float64 `json:"expires_in"`
	}
	if err := r.decode(&raw); err != nil {
		return nil, err
	}
	if err := required(r.path, map[string]string{"access_token": raw.AccessToken}); err != nil {
		return nil, err
	}
	expiresIn := 3600.0
	if raw.ExpiresIn != nil {
		expiresIn = *raw.ExpiresIn
	}
	return &Token{
		AccessToken: raw.AccessToken,
		Scope:       raw.Scope,
		ExpiresAt:   r.received.Add(time.Duration(expiresIn * float64(time.Second))),
	}, nil
}

func (r *response) anonymousRegistration() (*AnonymousRegistration, error) {
	var raw struct {
		RegistrationID    string   `json:"registration_id"`
		IdentityAssertion string   `json:"identity_assertion"`
		AssertionExpires  string   `json:"assertion_expires"`
		ClaimToken        string   `json:"claim_token"`
		ClaimTokenExpires string   `json:"claim_token_expires"`
		PreClaimScopes    []string `json:"pre_claim_scopes"`
		PostClaimScopes   []string `json:"post_claim_scopes"`
		Sandbox           struct {
			Status                 string `json:"status"`
			EndpointsURL           string `json:"endpoints_url"`
			MaxEndpoints           *int   `json:"max_endpoints"`
			MaxRequestsPerEndpoint *int   `json:"max_requests_per_endpoint"`
			MaxRequests            *int   `json:"max_requests"`
		} `json:"sandbox"`
	}
	if err := r.decode(&raw); err != nil {
		return nil, err
	}
	if err := required(r.path, map[string]string{
		"registration_id":    raw.RegistrationID,
		"identity_assertion": raw.IdentityAssertion,
		"assertion_expires":  raw.AssertionExpires,
		"claim_token":        raw.ClaimToken,
	}); err != nil {
		return nil, err
	}
	status := "available"
	if raw.Sandbox.Status == "full" {
		status = "full"
	}
	return &AnonymousRegistration{
		RegistrationID:    raw.RegistrationID,
		IdentityAssertion: raw.IdentityAssertion,
		AssertionExpires:  parseTime(raw.AssertionExpires),
		ClaimToken:        raw.ClaimToken,
		ClaimTokenExpires: parseTime(raw.ClaimTokenExpires),
		PreClaimScopes:    raw.PreClaimScopes,
		PostClaimScopes:   raw.PostClaimScopes,
		Sandbox: SandboxInfo{
			Status:                 status,
			EndpointsURL:           raw.Sandbox.EndpointsURL,
			MaxEndpoints:           intOr(raw.Sandbox.MaxEndpoints, 3),
			MaxRequestsPerEndpoint: intOr(raw.Sandbox.MaxRequestsPerEndpoint, 25),
			MaxRequests:            intOr(raw.Sandbox.MaxRequests, 100),
		},
	}, nil
}

// attemptBlock is a claim attempt as the server sends it.
type attemptBlock struct {
	UserCode        string   `json:"user_code"`
	VerificationURI string   `json:"verification_uri"`
	ExpiresIn       float64  `json:"expires_in"`
	Interval        *float64 `json:"interval"`
}

func (b *attemptBlock) attempt(path string, received time.Time) (ClaimAttempt, error) {
	if b == nil {
		return ClaimAttempt{}, fmt.Errorf("webhooks.cc agent: malformed response from %s: missing the claim attempt", path)
	}
	if err := required(path, map[string]string{"user_code": b.UserCode, "verification_uri": b.VerificationURI}); err != nil {
		return ClaimAttempt{}, err
	}
	interval := defaultInterval
	if b.Interval != nil && *b.Interval > 0 {
		interval = time.Duration(*b.Interval * float64(time.Second))
	}
	return ClaimAttempt{
		UserCode:        b.UserCode,
		VerificationURI: b.VerificationURI,
		ExpiresAt:       received.Add(time.Duration(b.ExpiresIn * float64(time.Second))),
		Interval:        interval,
	}, nil
}

// required fails when one of the named fields is empty.
func required(path string, fields map[string]string) error {
	for name, value := range fields {
		if value == "" {
			return fmt.Errorf("webhooks.cc agent: malformed response from %s: missing %s", path, name)
		}
	}
	return nil
}

// parseTime reads an RFC 3339 time the server sent; zero when it cannot.
func parseTime(value string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

func intOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}
