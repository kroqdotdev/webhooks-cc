package webhookscc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"webhooks.cc/go/agent"
	"webhooks.cc/go/internal/agentfile"
)

// Connection is an agent waiting for a human to connect it to their
// account, from Connect. It is safe for concurrent use.
type Connection struct {
	opts           []Option
	steps          *agent.Client
	email          string
	registrationID string
	claimToken     string

	mu      sync.Mutex
	attempt ClaimAttempt
}

// Connect starts connecting an agent to the account of the human with this
// email, without a sandbox and without proof of work (auth.md
// service_auth). Show them the Attempt's VerificationURI and UserCode; once
// they sign in and enter the code, Wait returns a Client for their account
// and saves the connection in the agent credential file, where New and
// Connected find it from then on.
//
//	connection, err := webhookscc.Connect(ctx, "dev@example.com", webhookscc.WithClientName("my-agent"))
//	if err != nil {
//		return err
//	}
//	attempt := connection.Attempt()
//	fmt.Printf("Open %s, sign in, and enter %s\n", attempt.VerificationURI, attempt.UserCode)
//	client, err := connection.Wait(ctx)
func Connect(ctx context.Context, email string, opts ...Option) (*Connection, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return nil, errors.New("webhooks.cc: Connect needs the email address of the human who connects the agent")
	}
	c, err := configure(opts)
	if err != nil {
		return nil, err
	}
	steps := c.agentSteps()
	registration, err := steps.RegisterServiceAuth(ctx, email, c.clientName)
	if err != nil {
		return nil, err
	}
	return &Connection{
		opts:           opts,
		steps:          steps,
		email:          email,
		registrationID: registration.RegistrationID,
		claimToken:     registration.ClaimToken,
		attempt:        *claimAttempt(registration.Claim, false),
	}, nil
}

// RegistrationID identifies the registration, for logs.
func (p *Connection) RegistrationID() string { return p.registrationID }

// Attempt is the current code to show the human.
func (p *Connection) Attempt() ClaimAttempt {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.attempt
}

// NewCode replaces the code, after the old one expired (Wait failed with
// expired_token) or the human lost it. The old code stops working.
func (p *Connection) NewCode(ctx context.Context) (*ClaimAttempt, error) {
	started, err := p.steps.StartClaim(ctx, p.claimToken, p.email)
	if err != nil {
		return nil, err
	}
	attempt := claimAttempt(*started, false)
	p.mu.Lock()
	p.attempt = *attempt
	p.mu.Unlock()
	return attempt, nil
}

// Wait waits until the human enters the code, then returns a Client acting
// for their account and saves the connection in the agent credential file.
// It fails with an AgentAuthError with Code expired_token when the code ran
// out (call NewCode) or access_denied when the human declined. Without a
// deadline on ctx it gives up shortly after the code expires, with a
// TimeoutError.
func (p *Connection) Wait(ctx context.Context) (*Client, error) {
	claimed, err := waitForClaim(ctx, p.steps, p.claimToken, p.Attempt())
	if err != nil {
		return nil, err
	}
	return connectedClient(p.opts, p.registrationID, p.email, claimed)
}

// Connected returns a Client for the account an agent was connected to, from
// the live connection in the agent credential file for the base URL (saved
// by Connect, Sandbox.WaitForClaim, the MCP server or the whk CLI). Without
// one it returns ErrNotConnected, also when the human disconnected the
// agent, whose connection then leaves the file. It sends nothing when the
// file holds a usable token, and exchanges the connection's assertion for
// one otherwise.
//
// New does the same when it gets no API key, without the up-front check.
func Connected(ctx context.Context, opts ...Option) (*Client, error) {
	c, err := configure(opts)
	if err != nil {
		return nil, err
	}
	claimed := c.agentStore().Load(c.issuer(), time.Now()).Claimed
	if claimed == nil {
		return nil, ErrNotConnected
	}
	c.apiKey = ""
	c.tokens = c.newTokenSource(agentfile.Claimed, *claimed)
	if _, err := c.tokens.token(ctx); err != nil {
		if isInvalidGrant(err) {
			return nil, fmt.Errorf("%w: %w", ErrNotConnected, err)
		}
		return nil, err
	}
	return c, nil
}

// String describes the connection without its claim token, which collects
// the account's tokens once the human approves.
func (p *Connection) String() string {
	attempt := p.Attempt()
	return fmt.Sprintf("Connection{RegistrationID: %s, UserCode: %s, VerificationURI: %s}",
		p.registrationID, attempt.UserCode, attempt.VerificationURI)
}

// GoString keeps %#v from printing the claim token too.
func (p *Connection) GoString() string { return p.String() }
