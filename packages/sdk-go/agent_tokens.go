package webhookscc

import (
	"context"
	"errors"
	"sync"
	"time"

	"webhooks.cc/go/agent"
	"webhooks.cc/go/internal/agentfile"
)

// AgentAuthError is a registration step the server refused, such as
// invalid_grant, expired_token or access_denied. The same type as
// agent.AuthError.
type AgentAuthError = agent.AuthError

// tokenSource keeps an agent's access token fresh from its identity
// assertion. It uses the token cached in the credential file while that has
// more than a minute left, exchanges the assertion otherwise (writing the
// new token back), and exchanges again when the API refuses a token. When
// the exchange answers invalid_grant the registration is over, and its slot
// leaves the file.
type tokenSource struct {
	steps    *agent.Client
	store    *agentfile.Store
	issuer   string
	slotName string
	// exchanging serializes exchanges, so concurrent calls share one.
	exchanging chan struct{}

	mu   sync.Mutex
	slot agentfile.Slot
	// refused is the server's invalid_grant, kept so later calls fail at
	// once instead of asking again (and spending the token endpoint's limit).
	refused *AgentAuthError
}

func (c *Client) newTokenSource(slotName string, slot agentfile.Slot) *tokenSource {
	return &tokenSource{
		steps:      c.agentSteps(),
		store:      c.agentStore(),
		issuer:     c.issuer(),
		slotName:   slotName,
		exchanging: make(chan struct{}, 1),
		slot:       slot,
	}
}

// cached returns the current token when it has more than a minute left.
func (t *tokenSource) cached() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.slot.UsableToken(time.Now())
}

// token returns a usable access token, exchanging the assertion when needed.
func (t *tokenSource) token(ctx context.Context) (string, error) {
	t.mu.Lock()
	refused := t.refused
	t.mu.Unlock()
	if refused != nil {
		return "", &agentTokenError{err: refused}
	}
	if token := t.cached(); token != "" {
		return token, nil
	}
	select {
	case t.exchanging <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-t.exchanging }()
	// Another call may have exchanged while this one waited.
	if token := t.cached(); token != "" {
		return token, nil
	}
	t.mu.Lock()
	assertion := t.slot.IdentityAssertion
	t.mu.Unlock()

	fresh, err := t.steps.Exchange(ctx, assertion)
	if err != nil {
		var refused *AgentAuthError
		if !errors.As(err, &refused) {
			return "", err
		}
		if refused.Code == "invalid_grant" {
			t.mu.Lock()
			t.refused = refused
			t.slot.AccessToken, t.slot.AccessTokenExpires = "", ""
			t.mu.Unlock()
			t.forgetSlot()
		}
		return "", &agentTokenError{err: refused}
	}
	t.mu.Lock()
	t.slot.AccessToken = fresh.AccessToken
	t.slot.AccessTokenExpires = fresh.ExpiresAt.UTC().Format(agentfile.TimeFormat)
	slot := t.slot
	t.mu.Unlock()
	// Best effort: a file that cannot be written only costs the next process
	// an exchange.
	_ = t.store.Update(t.issuer, t.slotName, slot)
	return fresh.AccessToken, nil
}

// reject drops a token the API refused, unless another call replaced it
// already, so the next token call exchanges.
func (t *tokenSource) reject(token string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.slot.AccessToken == token {
		t.slot.AccessToken, t.slot.AccessTokenExpires = "", ""
	}
}

// current returns the token in memory, usable or not.
func (t *tokenSource) current() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.slot.AccessToken
}

// snapshot returns the slot as it stands.
func (t *tokenSource) snapshot() agentfile.Slot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.slot
}

// forgetSlot removes this source's slot from the credential file, unless
// another process has put another registration there since.
func (t *tokenSource) forgetSlot() {
	t.mu.Lock()
	registrationID := t.slot.RegistrationID
	t.mu.Unlock()
	_ = t.store.Remove(t.issuer, t.slotName, registrationID)
}

// forget drops the token from memory and from the file, after it was revoked.
func (t *tokenSource) forget(token string) {
	t.reject(token)
	_ = t.store.Update(t.issuer, t.slotName, t.snapshot())
}

// isInvalidGrant reports whether err is the token endpoint saying the
// registration is over.
func isInvalidGrant(err error) bool {
	var refused *AgentAuthError
	return errors.As(err, &refused) && refused.Code == "invalid_grant"
}
