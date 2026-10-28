package webhookscc_test

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

// fakeReg is one registration the fake auth server knows.
type fakeReg struct {
	id         string
	kind       string // anonymous or service_auth
	assertion  string
	claimToken string
	email      string
	claimed    bool
	// account is the claimed assertion, once claimed.
	account string
}

// fakeAgentServer implements the registration, token, claim and sandbox
// routes, and GET /api/endpoints for account tokens.
type fakeAgentServer struct {
	t      *testing.T
	server *httptest.Server

	mu                 sync.Mutex
	next               int
	regs               map[string]*fakeReg // by any assertion, pre-claim or claimed
	byClaimToken       map[string]*fakeReg
	tokens             map[string]string // live access token -> assertion
	endpoints          map[string][]map[string]any
	freshChallengeOnce bool
	pendingPolls       int
	endpointLimit      int
	rateLimitNext      bool

	registrations, serviceAuths, exchanges, claimStarts, polls, revokes int
	clientNames                                                         []string
	accountAuth                                                         []string
	streamAuth                                                          []string
}

func newFakeAgentServer(t *testing.T) *fakeAgentServer {
	f := &fakeAgentServer{
		t:             t,
		regs:          map[string]*fakeReg{},
		byClaimToken:  map[string]*fakeReg{},
		tokens:        map[string]string{},
		endpoints:     map[string][]map[string]any{},
		endpointLimit: 3,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/agent/identity/challenge", f.challenge)
	mux.HandleFunc("POST /api/agent/identity", f.identity)
	mux.HandleFunc("POST /api/agent/identity/claim", f.claim)
	mux.HandleFunc("POST /api/oauth2/token", f.token)
	mux.HandleFunc("POST /api/oauth2/revoke", f.revoke)
	mux.HandleFunc("/api/agent/sandbox/", f.sandbox)
	mux.HandleFunc("GET /api/endpoints", f.account)
	mux.HandleFunc("GET /api/stream/{slug}", f.stream)
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeAgentServer) options(extra ...webhookscc.Option) []webhookscc.Option {
	return append([]webhookscc.Option{webhookscc.WithBaseURL(f.server.URL), webhookscc.WithWebhookURL(f.server.URL)}, extra...)
}

// issuer is the server's key in the credential file.
func (f *fakeAgentServer) issuer() string { return f.server.URL }

func (f *fakeAgentServer) newID() int {
	f.next++
	return f.next
}

func (f *fakeAgentServer) addClaimed(id, assertion string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reg := &fakeReg{id: id, kind: "service_auth", claimed: true, account: assertion}
	f.regs[assertion] = reg
}

// dropTokens forgets every live token, as if they had expired.
func (f *fakeAgentServer) dropTokens() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens = map[string]string{}
}

func (f *fakeAgentServer) count(n *int) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return *n
}

const fakeDifficulty = 2

func (f *fakeAgentServer) newChallenge() map[string]any {
	return map[string]any{
		"challenge":  fmt.Sprintf("pow1.c%d.mac", f.newID()),
		"algorithm":  "sha256-zero-bits",
		"difficulty": fakeDifficulty,
		"count":      2,
		"expires_at": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
	}
}

func (f *fakeAgentServer) challenge(w http.ResponseWriter, _ *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	writeJSON(w, 200, f.newChallenge())
}

func validProof(challenge string, nonces []string) bool {
	if len(nonces) != 2 {
		return false
	}
	for i, nonce := range nonces {
		sum := sha256.Sum256([]byte(challenge + "." + strconv.Itoa(i) + "." + nonce))
		if sum[0]>>(8-fakeDifficulty) != 0 {
			return false
		}
	}
	return true
}

func claimBlock(code string) map[string]any {
	return map[string]any{"user_code": code, "expires_in": 900, "verification_uri": "https://example.test/agent/claim?attempt=" + code, "interval": 0.01}
}

func (f *fakeAgentServer) identity(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type        string `json:"type"`
		ClientName  string `json:"client_name"`
		LoginHint   string `json:"login_hint"`
		ProofOfWork struct {
			Challenge string   `json:"challenge"`
			Nonces    []string `json:"nonces"`
		} `json:"proof_of_work"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clientNames = append(f.clientNames, body.ClientName)
	expires := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339Nano)
	n := f.newID()
	switch body.Type {
	case "anonymous":
		if f.freshChallengeOnce {
			f.freshChallengeOnce = false
			fresh := f.newChallenge()
			fresh["error"] = "invalid_challenge"
			writeJSON(w, 400, fresh)
			return
		}
		if !validProof(body.ProofOfWork.Challenge, body.ProofOfWork.Nonces) {
			f.t.Errorf("invalid proof %v", body.ProofOfWork)
		}
		f.registrations++
		reg := &fakeReg{id: fmt.Sprintf("reg-%d", n), kind: "anonymous", assertion: fmt.Sprintf("assert-%d", n), claimToken: fmt.Sprintf("clm_%d", n)}
		f.regs[reg.assertion] = reg
		f.byClaimToken[reg.claimToken] = reg
		writeJSON(w, 200, map[string]any{
			"registration_id": reg.id, "registration_type": "anonymous",
			"identity_assertion": reg.assertion, "assertion_expires": expires,
			"pre_claim_scopes": []string{"webhooks:sandbox"},
			"claim_token":      reg.claimToken, "claim_token_expires": expires,
			"post_claim_scopes": []string{"webhooks:read", "webhooks:write"},
			"sandbox":           map[string]any{"status": "available"},
		})
	case "service_auth":
		f.serviceAuths++
		reg := &fakeReg{id: fmt.Sprintf("svc-%d", n), kind: "service_auth", claimToken: fmt.Sprintf("clm_%d", n), email: body.LoginHint}
		f.byClaimToken[reg.claimToken] = reg
		writeJSON(w, 200, map[string]any{
			"registration_id": reg.id, "registration_type": "service_auth",
			"claim_token": reg.claimToken, "claim_token_expires": expires,
			"post_claim_scopes": []string{"webhooks:read", "webhooks:write"},
			"claim":             claimBlock(fmt.Sprintf("%06d", n)),
		})
	default:
		writeJSON(w, 400, map[string]any{"error": "invalid_request"})
	}
}

func (f *fakeAgentServer) claim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClaimToken string `json:"claim_token"`
		Email      string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	defer f.mu.Unlock()
	reg := f.byClaimToken[body.ClaimToken]
	if reg == nil {
		writeJSON(w, 401, map[string]any{"error": "invalid_claim_token"})
		return
	}
	f.claimStarts++
	reg.email = body.Email
	writeJSON(w, 200, map[string]any{"registration_id": reg.id, "status": "initiated", "claim_attempt": claimBlock(fmt.Sprintf("%06d", f.newID()))})
}

func (f *fakeAgentServer) issueToken(assertion string) string {
	token := fmt.Sprintf("whcc_tok_%d", f.newID())
	f.tokens[token] = assertion
	return token
}

func (f *fakeAgentServer) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.PostForm.Has("resource") {
		f.t.Errorf("the exchange sent resource=%q", r.PostForm.Get("resource"))
	}
	switch r.PostForm.Get("grant_type") {
	case "urn:ietf:params:oauth:grant-type:jwt-bearer":
		f.exchanges++
		assertion := r.PostForm.Get("assertion")
		reg := f.regs[assertion]
		// A pre-claim assertion stops working once its registration is claimed.
		if reg == nil || (reg.claimed && assertion != reg.account) {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "The registration expired or was revoked."})
			return
		}
		scope := "webhooks:sandbox"
		if reg.claimed {
			scope = "webhooks:read webhooks:write"
		}
		writeJSON(w, 200, map[string]any{"access_token": f.issueToken(assertion), "token_type": "Bearer", "expires_in": 3600, "scope": scope})
	case "urn:workos:agent-auth:grant-type:claim":
		f.polls++
		reg := f.byClaimToken[r.PostForm.Get("claim_token")]
		if reg == nil || reg.claimed {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant"})
			return
		}
		if f.pendingPolls > 0 {
			f.pendingPolls--
			writeJSON(w, 400, map[string]any{"error": "authorization_pending"})
			return
		}
		reg.claimed = true
		reg.account = "account-" + reg.id
		f.regs[reg.account] = reg
		for token, assertion := range f.tokens {
			if assertion == reg.assertion {
				delete(f.tokens, token)
			}
		}
		writeJSON(w, 200, map[string]any{
			"access_token": f.issueToken(reg.account), "token_type": "Bearer", "expires_in": 3600,
			"scope": "webhooks:read webhooks:write", "identity_assertion": reg.account,
			"assertion_expires": time.Now().Add(90 * 24 * time.Hour).UTC().Format(time.RFC3339Nano),
		})
	default:
		writeJSON(w, 400, map[string]any{"error": "unsupported_grant_type"})
	}
}

func (f *fakeAgentServer) revoke(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revokes++
	delete(f.tokens, r.PostForm.Get("token"))
	writeJSON(w, 200, map[string]any{})
}

// bearerReg is the registration of the request's token and the assertion
// the token came from.
func (f *fakeAgentServer) bearerReg(r *http.Request) (*fakeReg, string) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	assertion, ok := f.tokens[token]
	if !ok {
		return nil, ""
	}
	return f.regs[assertion], assertion
}

func (f *fakeAgentServer) sandbox(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reg, assertion := f.bearerReg(r)
	switch {
	case reg == nil:
		writeJSON(w, 401, map[string]any{"error": "invalid_token"})
		return
	case reg.claimed || assertion != reg.assertion:
		writeJSON(w, 403, map[string]any{"error": "sandbox_closed", "error_description": "This registration was claimed."})
		return
	case f.rateLimitNext:
		f.rateLimitNext = false
		w.Header().Set("Retry-After", "7")
		writeJSON(w, 429, map[string]any{"error": "rate_limited"})
		return
	}
	limits := map[string]any{"expiresAt": time.Now().Add(24 * time.Hour).UnixMilli(), "maxEndpoints": 3, "requestLimit": 25, "budget": map[string]any{"used": 1, "limit": 100}}
	path := strings.TrimPrefix(r.URL.Path, "/api/agent/sandbox")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	find := func(slug string) map[string]any {
		for _, endpoint := range f.endpoints[reg.id] {
			if endpoint["slug"] == slug {
				return endpoint
			}
		}
		return nil
	}
	switch {
	case r.Method == http.MethodPost && path == "/endpoints":
		if len(f.endpoints[reg.id]) >= f.endpointLimit {
			writeJSON(w, 409, map[string]any{"error": "sandbox_endpoint_limit", "error_description": "A sandbox registration holds at most 3 endpoints."})
			return
		}
		slug := fmt.Sprintf("sbx-%d", f.newID())
		endpoint := map[string]any{"id": "id-" + slug, "slug": slug, "url": "https://go.example.test/w/" + slug, "requestCount": 0, "isEphemeral": true, "sandbox": limits}
		f.endpoints[reg.id] = append(f.endpoints[reg.id], endpoint)
		writeJSON(w, 201, endpoint)
	case r.Method == http.MethodGet && path == "/endpoints":
		writeJSON(w, 200, map[string]any{"endpoints": f.endpoints[reg.id], "sandbox": limits})
	case len(parts) == 2 && parts[0] == "endpoints":
		endpoint := find(parts[1])
		if endpoint == nil {
			writeJSON(w, 404, map[string]any{"error": "not_found", "error_description": "No such sandbox endpoint for this registration."})
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, endpoint)
	case len(parts) == 3 && parts[2] == "requests":
		if find(parts[1]) == nil {
			writeJSON(w, 404, map[string]any{"error": "not_found"})
			return
		}
		writeJSON(w, 200, []any{requestJSON("req-1", time.Now().UnixMilli(), map[string]any{"body": `{"type":"ping"}`})})
	case len(parts) == 2 && parts[0] == "requests":
		writeJSON(w, 200, requestJSON(parts[1], time.Now().UnixMilli(), nil))
	default:
		writeJSON(w, 404, map[string]any{"error": "not_found"})
	}
}

func (f *fakeAgentServer) account(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accountAuth = append(f.accountAuth, r.Header.Get("Authorization"))
	reg, assertion := f.bearerReg(r)
	if reg == nil || !reg.claimed || assertion != reg.account {
		writeJSON(w, 401, map[string]any{"error": "Unauthorized"})
		return
	}
	writeJSON(w, 200, map[string]any{"owned": []any{map[string]any{"id": "e1", "slug": "acct-1"}}, "shared": []any{}})
}

func (f *fakeAgentServer) stream(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.streamAuth = append(f.streamAuth, r.Header.Get("Authorization"))
	reg, assertion := f.bearerReg(r)
	f.mu.Unlock()
	if reg == nil || assertion != reg.account {
		writeJSON(w, 401, map[string]any{"error": "Unauthorized"})
		return
	}
	sseStart(w)
	sseRequest(w, "streamed-1", time.Now().UnixMilli())
	fmt.Fprint(w, "event: endpoint_deleted\ndata: {}\n\n")
}

// --- the credential file -------------------------------------------------------------

// isolateAgentFile points WHK_AGENT_FILE at a new file and clears
// WHK_API_KEY, so nothing on this machine leaks in.
func isolateAgentFile(t *testing.T) string {
	t.Helper()
	t.Setenv(webhookscc.APIKeyEnv, "")
	path := filepath.Join(t.TempDir(), "whk", "agent.json")
	t.Setenv(webhookscc.AgentFileEnv, path)
	return path
}

func readAgentFile(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]any
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("the credential file is not JSON: %v", err)
	}
	return file
}

// slotIn returns a slot of the file for an issuer, or nil.
func slotIn(file map[string]any, issuer, name string) map[string]any {
	issuers, _ := file["issuers"].(map[string]any)
	entry, _ := issuers[issuer].(map[string]any)
	slot, _ := entry[name].(map[string]any)
	return slot
}

func writeAgentFile(t *testing.T, path, issuer string, slots map[string]map[string]any) {
	t.Helper()
	entry := map[string]any{}
	for name, slot := range slots {
		entry[name] = slot
	}
	data, _ := json.Marshal(map[string]any{"version": 1, "issuers": map[string]any{issuer: entry}})
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func isoIn(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339Nano) }

func assertPrivate(t *testing.T, path string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("credential file mode = %o, want 600", mode)
	}
}

// --- tests ---------------------------------------------------------------------------

func TestSandboxRegistersCapturesAndSavesTheSlot(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	f.freshChallengeOnce = true

	sandbox, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(&f.registrations) != 1 || f.count(&f.exchanges) != 1 {
		t.Errorf("registrations = %d, exchanges = %d", f.registrations, f.exchanges)
	}
	if f.clientNames[len(f.clientNames)-1] != webhookscc.DefaultClientName {
		t.Errorf("client_name = %q", f.clientNames)
	}
	if !strings.HasPrefix(sandbox.RegistrationID(), "reg-") || time.Until(sandbox.ExpiresAt()) < 23*time.Hour {
		t.Errorf("registration %q expires %s", sandbox.RegistrationID(), sandbox.ExpiresAt())
	}

	slot := slotIn(readAgentFile(t, path), f.issuer(), "sandbox")
	if slot == nil || slot["registration_id"] != sandbox.RegistrationID() || slot["client_name"] != webhookscc.DefaultClientName ||
		!strings.HasPrefix(fmt.Sprint(slot["access_token"]), "whcc_") || slot["scope"] != "webhooks:sandbox" {
		t.Errorf("sandbox slot = %v", slot)
	}
	if _, has := slot["claim_token"]; has {
		t.Error("the claim token was written to the file")
	}
	assertPrivate(t, path)

	endpoint, err := sandbox.Endpoints.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(endpoint.Slug, "sbx-") || endpoint.URL == "" || endpoint.Limits.MaxEndpoints != 3 ||
		endpoint.Limits.BudgetLimit != 100 || endpoint.Limits.BudgetUsed != 1 || endpoint.Limits.ExpiresAt.IsZero() {
		t.Errorf("endpoint = %+v", endpoint)
	}
	endpoints, err := sandbox.Endpoints.List(t.Context())
	if err != nil || len(endpoints) != 1 || endpoints[0].Slug != endpoint.Slug {
		t.Errorf("List = %+v, %v", endpoints, err)
	}
	request, err := sandbox.Requests.WaitFor(t.Context(), endpoint.Slug, webhookscc.WaitOptions{
		Timeout: 5 * time.Second,
		Match:   webhookscc.MatchBodyPath("type", "ping"),
	})
	if err != nil || request.ID != "req-1" {
		t.Fatalf("WaitFor = %+v, %v", request, err)
	}
	if got, err := sandbox.Requests.Get(t.Context(), "req-9"); err != nil || got.ID != "req-9" {
		t.Errorf("Get = %+v, %v", got, err)
	}
	if err := sandbox.Endpoints.Delete(t.Context(), endpoint.Slug); err != nil {
		t.Error(err)
	}
	if _, err := sandbox.Requests.WaitForAll(t.Context(), endpoint.Slug, 26, webhookscc.WaitOptions{}); err == nil {
		t.Error("WaitForAll took a count above what a sandbox endpoint captures")
	}
}

func TestSandboxReusesTheSlotAndItsCachedToken(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	first, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	// A second process: the same registration, and the token from the file.
	second, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if second.RegistrationID() != first.RegistrationID() {
		t.Errorf("registered again: %s, then %s", first.RegistrationID(), second.RegistrationID())
	}
	if f.count(&f.registrations) != 1 || f.count(&f.exchanges) != 1 {
		t.Errorf("registrations = %d, exchanges = %d, want 1 and 1", f.registrations, f.exchanges)
	}
	if _, err := second.Endpoints.Create(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.count(&f.exchanges) != 1 {
		t.Errorf("the cached token was not used: %d exchanges", f.exchanges)
	}

	// Without the file, every sandbox registers.
	if _, err := webhookscc.NewSandbox(t.Context(), f.options(webhookscc.WithAgentFile(""))...); err != nil {
		t.Fatal(err)
	}
	if f.count(&f.registrations) != 2 {
		t.Errorf("registrations = %d, want 2", f.registrations)
	}
	if slot := slotIn(readAgentFile(t, path), f.issuer(), "sandbox"); slot["registration_id"] != first.RegistrationID() {
		t.Errorf("WithAgentFile(\"\") wrote the file: %v", slot)
	}
}

func TestSandboxExchangesAgainAfterA401(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	sandbox, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	before := slotIn(readAgentFile(t, path), f.issuer(), "sandbox")["access_token"]
	f.dropTokens()
	if _, err := sandbox.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.count(&f.exchanges) != 2 {
		t.Errorf("exchanges = %d, want 2", f.exchanges)
	}
	after := slotIn(readAgentFile(t, path), f.issuer(), "sandbox")["access_token"]
	if after == before || !strings.HasPrefix(fmt.Sprint(after), "whcc_") {
		t.Errorf("cached token %v, then %v", before, after)
	}

	// RevokeToken drops it, and the next call exchanges a new one.
	if err := sandbox.RevokeToken(t.Context()); err != nil {
		t.Fatal(err)
	}
	if slot := slotIn(readAgentFile(t, path), f.issuer(), "sandbox"); slot["access_token"] != nil || slot["registration_id"] != sandbox.RegistrationID() {
		t.Errorf("after RevokeToken the slot is %v", slot)
	}
	if _, err := sandbox.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.count(&f.revokes) != 1 || f.count(&f.exchanges) != 3 {
		t.Errorf("revokes = %d, exchanges = %d", f.revokes, f.exchanges)
	}
}

func TestSandboxInvalidGrantDropsTheSlotAndRegistersAgain(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	writeAgentFile(t, path, f.issuer(), map[string]map[string]any{
		"sandbox": {"registration_id": "gone", "identity_assertion": "unknown-assertion", "assertion_expires": isoIn(time.Hour)},
	})
	sandbox, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if sandbox.RegistrationID() == "gone" || f.count(&f.registrations) != 1 {
		t.Errorf("registration %s after %d registrations", sandbox.RegistrationID(), f.registrations)
	}
	if slot := slotIn(readAgentFile(t, path), f.issuer(), "sandbox"); slot["registration_id"] != sandbox.RegistrationID() {
		t.Errorf("sandbox slot = %v", slot)
	}
}

func TestSandboxClaimMovesTheEndpointsAndSavesTheConnection(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	sandbox, err := webhookscc.NewSandbox(t.Context(), f.options(webhookscc.WithClientName("claim-test"))...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sandbox.WaitForClaim(t.Context()); err == nil {
		t.Error("WaitForClaim before Claim succeeded")
	}
	attempt, err := sandbox.Claim(t.Context(), "dev@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !attempt.MovesEndpoints || attempt.UserCode == "" || attempt.VerificationURI == "" || attempt.Interval != 10*time.Millisecond {
		t.Errorf("attempt = %+v", attempt)
	}
	if f.count(&f.claimStarts) != 1 || f.count(&f.serviceAuths) != 0 {
		t.Errorf("claimStarts = %d, serviceAuths = %d", f.claimStarts, f.serviceAuths)
	}

	f.mu.Lock()
	f.pendingPolls = 2
	f.mu.Unlock()
	client, err := sandbox.WaitForClaim(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if f.count(&f.polls) != 3 {
		t.Errorf("polls = %d, want 3", f.polls)
	}
	file := readAgentFile(t, path)
	claimed := slotIn(file, f.issuer(), "claimed")
	if claimed == nil || claimed["registration_id"] != sandbox.RegistrationID() || claimed["email"] != "dev@example.com" ||
		claimed["identity_assertion"] != "account-"+sandbox.RegistrationID() || claimed["client_name"] != "claim-test" ||
		!strings.HasPrefix(fmt.Sprint(claimed["access_token"]), "whcc_") || claimed["scope"] != "webhooks:read webhooks:write" {
		t.Errorf("claimed slot = %v", claimed)
	}
	if slotIn(file, f.issuer(), "sandbox") != nil {
		t.Error("the sandbox slot of the claimed registration is still there")
	}
	assertPrivate(t, path)

	endpoints, err := client.Endpoints.List(t.Context())
	if err != nil || len(endpoints) != 1 {
		t.Fatalf("account List = %+v, %v", endpoints, err)
	}
	// The claimed sandbox stops working without asking the server.
	_, err = sandbox.Endpoints.List(t.Context())
	var refusal *webhookscc.SandboxError
	if !errors.As(err, &refusal) || refusal.Code != "sandbox_closed" {
		t.Errorf("sandbox after the claim: %v", err)
	}

	// A later process finds the connection.
	later, err := webhookscc.New(f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := later.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.count(&f.exchanges) != 1 {
		t.Errorf("exchanges = %d, want only the sandbox's (the claim's token is cached)", f.exchanges)
	}
}

func TestSandboxFromTheFileClaimsWithServiceAuth(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	if _, err := webhookscc.NewSandbox(t.Context(), f.options()...); err != nil {
		t.Fatal(err)
	}
	// Another process, which has the registration but not its claim token.
	sandbox, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := sandbox.Claim(t.Context(), "dev@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if attempt.MovesEndpoints || f.count(&f.serviceAuths) != 1 || f.count(&f.claimStarts) != 0 {
		t.Errorf("attempt = %+v, serviceAuths = %d, claimStarts = %d", attempt, f.serviceAuths, f.claimStarts)
	}
	// Asking again for the same email gives a new code for the same registration.
	again, err := sandbox.Claim(t.Context(), "dev@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if again.UserCode == attempt.UserCode || f.count(&f.serviceAuths) != 1 || f.count(&f.claimStarts) != 1 {
		t.Errorf("again = %+v, serviceAuths = %d, claimStarts = %d", again, f.serviceAuths, f.claimStarts)
	}

	client, err := sandbox.WaitForClaim(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	file := readAgentFile(t, path)
	claimed := slotIn(file, f.issuer(), "claimed")
	if claimed == nil || !strings.HasPrefix(fmt.Sprint(claimed["registration_id"]), "svc-") {
		t.Errorf("claimed slot = %v", claimed)
	}
	if slot := slotIn(file, f.issuer(), "sandbox"); slot["registration_id"] != sandbox.RegistrationID() {
		t.Errorf("the sandbox slot of another registration went: %v", slot)
	}
	// The sandbox keeps working until it expires.
	if _, err := sandbox.Endpoints.List(t.Context()); err != nil {
		t.Errorf("sandbox after a service_auth claim: %v", err)
	}
}

func TestSandboxRefusalsAreTyped(t *testing.T) {
	isolateAgentFile(t)
	f := newFakeAgentServer(t)
	f.endpointLimit = 0
	sandbox, err := webhookscc.NewSandbox(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	_, err = sandbox.Endpoints.Create(t.Context())
	var refusal *webhookscc.SandboxError
	if !errors.As(err, &refusal) || refusal.Code != "sandbox_endpoint_limit" || refusal.StatusCode != 409 ||
		!strings.Contains(refusal.Message, "at most 3") {
		t.Errorf("Create = %v", err)
	}
	var apiErr *webhookscc.Error
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 409 {
		t.Errorf("a SandboxError should unwrap to an *Error: %v", err)
	}

	_, err = sandbox.Endpoints.Get(t.Context(), "nope")
	if !errors.Is(err, webhookscc.ErrNotFound) || !errors.As(err, &refusal) || refusal.Code != "not_found" {
		t.Errorf("Get = %v", err)
	}

	f.mu.Lock()
	f.rateLimitNext = true
	f.mu.Unlock()
	_, err = sandbox.Endpoints.List(t.Context())
	if !errors.Is(err, webhookscc.ErrRateLimited) || !errors.As(err, &apiErr) || apiErr.RetryAfter != 7*time.Second {
		t.Errorf("List = %v", err)
	}
}

func TestConnectedNeedsALiveConnection(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	if _, err := webhookscc.Connected(t.Context(), f.options()...); !errors.Is(err, webhookscc.ErrNotConnected) {
		t.Fatalf("no file: err = %v", err)
	}

	// A usable cached token: nothing is sent.
	f.addClaimed("reg-c", "claimed-assertion")
	writeAgentFile(t, path, f.issuer(), map[string]map[string]any{
		"claimed": {
			"registration_id": "reg-c", "identity_assertion": "claimed-assertion", "assertion_expires": isoIn(90 * 24 * time.Hour),
			"access_token": "whcc_stale", "access_token_expires": isoIn(time.Hour),
		},
	})
	client, err := webhookscc.Connected(t.Context(), f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(&f.exchanges) != 0 {
		t.Errorf("exchanges = %d, want 0", f.exchanges)
	}
	// The server no longer knows the cached token: one exchange, then it works.
	if _, err := client.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.count(&f.exchanges) != 1 || len(f.accountAuth) != 2 || f.accountAuth[0] != "Bearer whcc_stale" {
		t.Errorf("exchanges = %d, auth = %v", f.exchanges, f.accountAuth)
	}

	// The human disconnected the agent: the slot goes, and so does the file.
	writeAgentFile(t, path, f.issuer(), map[string]map[string]any{
		"claimed": {"registration_id": "reg-x", "identity_assertion": "disconnected", "assertion_expires": isoIn(time.Hour)},
	})
	_, err = webhookscc.Connected(t.Context(), f.options()...)
	var refused *webhookscc.AgentAuthError
	if !errors.Is(err, webhookscc.ErrNotConnected) || !errors.As(err, &refused) || refused.Code != "invalid_grant" {
		t.Errorf("disconnected: err = %v", err)
	}
	if file := readAgentFile(t, path); file != nil {
		t.Errorf("the file is still there: %v", file)
	}
}

func TestNewFallsBackToTheConnection(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	_, err := webhookscc.New(f.options()...)
	if !errors.Is(err, webhookscc.ErrMissingAPIKey) || !strings.Contains(err.Error(), "NewSandbox") || !strings.Contains(err.Error(), "Connect") {
		t.Fatalf("err = %v", err)
	}

	f.addClaimed("reg-c", "claimed-assertion")
	writeAgentFile(t, path, f.issuer(), map[string]map[string]any{
		"claimed": {"registration_id": "reg-c", "identity_assertion": "claimed-assertion", "assertion_expires": isoIn(90 * 24 * time.Hour)},
	})
	client, err := webhookscc.New(f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(&f.exchanges) != 0 {
		t.Error("New sent something")
	}
	if _, err := client.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	slot := slotIn(readAgentFile(t, path), f.issuer(), "claimed")
	if f.count(&f.exchanges) != 1 || !strings.HasPrefix(fmt.Sprint(slot["access_token"]), "whcc_tok_") {
		t.Errorf("exchanges = %d, slot = %v", f.exchanges, slot)
	}

	// The stream re-exchanges after a 401 too.
	f.dropTokens()
	var ids []string
	for request, err := range client.Requests.Subscribe(t.Context(), "acct-1", webhookscc.SubscribeOptions{Timeout: 5 * time.Second}) {
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, request.ID)
	}
	if len(ids) != 1 || f.count(&f.exchanges) != 2 || len(f.streamAuth) != 2 {
		t.Errorf("ids = %v, exchanges = %d, stream auth = %v", ids, f.exchanges, f.streamAuth)
	}

	// An API key wins, and the file is not used.
	t.Setenv(webhookscc.APIKeyEnv, "whcc_key")
	keyed, err := webhookscc.New(f.options()...)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = keyed.Endpoints.List(t.Context())
	if last := f.accountAuth[len(f.accountAuth)-1]; last != "Bearer whcc_key" {
		t.Errorf("auth = %q, want the API key", last)
	}
}

func TestConnectWaitsForTheHumanAndSavesTheConnection(t *testing.T) {
	path := isolateAgentFile(t)
	f := newFakeAgentServer(t)
	if _, err := webhookscc.Connect(t.Context(), "", f.options()...); err == nil {
		t.Error("Connect without an email succeeded")
	}
	connection, err := webhookscc.Connect(t.Context(), "dev@example.com", f.options(webhookscc.WithClientName("connect-test"))...)
	if err != nil {
		t.Fatal(err)
	}
	first := connection.Attempt()
	if first.UserCode == "" || first.MovesEndpoints || f.clientNames[0] != "connect-test" {
		t.Errorf("attempt = %+v, client names = %v", first, f.clientNames)
	}
	renewed, err := connection.NewCode(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if renewed.UserCode == first.UserCode || connection.Attempt().UserCode != renewed.UserCode {
		t.Errorf("NewCode = %+v", renewed)
	}
	f.mu.Lock()
	f.pendingPolls = 1
	f.mu.Unlock()
	client, err := connection.Wait(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Endpoints.List(t.Context()); err != nil {
		t.Fatal(err)
	}
	slot := slotIn(readAgentFile(t, path), f.issuer(), "claimed")
	if slot["registration_id"] != connection.RegistrationID() || slot["email"] != "dev@example.com" || slot["client_name"] != "connect-test" {
		t.Errorf("claimed slot = %v", slot)
	}
	assertPrivate(t, path)
	if _, err := webhookscc.Connected(t.Context(), f.options()...); err != nil {
		t.Errorf("Connected after Connect: %v", err)
	}
}
