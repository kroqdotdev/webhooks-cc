package tui

import (
	"context"

	"webhooks.cc/cli/internal/stream"
	"webhooks.cc/cli/internal/tunnel"
	"webhooks.cc/shared/types"

	tea "github.com/charmbracelet/bubbletea"
)

// Screen identifiers
type Screen int

const (
	ScreenMenu Screen = iota
	ScreenAuth
	ScreenTunnel
	ScreenListen
	ScreenEndpoints
	ScreenDetail
	ScreenUpdate
)

// Navigation messages
type NavigateMsg struct {
	Screen Screen
	Data   any
}

type BackMsg struct{}

// Window size (forwarded to active screen)
type WindowSizeMsg = tea.WindowSizeMsg

// SSE streaming messages
type RequestReceivedMsg struct {
	Request *types.CapturedRequest
}

type SSEErrorMsg struct {
	Err error
}

type SSEDoneMsg struct{}

// Forward result (tunnel screen)
type ForwardResultMsg struct {
	RequestID string
	Result    *tunnel.ForwardResult
}

// API response messages
type EndpointsLoadedMsg struct {
	Endpoints []Endpoint
	Err       error
}

type EndpointCreatedMsg struct {
	Endpoint *Endpoint
	Err      error
}

type EndpointDeletedMsg struct {
	Slug string
	Err  error
}

// Endpoint is a local type matching api.Endpoint
type Endpoint struct {
	ID   string
	Slug string
	Name string
	URL  string
}

// Auth messages
type AuthStatusMsg struct {
	LoggedIn bool
	Email    string
}

type DeviceCodeMsg struct {
	UserCode        string
	VerificationURL string
	DeviceCode      string
	Err             error
}

type AuthPollMsg struct {
	Status string // "pending", "authorized", "expired"
	Err    error
}

type AuthClaimedMsg struct {
	Email string
	Err   error
}

type AuthLogoutMsg struct {
	Err error
}

// Update messages
type UpdateCheckMsg struct {
	Available bool
	Version   string
	Release   any // *update.Release
	Err       error
}

type UpdateApplyMsg struct {
	Err error
}

// SSE helpers

// SSESession manages a Server-Sent Events connection for real-time webhook streaming.
type SSESession struct {
	cancel context.CancelFunc
	Ch     chan *types.CapturedRequest
	ErrCh  chan error
}

func StartSSE(s *stream.Stream) (*SSESession, tea.Cmd) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan *types.CapturedRequest, 32)
	errCh := make(chan error, 1)

	go func() {
		defer close(ch)
		if err := s.Listen(ctx, func(req *types.CapturedRequest) {
			select {
			case ch <- req:
			case <-ctx.Done():
			}
		}); err != nil && ctx.Err() == nil {
			errCh <- err
		}
	}()

	session := &SSESession{cancel: cancel, Ch: ch, ErrCh: errCh}
	return session, waitForSSE(session)
}

func (s *SSESession) Stop() {
	s.cancel()
}

func waitForSSE(session *SSESession) tea.Cmd {
	return func() tea.Msg {
		select {
		case req, ok := <-session.Ch:
			if !ok {
				// Channel closed — check if there's a pending error
				select {
				case err := <-session.ErrCh:
					return SSEErrorMsg{Err: err}
				default:
					return SSEDoneMsg{}
				}
			}
			return RequestReceivedMsg{Request: req}
		case err := <-session.ErrCh:
			return SSEErrorMsg{Err: err}
		}
	}
}

func WaitForSSE(session *SSESession) tea.Cmd {
	return waitForSSE(session)
}
