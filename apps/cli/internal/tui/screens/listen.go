package screens

import (
	"fmt"
	"time"

	"webhooks.cc/cli/internal/api"
	"webhooks.cc/cli/internal/auth"
	"webhooks.cc/cli/internal/stream"
	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"
	"webhooks.cc/shared/types"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type listenState int

const (
	listenPicker listenState = iota
	listenStreaming
)

type ListenModel struct {
	client     *api.Client
	width      int
	height     int
	state      listenState
	endpoints  []tui.Endpoint
	cursor     int
	requests   []*types.CapturedRequest
	scrollPos  int
	loading    bool
	spinner    spinner.Model
	err        error
	slug       string
	sseSession *tui.SSESession
}

func NewListen(client *api.Client, slug string) ListenModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(tui.ColorPrimary)

	m := ListenModel{
		client:  client,
		loading: slug == "",
		spinner: s,
		slug:    slug,
	}

	if slug != "" {
		m.state = listenStreaming
	}

	return m
}

func (m ListenModel) Init() tea.Cmd {
	cmds := []tea.Cmd{m.spinner.Tick}
	if m.slug != "" {
		cmds = append(cmds, m.startStream())
	} else {
		cmds = append(cmds, m.loadEndpoints())
	}
	return tea.Batch(cmds...)
}

func (m ListenModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
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
			m.cleanup()
			if m.state == listenStreaming && m.slug != "" {
				m.state = listenPicker
				m.slug = ""
				m.requests = nil
				m.loading = true
				return m, m.loadEndpoints()
			}
			return m, func() tea.Msg { return tui.BackMsg{} }
		case key.Matches(msg, tui.Keys.Up):
			if m.state == listenPicker && m.cursor > 0 {
				m.cursor--
			} else if m.state == listenStreaming && m.scrollPos > 0 {
				m.scrollPos--
			}
		case key.Matches(msg, tui.Keys.Down):
			if m.state == listenPicker && m.cursor < len(m.endpoints)-1 {
				m.cursor++
			} else if m.state == listenStreaming && m.scrollPos < len(m.requests)-1 {
				m.scrollPos++
			}
		case key.Matches(msg, tui.Keys.Enter):
			if m.state == listenPicker && len(m.endpoints) > 0 {
				m.slug = m.endpoints[m.cursor].Slug
				m.state = listenStreaming
				m.loading = true
				return m, tea.Batch(m.spinner.Tick, m.startStream())
			}
			if m.state == listenStreaming && len(m.requests) > 0 && m.scrollPos < len(m.requests) {
				req := m.requests[m.scrollPos]
				return m, func() tea.Msg {
					return tui.NavigateMsg{Screen: tui.ScreenDetail, Data: req}
				}
			}
		}

	case tui.EndpointsLoadedMsg:
		m.loading = false
		if msg.Err != nil {
			m.err = msg.Err
			return m, nil
		}
		m.endpoints = msg.Endpoints

	case tui.RequestReceivedMsg:
		m.loading = false
		m.requests = append(m.requests, msg.Request)
		// Auto-scroll to bottom
		m.scrollPos = len(m.requests) - 1
		if m.sseSession != nil {
			return m, tui.WaitForSSE(m.sseSession)
		}

	case tui.SSEErrorMsg:
		m.err = msg.Err

	case tui.SSEDoneMsg:
		m.loading = false

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m *ListenModel) cleanup() {
	if m.sseSession != nil {
		m.sseSession.Stop()
		m.sseSession = nil
	}
}

func (m ListenModel) loadEndpoints() tea.Cmd {
	return loadEndpointsCmd(m.client)
}

func (m *ListenModel) startStream() tea.Cmd {
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

func (m ListenModel) View() string {
	header := components.Header("Listen", m.width)

	var body string

	if m.state == listenPicker {
		if m.loading {
			body = fmt.Sprintf("  %s Loading endpoints...", m.spinner.View())
		} else if len(m.endpoints) == 0 {
			body = "  No endpoints found. Create one first."
		} else {
			body = "  Select an endpoint to listen:\n\n"
			for i, ep := range m.endpoints {
				cursor := "  "
				style := tui.MenuItemNormal
				if i == m.cursor {
					cursor = tui.Primary.Render("▸ ")
					style = tui.MenuItemSelected
				}
				name := ep.Slug
				if ep.Name != "" {
					name = ep.Name + " (" + ep.Slug + ")"
				}
				body += fmt.Sprintf("%s%s\n", cursor, style.Render(name))
			}
		}
	} else {
		// Streaming view
		urlLine := fmt.Sprintf("  Listening on %s", tui.Secondary.Render(m.slug))
		if m.loading && len(m.requests) == 0 {
			body = fmt.Sprintf("%s\n\n  %s Waiting for requests...", urlLine, m.spinner.View())
		} else if len(m.requests) == 0 {
			body = fmt.Sprintf("%s\n\n  No requests yet.", urlLine)
		} else {
			body = fmt.Sprintf("%s  (%d requests)\n\n", urlLine, len(m.requests))

			// Calculate visible window
			maxVisible := m.height - 8
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
				req := m.requests[i]
				cursor := "  "
				if i == m.scrollPos {
					cursor = tui.Primary.Render("▸ ")
				}
				ts := time.UnixMilli(req.ReceivedAt).Format("15:04:05")
				method := tui.MethodStyle(req.Method).Render(fmt.Sprintf("%-7s", req.Method))
				body += fmt.Sprintf("%s%s  %s  %s  %s\n",
					cursor,
					tui.Muted.Render(ts),
					method,
					req.Path,
					tui.Muted.Render(stream.FormatBytes(req.Size)),
				)
			}
		}
	}

	if m.err != nil {
		body += fmt.Sprintf("\n  %s %s", tui.Danger.Render("Error:"), m.err)
	}

	content := lipgloss.JoinVertical(lipgloss.Left, header, "", body)

	var help string
	if m.state == listenPicker {
		help = "↑↓ navigate · enter select · esc back · ctrl+c quit"
	} else {
		help = "↑↓ scroll · enter inspect · esc back · ctrl+c quit"
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

