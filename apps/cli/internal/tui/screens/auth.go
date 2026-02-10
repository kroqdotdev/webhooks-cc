package screens

import (
	"context"
	"fmt"
	"time"

	"webhooks.cc/cli/internal/api"
	"webhooks.cc/cli/internal/auth"
	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type authState int

const (
	authIdle authState = iota
	authPolling
	authSuccess
)

type AuthModel struct {
	client   *api.Client
	width    int
	height   int
	loggedIn bool
	email    string
	state    authState
	spinner  spinner.Model
	userCode string
	verURL   string
	devCode  string
	err      error
	message  string
}

func NewAuth(client *api.Client) AuthModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(tui.ColorPrimary)

	loggedIn := auth.IsLoggedIn()
	var email string
	if loggedIn {
		if tok, err := auth.LoadToken(); err == nil {
			email = tok.Email
		}
	}

	return AuthModel{
		client:   client,
		loggedIn: loggedIn,
		email:    email,
		state:    authIdle,
		spinner:  s,
	}
}

func (m AuthModel) Init() tea.Cmd {
	return nil
}

func (m AuthModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		switch {
		case key.Matches(msg, tui.Keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, tui.Keys.Back):
			return m, func() tea.Msg { return tui.BackMsg{} }
		case msg.String() == "l" && !m.loggedIn && m.state == authIdle:
			m.state = authPolling
			m.err = nil
			return m, tea.Batch(m.spinner.Tick, m.startLogin())
		case msg.String() == "o" && m.loggedIn:
			return m, m.doLogout()
		}

	case tui.DeviceCodeMsg:
		if msg.Err != nil {
			m.err = msg.Err
			m.state = authIdle
			return m, nil
		}
		m.userCode = msg.UserCode
		m.verURL = msg.VerificationURL
		m.devCode = msg.DeviceCode
		return m, m.pollAuth()

	case tui.AuthPollMsg:
		if msg.Err != nil {
			m.err = msg.Err
			m.state = authIdle
			return m, nil
		}
		switch msg.Status {
		case "authorized":
			return m, m.claimAuth()
		case "expired":
			m.err = fmt.Errorf("device code expired, try again")
			m.state = authIdle
			return m, nil
		default: // pending
			return m, tea.Tick(5*time.Second, func(time.Time) tea.Msg {
				return tickPollMsg{}
			})
		}

	case tickPollMsg:
		if m.state == authPolling {
			return m, m.pollAuth()
		}

	case tui.AuthClaimedMsg:
		if msg.Err != nil {
			m.err = msg.Err
			m.state = authIdle
			return m, nil
		}
		m.loggedIn = true
		m.email = msg.Email
		m.state = authSuccess
		m.message = "Logged in successfully!"
		return m, nil

	case tui.AuthLogoutMsg:
		if msg.Err != nil {
			m.err = msg.Err
			return m, nil
		}
		m.loggedIn = false
		m.email = ""
		m.message = "Logged out."
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

type tickPollMsg struct{}

func (m AuthModel) startLogin() tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.CreateDeviceCode(context.Background())
		if err != nil {
			return tui.DeviceCodeMsg{Err: err}
		}
		return tui.DeviceCodeMsg{
			UserCode:        resp.UserCode,
			VerificationURL: resp.VerificationURL,
			DeviceCode:      resp.DeviceCode,
		}
	}
}

func (m AuthModel) pollAuth() tea.Cmd {
	devCode := m.devCode
	return func() tea.Msg {
		resp, err := m.client.PollDeviceCode(context.Background(), devCode)
		if err != nil {
			return tui.AuthPollMsg{Err: err}
		}
		return tui.AuthPollMsg{Status: resp.Status}
	}
}

func (m AuthModel) claimAuth() tea.Cmd {
	devCode := m.devCode
	return func() tea.Msg {
		resp, err := m.client.ClaimDeviceCode(context.Background(), devCode)
		if err != nil {
			return tui.AuthClaimedMsg{Err: err}
		}
		token := &auth.Token{
			AccessToken: resp.APIKey,
			UserID:      resp.UserID,
			Email:       resp.Email,
		}
		if err := auth.SaveToken(token); err != nil {
			return tui.AuthClaimedMsg{Err: err}
		}
		return tui.AuthClaimedMsg{Email: resp.Email}
	}
}

func (m AuthModel) doLogout() tea.Cmd {
	return func() tea.Msg {
		err := auth.ClearToken()
		return tui.AuthLogoutMsg{Err: err}
	}
}

func (m AuthModel) View() string {
	header := components.Header("Auth", m.width)

	var body string
	if m.loggedIn {
		body = fmt.Sprintf(
			"  %s Logged in as %s\n\n  Press %s to logout",
			tui.Success.Render("●"),
			tui.Bold.Render(m.email),
			tui.Bold.Render("o"),
		)
	} else {
		switch m.state {
		case authIdle:
			body = fmt.Sprintf(
				"  %s Not logged in\n\n  Press %s to start login",
				tui.Danger.Render("●"),
				tui.Bold.Render("l"),
			)
		case authPolling:
			if m.userCode != "" {
				body = fmt.Sprintf(
					"  %s Waiting for authorization...\n\n"+
						"  Open: %s\n"+
						"  Code: %s\n\n"+
						"  %s",
					m.spinner.View(),
					tui.Secondary.Render(m.verURL),
					tui.Bold.Render(m.userCode),
					tui.Muted.Render("Polling every 5s..."),
				)
			} else {
				body = fmt.Sprintf("  %s Creating device code...", m.spinner.View())
			}
		case authSuccess:
			body = fmt.Sprintf(
				"  %s %s",
				tui.Success.Render("✓"),
				m.message,
			)
		}
	}

	if m.err != nil {
		body += fmt.Sprintf("\n\n  %s %s", tui.Danger.Render("Error:"), m.err)
	}
	if m.message != "" && m.state != authSuccess {
		body += fmt.Sprintf("\n\n  %s", tui.Success.Render(m.message))
	}

	content := lipgloss.JoinVertical(lipgloss.Left, header, "", body)

	help := "esc back · ctrl+c quit"
	if !m.loggedIn && m.state == authIdle {
		help = "l login · esc back · ctrl+c quit"
	} else if m.loggedIn {
		help = "o logout · esc back · ctrl+c quit"
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
