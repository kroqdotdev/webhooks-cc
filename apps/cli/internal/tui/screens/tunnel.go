package screens

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"webhooks.cc/cli/internal/api"
	"webhooks.cc/cli/internal/auth"
	"webhooks.cc/cli/internal/stream"
	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"
	"webhooks.cc/cli/internal/tunnel"
	"webhooks.cc/shared/types"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type tunnelState int

const (
	tunnelInput tunnelState = iota
	tunnelConnecting
	tunnelActive
)

type tunnelRequest struct {
	req    *types.CapturedRequest
	result *tunnel.ForwardResult
}

type TunnelModel struct {
	client     *api.Client
	width      int
	height     int
	state      tunnelState
	portInput  textinput.Model
	spinner    spinner.Model
	slug       string
	webhookURL string
	targetURL  string
	requests   []tunnelRequest
	scrollPos  int
	err        error
	sseSession *tui.SSESession
	tun        *tunnel.Tunnel
	epCreated  bool // whether we created an ephemeral endpoint
}

func NewTunnel(client *api.Client) TunnelModel {
	ti := textinput.New()
	ti.Placeholder = "8080"
	ti.Focus()
	ti.CharLimit = 5
	ti.Validate = func(s string) error {
		for _, r := range s {
			if r < '0' || r > '9' {
				return fmt.Errorf("digits only")
			}
		}
		return nil
	}

	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(tui.ColorPrimary)

	return TunnelModel{
		client:    client,
		state:     tunnelInput,
		portInput: ti,
		spinner:   s,
	}
}

func (m TunnelModel) Init() tea.Cmd {
	return m.portInput.Cursor.BlinkCmd()
}

func (m TunnelModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		switch {
		case key.Matches(msg, tui.Keys.Quit):
			m.cleanup()
			return m, tea.Quit
		case key.Matches(msg, tui.Keys.Back):
			if m.state == tunnelActive || m.state == tunnelConnecting {
				m.cleanup()
				m.state = tunnelInput
				m.requests = nil
				m.err = nil
				m.portInput.Focus()
				return m, m.portInput.Cursor.BlinkCmd()
			}
			return m, func() tea.Msg { return tui.BackMsg{} }
		case key.Matches(msg, tui.Keys.Enter):
			if m.state == tunnelInput {
				port := m.portInput.Value()
				if port == "" {
					port = "8080"
				}
				m.targetURL = fmt.Sprintf("http://localhost:%s", port)
				m.state = tunnelConnecting
				m.err = nil
				return m, tea.Batch(m.spinner.Tick, m.createAndConnect())
			}
			if m.state == tunnelActive && len(m.requests) > 0 && m.scrollPos < len(m.requests) {
				req := m.requests[m.scrollPos].req
				return m, func() tea.Msg {
					return tui.NavigateMsg{Screen: tui.ScreenDetail, Data: req}
				}
			}
		case key.Matches(msg, tui.Keys.Up):
			if m.state == tunnelActive && m.scrollPos > 0 {
				m.scrollPos--
			}
		case key.Matches(msg, tui.Keys.Down):
			if m.state == tunnelActive && m.scrollPos < len(m.requests)-1 {
				m.scrollPos++
			}
		default:
			if m.state == tunnelInput {
				var cmd tea.Cmd
				m.portInput, cmd = m.portInput.Update(msg)
				return m, cmd
			}
		}

	case tui.EndpointCreatedMsg:
		if msg.Err != nil {
			m.err = msg.Err
			m.state = tunnelInput
			m.portInput.Focus()
			return m, m.portInput.Cursor.BlinkCmd()
		}
		m.slug = msg.Endpoint.Slug
		m.webhookURL = msg.Endpoint.URL
		m.epCreated = true
		m.state = tunnelActive
		m.tun = tunnel.New(m.slug, m.targetURL)
		return m, tea.Batch(m.spinner.Tick, m.connectStream())

	case tui.RequestReceivedMsg:
		m.state = tunnelActive
		tr := tunnelRequest{req: msg.Request}
		m.requests = append(m.requests, tr)
		idx := len(m.requests) - 1
		m.scrollPos = idx

		var cmds []tea.Cmd
		if m.sseSession != nil {
			cmds = append(cmds, tui.WaitForSSE(m.sseSession))
		}
		cmds = append(cmds, m.forwardRequest(msg.Request, idx))
		return m, tea.Batch(cmds...)

	case tui.ForwardResultMsg:
		for i := range m.requests {
			if m.requests[i].req.ID == msg.RequestID {
				m.requests[i].result = msg.Result
				break
			}
		}

	case tui.SSEErrorMsg:
		m.err = msg.Err

	case tui.SSEDoneMsg:
		// Stream ended

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m *TunnelModel) cleanup() {
	if m.sseSession != nil {
		m.sseSession.Stop()
		m.sseSession = nil
	}
	// Delete ephemeral endpoint
	if m.epCreated && m.slug != "" {
		_ = m.client.DeleteEndpointWithContext(context.Background(), m.slug)
		m.epCreated = false
	}
}

func (m *TunnelModel) createAndConnect() tea.Cmd {
	return func() tea.Msg {
		name := fmt.Sprintf("tunnel-%s", tunnelRandomSuffix(6))
		ep, err := m.client.CreateEndpointWithContext(context.Background(), name, true)
		if err != nil {
			return tui.EndpointCreatedMsg{Err: err}
		}
		return tui.EndpointCreatedMsg{Endpoint: &tui.Endpoint{
			ID:   ep.ID,
			Slug: ep.Slug,
			Name: ep.Name,
			URL:  ep.URL,
		}}
	}
}

func tunnelRandomSuffix(n int) string {
	b := make([]byte, (n+1)/2)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

func (m *TunnelModel) connectStream() tea.Cmd {
	tok, err := auth.LoadToken()
	if err != nil {
		return func() tea.Msg {
			return tui.SSEErrorMsg{Err: fmt.Errorf("not logged in: %w", err)}
		}
	}

	s := stream.New(m.slug, m.client.BaseURL(), tok.AccessToken)
	session, cmd := tui.StartSSE(s)
	m.sseSession = session
	return cmd
}

func (m TunnelModel) forwardRequest(req *types.CapturedRequest, _ int) tea.Cmd {
	t := m.tun
	reqID := req.ID
	return func() tea.Msg {
		result, _ := t.Forward(req)
		return tui.ForwardResultMsg{RequestID: reqID, Result: result}
	}
}

func (m TunnelModel) View() string {
	header := components.Header("Tunnel", m.width)

	var body string

	switch m.state {
	case tunnelInput:
		body = fmt.Sprintf(
			"  Forward webhooks to localhost\n\n"+
				"  Port: %s\n\n"+
				"  %s",
			m.portInput.View(),
			tui.Muted.Render("enter to connect · esc back"),
		)

	case tunnelConnecting:
		body = fmt.Sprintf("  %s Creating endpoint and connecting...\n\n"+
			"  Target: %s",
			m.spinner.View(),
			tui.Bold.Render(m.targetURL),
		)

	case tunnelActive:
		webhookLine := fmt.Sprintf("  Webhook URL: %s", tui.Secondary.Render(m.webhookURL))
		targetLine := fmt.Sprintf("  Forwarding to: %s", tui.Bold.Render(m.targetURL))
		countLine := fmt.Sprintf("  %s  (%d requests)",
			tui.Success.Render("●"),
			len(m.requests),
		)
		body = fmt.Sprintf("%s\n%s\n%s\n\n", webhookLine, targetLine, countLine)

		if len(m.requests) == 0 {
			body += fmt.Sprintf("  %s Waiting for webhooks...", m.spinner.View())
		} else {
			maxVisible := m.height - 12
			if maxVisible < 3 {
				maxVisible = 3
			}

			start := 0
			if len(m.requests) > maxVisible {
				start = m.scrollPos - maxVisible/2
				if start < 0 {
					start = 0
				}
				if start+maxVisible > len(m.requests) {
					start = len(m.requests) - maxVisible
				}
			}
			end := start + maxVisible
			if end > len(m.requests) {
				end = len(m.requests)
			}

			for i := start; i < end; i++ {
				tr := m.requests[i]
				cursor := "  "
				if i == m.scrollPos {
					cursor = tui.Primary.Render("▸ ")
				}
				ts := time.UnixMilli(tr.req.ReceivedAt).Format("15:04:05")
				method := tui.MethodStyle(tr.req.Method).Render(fmt.Sprintf("%-7s", tr.req.Method))

				var status string
				if tr.result == nil {
					status = m.spinner.View()
				} else if tr.result.Success {
					status = tui.Success.Render(fmt.Sprintf("→ %d (%dms)",
						tr.result.StatusCode,
						tr.result.Duration.Milliseconds()))
				} else {
					status = tui.Danger.Render("→ " + tr.result.Error)
				}

				body += fmt.Sprintf("%s%s  %s  %s  %s\n",
					cursor,
					tui.Muted.Render(ts),
					method,
					tr.req.Path,
					status,
				)
			}
		}
	}

	if m.err != nil {
		body += fmt.Sprintf("\n  %s %s", tui.Danger.Render("Error:"), m.err)
	}

	content := lipgloss.JoinVertical(lipgloss.Left, header, "", body)

	var help string
	switch m.state {
	case tunnelInput:
		help = "enter connect · esc back · ctrl+c quit"
	case tunnelConnecting:
		help = "esc cancel · ctrl+c quit"
	case tunnelActive:
		help = "↑↓ scroll · enter inspect · esc stop · ctrl+c quit"
	}
	statusBar := components.StatusBar(help, m.width)

	contentHeight := lipgloss.Height(content)
	statusHeight := lipgloss.Height(statusBar)
	gap := m.height - contentHeight - statusHeight
	if gap < 0 {
		gap = 0
	}

	return content + fmt.Sprintf("%*s", gap, "\n") + statusBar
}
