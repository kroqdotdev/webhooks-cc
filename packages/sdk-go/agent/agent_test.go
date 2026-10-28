package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func newServer(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &Client{BaseURL: server.URL + "/", UserAgent: "agent-test"}
}

func challengeJSON(id string, difficulty, count int) map[string]any {
	return map[string]any{
		"challenge":  "pow1." + id + ".mac",
		"algorithm":  Algorithm,
		"difficulty": difficulty,
		"count":      count,
		"expires_at": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
	}
}

func TestRegisterAnonymousRetriesOnceWithTheFreshChallenge(t *testing.T) {
	var mu sync.Mutex
	var proofs []map[string]any
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/identity/challenge":
			writeJSON(w, 200, challengeJSON("first", 3, 2))
		case "/api/agent/identity":
			if got := r.Header.Get("User-Agent"); got != "agent-test" {
				t.Errorf("User-Agent = %q", got)
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			proofs = append(proofs, body)
			n := len(proofs)
			mu.Unlock()
			if n == 1 {
				fresh := challengeJSON("second", 2, 1)
				fresh["error"] = "invalid_challenge"
				fresh["error_description"] = "The proof of work was not accepted (expired)."
				writeJSON(w, 400, fresh)
				return
			}
			writeJSON(w, 200, map[string]any{
				"registration_id":     "reg-1",
				"registration_type":   "anonymous",
				"identity_assertion":  "assertion-1",
				"assertion_expires":   "2026-10-29T12:00:00.000Z",
				"pre_claim_scopes":    []string{"webhooks:sandbox"},
				"claim_token":         "clm_1",
				"claim_token_expires": "2026-10-29T12:00:00.000Z",
				"post_claim_scopes":   []string{"webhooks:read", "webhooks:write"},
				"sandbox":             map[string]any{"status": "full", "endpoints_url": "https://example.test/sandbox", "max_endpoints": 3},
				"claim":               map[string]any{"token": "clm_1", "url": "https://example.test/claim"},
			})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	registration, err := steps.RegisterAnonymous(t.Context(), "my-agent")
	if err != nil {
		t.Fatal(err)
	}
	if registration.RegistrationID != "reg-1" || registration.ClaimToken != "clm_1" || registration.IdentityAssertion != "assertion-1" {
		t.Errorf("registration = %+v", registration)
	}
	if !registration.AssertionExpires.Equal(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("AssertionExpires = %s", registration.AssertionExpires)
	}
	if registration.Sandbox.Status != "full" || registration.Sandbox.MaxRequestsPerEndpoint != 25 || registration.Sandbox.MaxEndpoints != 3 {
		t.Errorf("sandbox = %+v", registration.Sandbox)
	}
	if len(proofs) != 2 {
		t.Fatalf("%d registration calls, want 2", len(proofs))
	}
	for i, want := range []struct {
		challenge  string
		difficulty int
		count      int
	}{{"pow1.first.mac", 3, 2}, {"pow1.second.mac", 2, 1}} {
		if proofs[i]["type"] != "anonymous" || proofs[i]["client_name"] != "my-agent" {
			t.Errorf("call %d body = %v", i, proofs[i])
		}
		proof := proofs[i]["proof_of_work"].(map[string]any)
		var nonces []string
		for _, n := range proof["nonces"].([]any) {
			nonces = append(nonces, n.(string))
		}
		if proof["challenge"] != want.challenge || len(nonces) != want.count || !checkNonces(want.challenge, want.difficulty, nonces) {
			t.Errorf("call %d proof = %v", i, proof)
		}
	}
}

func TestRegisterAnonymousGivesUpAfterTheSecondRefusal(t *testing.T) {
	var calls atomic.Int32
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/identity/challenge" {
			writeJSON(w, 200, challengeJSON("c", 1, 1))
			return
		}
		calls.Add(1)
		fresh := challengeJSON("again", 1, 1)
		fresh["error"] = "invalid_challenge"
		writeJSON(w, 400, fresh)
	})
	_, err := steps.RegisterAnonymous(t.Context(), "")
	var refused *AuthError
	if !errors.As(err, &refused) || refused.Code != "invalid_challenge" || refused.Status != 400 {
		t.Fatalf("err = %v", err)
	}
	if refused.Details["challenge"] != "pow1.again.mac" {
		t.Errorf("Details = %v", refused.Details)
	}
	if calls.Load() != 2 {
		t.Errorf("%d registration calls, want 2", calls.Load())
	}
}

func TestRegisterAnonymousDoesNotRetryOtherRefusals(t *testing.T) {
	var calls atomic.Int32
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/identity/challenge" {
			writeJSON(w, 200, challengeJSON("c", 1, 1))
			return
		}
		calls.Add(1)
		w.Header().Set("Retry-After", "1800")
		writeJSON(w, 429, map[string]any{"error": "rate_limited", "error_description": "Too many registrations."})
	})
	_, err := steps.RegisterAnonymous(t.Context(), "")
	var refused *AuthError
	if !errors.As(err, &refused) || refused.Code != "rate_limited" || refused.RetryAfter != 30*time.Minute {
		t.Fatalf("err = %v (%+v)", err, refused)
	}
	if calls.Load() != 1 {
		t.Errorf("%d registration calls, want 1", calls.Load())
	}
}

func TestExchangeSendsTheAssertionWithoutAResource(t *testing.T) {
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/oauth2/token" || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("%s %s (%s)", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
		}
		_ = r.ParseForm()
		// Exactly these two: no resource parameter.
		if len(r.PostForm) != 2 || r.PostForm.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || r.PostForm.Get("assertion") == "" {
			t.Errorf("form = %v", r.PostForm)
		}
		if r.PostForm.Get("assertion") == "dead" {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "The registration expired."})
			return
		}
		writeJSON(w, 200, map[string]any{"access_token": "whcc_1", "token_type": "Bearer", "expires_in": 3600, "scope": "webhooks:sandbox"})
	})
	before := time.Now()
	token, err := steps.Exchange(t.Context(), "assertion-1")
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "whcc_1" || token.Scope != "webhooks:sandbox" {
		t.Errorf("token = %+v", token)
	}
	if lifetime := token.ExpiresAt.Sub(before); lifetime < 59*time.Minute || lifetime > 61*time.Minute {
		t.Errorf("token lives %s", lifetime)
	}
	_, err = steps.Exchange(t.Context(), "dead")
	var refused *AuthError
	if !errors.As(err, &refused) || refused.Code != "invalid_grant" || refused.Description != "The registration expired." {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "invalid_grant (HTTP 400)") {
		t.Errorf("message = %q", err.Error())
	}
}

func TestServiceAuthAndStartClaim(t *testing.T) {
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/api/agent/identity":
			if body["type"] != "service_auth" || body["login_hint"] != "dev@example.com" || body["client_name"] != "tool" {
				t.Errorf("body = %v", body)
			}
			writeJSON(w, 200, map[string]any{
				"registration_id":     "reg-2",
				"claim_token":         "clm_2",
				"claim_token_expires": "2026-10-29T12:00:00Z",
				"post_claim_scopes":   []string{"webhooks:read"},
				"claim":               map[string]any{"user_code": "123456", "expires_in": 900, "verification_uri": "https://example.test/agent/claim?attempt=cat_1", "interval": 5},
			})
		case "/api/agent/identity/claim":
			if body["claim_token"] != "clm_2" || body["email"] != "dev@example.com" {
				t.Errorf("body = %v", body)
			}
			writeJSON(w, 200, map[string]any{
				"registration_id": "reg-2",
				"status":          "initiated",
				"claim_attempt":   map[string]any{"user_code": "654321", "expires_in": 900, "verification_uri": "https://example.test/agent/claim?attempt=cat_2", "interval": 7},
			})
		}
	})
	registration, err := steps.RegisterServiceAuth(t.Context(), "dev@example.com", "tool")
	if err != nil {
		t.Fatal(err)
	}
	if registration.ClaimToken != "clm_2" || registration.Claim.UserCode != "123456" || registration.Claim.Interval != 5*time.Second ||
		registration.Claim.RegistrationID != "reg-2" || time.Until(registration.Claim.ExpiresAt) < 14*time.Minute {
		t.Errorf("registration = %+v", registration)
	}
	attempt, err := steps.StartClaim(t.Context(), "clm_2", "dev@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if attempt.UserCode != "654321" || attempt.Interval != 7*time.Second || attempt.RegistrationID != "reg-2" {
		t.Errorf("attempt = %+v", attempt)
	}
}

func TestPollAndWaitForClaim(t *testing.T) {
	previous := slowDownStep
	slowDownStep = time.Millisecond
	t.Cleanup(func() { slowDownStep = previous })

	var mu sync.Mutex
	answers := map[string][]string{}
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("grant_type") != claimGrant {
			t.Errorf("grant_type = %q", r.PostForm.Get("grant_type"))
		}
		token := r.PostForm.Get("claim_token")
		mu.Lock()
		queue := answers[token]
		answer := queue[0]
		if len(queue) > 1 {
			answers[token] = queue[1:]
		}
		mu.Unlock()
		switch answer {
		case "claimed":
			writeJSON(w, 200, map[string]any{
				"access_token": "whcc_claimed", "expires_in": 3600, "scope": "webhooks:read webhooks:write",
				"identity_assertion": "claimed-assertion", "assertion_expires": "2027-01-26T12:00:00.000Z",
			})
		case "flaky":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, "<html>bad gateway</html>")
		default:
			writeJSON(w, 400, map[string]any{"error": answer})
		}
	})
	answers["clm_ok"] = []string{"authorization_pending", "slow_down", "flaky", "claimed"}
	answers["clm_expired"] = []string{"authorization_pending", "expired_token"}
	answers["clm_denied"] = []string{"access_denied"}
	answers["clm_unknown"] = []string{"invalid_grant"}

	claimed, err := steps.WaitForClaim(t.Context(), "clm_ok", time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Token.AccessToken != "whcc_claimed" || claimed.IdentityAssertion != "claimed-assertion" || claimed.Token.Scope != "webhooks:read webhooks:write" {
		t.Errorf("claimed = %+v", claimed)
	}
	for token, code := range map[string]string{"clm_expired": "expired_token", "clm_denied": "access_denied", "clm_unknown": "invalid_grant"} {
		_, err := steps.WaitForClaim(t.Context(), token, time.Millisecond)
		var refused *AuthError
		if !errors.As(err, &refused) || refused.Code != code {
			t.Errorf("%s: err = %v, want %s", token, err, code)
		}
	}

	answers["clm_poll"] = []string{"slow_down"}
	poll, err := steps.PollClaim(t.Context(), "clm_poll")
	if err != nil || poll.Status != ClaimSlowDown || poll.Claimed != nil {
		t.Errorf("poll = %+v, %v", poll, err)
	}
}

func TestDiscover(t *testing.T) {
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/oauth-authorization-server" {
			t.Errorf("path = %s", r.URL.Path)
		}
		writeJSON(w, 200, map[string]any{
			"issuer":                "https://example.test",
			"token_endpoint":        "https://example.test/api/oauth2/token",
			"revocation_endpoint":   "https://example.test/api/oauth2/revoke",
			"grant_types_supported": []string{"jwt-bearer"},
			"agent_auth": map[string]any{
				"identity_endpoint":        "https://example.test/api/agent/identity",
				"claim_endpoint":           "https://example.test/api/agent/identity/claim",
				"identity_types_supported": []string{"anonymous", "service_auth"},
				"anonymous": map[string]any{
					"proof_of_work": map[string]any{"challenge_endpoint": "https://example.test/api/agent/identity/challenge"},
					"sandbox":       map[string]any{"endpoints_url": "https://example.test/api/agent/sandbox/endpoints"},
				},
			},
		})
	})
	discovery, err := steps.Discover(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if discovery.ClaimEndpoint != "https://example.test/api/agent/identity/claim" || len(discovery.IdentityTypes) != 2 ||
		discovery.ChallengeEndpoint == "" || discovery.SandboxEndpointsURL == "" {
		t.Errorf("discovery = %+v", discovery)
	}
}

func TestErrorsWithoutJSONAndRedirects(t *testing.T) {
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { elsewhere.Add(1) }))
	t.Cleanup(other.Close)
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/oauth2/revoke" {
			http.Redirect(w, r, other.URL+"/steal", http.StatusTemporaryRedirect)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "<html>proxy</html>")
	})
	_, err := steps.Challenge(t.Context())
	var refused *AuthError
	if !errors.As(err, &refused) || refused.Code != "http_502" || refused.Status != 502 || refused.Details != nil {
		t.Errorf("err = %v", err)
	}
	err = steps.Revoke(t.Context(), "whcc_secret")
	if !errors.As(err, &refused) || refused.Status != http.StatusTemporaryRedirect {
		t.Errorf("err = %v", err)
	}
	if elsewhere.Load() != 0 {
		t.Error("a redirect was followed")
	}
}

func TestCallTimesOut(t *testing.T) {
	steps := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	})
	steps.Timeout = 20 * time.Millisecond
	_, err := steps.Exchange(t.Context(), "a")
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "timed out after 20ms") {
		t.Errorf("err = %v", err)
	}
}

func TestSecretsNeverPrint(t *testing.T) {
	values := []any{
		AnonymousRegistration{RegistrationID: "reg", IdentityAssertion: "ey.secret", ClaimToken: "clm_secret"},
		ServiceAuthRegistration{RegistrationID: "reg", ClaimToken: "clm_secret"},
		Token{AccessToken: "whcc_secret", Scope: "webhooks:read"},
		Claimed{Token: Token{AccessToken: "whcc_secret"}, IdentityAssertion: "ey.secret"},
	}
	for _, value := range values {
		for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
			got := fmt.Sprintf(format, value)
			if strings.Contains(got, "secret") {
				t.Fatalf("%s of %T printed a secret: %s", format, value, got)
			}
		}
	}
}
