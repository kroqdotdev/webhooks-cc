package screens

import (
	"context"
	"fmt"

	"webhooks.cc/cli/internal/api"
	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type endpointsState int

const (
	epList endpointsState = iota
	epCreating
)

type EndpointsModel struct {
	client    *api.Client
	width     int
	height    int
	endpoints []tui.Endpoint
	cursor    int
	loading   bool
	spinner   spinner.Model
	err       error
	message   string
	state     endpointsState
	nameInput textinput.Model
}

func NewEndpoints(client *api.Client, mode string) EndpointsModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(tui.ColorPrimary)

	ti := textinput.New()
	ti.Placeholder = "endpoint name (optional)"
	ti.CharLimit = 64

	state := epList
	if mode == "create" {
		state = epCreating
		ti.Focus()
	}

	return EndpointsModel{
		client:    client,
		loading:   state == epList,
		spinner:   s,
		state:     state,
		nameInput: ti,
	}
}

func (m EndpointsModel) Init() tea.Cmd {
	if m.state == epCreating {
		return m.nameInput.Cursor.BlinkCmd()
	}
	return tea.Batch(m.spinner.Tick, m.loadEndpoints())
}

func (m EndpointsModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		if m.state == epCreating {
			return m.updateCreating(msg)
		}
		switch {
		case key.Matches(msg, tui.Keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, tui.Keys.Back):
			return m, func() tea.Msg { return tui.BackMsg{} }
		case key.Matches(msg, tui.Keys.Up):
			if m.cursor > 0 {
				m.cursor--
			}
		case key.Matches(msg, tui.Keys.Down):
			if m.cursor < len(m.endpoints)-1 {
				m.cursor++
			}
		case key.Matches(msg, tui.Keys.New):
			m.state = epCreating
			m.nameInput.Reset()
			m.nameInput.Focus()
			return m, m.nameInput.Cursor.BlinkCmd()
		case key.Matches(msg, tui.Keys.Delete):
			if len(m.endpoints) > 0 {
				m.loading = true
				return m, tea.Batch(m.spinner.Tick, m.deleteEndpoint(m.endpoints[m.cursor].Slug))
			}
		case key.Matches(msg, tui.Keys.Enter):
			if len(m.endpoints) > 0 {
				ep := m.endpoints[m.cursor]
				return m, func() tea.Msg {
					return tui.NavigateMsg{Screen: tui.ScreenListen, Data: ep.Slug}
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
		if m.cursor >= len(m.endpoints) {
			m.cursor = max(0, len(m.endpoints)-1)
		}

	case tui.EndpointCreatedMsg:
		m.loading = false
		m.state = epList
		if msg.Err != nil {
			m.err = msg.Err
			return m, nil
		}
		m.message = fmt.Sprintf("Created endpoint: %s", msg.Endpoint.Slug)
		return m, m.loadEndpoints()

	case tui.EndpointDeletedMsg:
		m.loading = false
		if msg.Err != nil {
			m.err = msg.Err
			return m, nil
		}
		m.message = fmt.Sprintf("Deleted endpoint: %s", msg.Slug)
		return m, m.loadEndpoints()

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m EndpointsModel) updateCreating(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, tui.Keys.Back):
		m.state = epList
		return m, nil
	case key.Matches(msg, tui.Keys.Enter):
		name := m.nameInput.Value()
		m.loading = true
		m.state = epList
		return m, tea.Batch(m.spinner.Tick, m.createEndpoint(name))
	default:
		var cmd tea.Cmd
		m.nameInput, cmd = m.nameInput.Update(msg)
		return m, cmd
	}
}

func (m EndpointsModel) loadEndpoints() tea.Cmd {
	return loadEndpointsCmd(m.client)
}

func (m EndpointsModel) createEndpoint(name string) tea.Cmd {
	return func() tea.Msg {
		ep, err := m.client.CreateEndpointWithContext(context.Background(), name, false)
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

func (m EndpointsModel) deleteEndpoint(slug string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		err := client.DeleteEndpointWithContext(context.Background(), slug)
		return tui.EndpointDeletedMsg{Slug: slug, Err: err}
	}
}

func (m EndpointsModel) View() string {
	header := components.Header("Endpoints", m.width)

	var body string

	if m.state == epCreating {
		body = fmt.Sprintf("  Create new endpoint:\n\n  %s\n\n  %s",
			m.nameInput.View(),
			tui.Muted.Render("enter to create · esc to cancel"),
		)
	} else if m.loading {
		body = fmt.Sprintf("  %s Loading...", m.spinner.View())
	} else if len(m.endpoints) == 0 {
		body = fmt.Sprintf("  No endpoints found.\n\n  Press %s to create one.", tui.Bold.Render("n"))
	} else {
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
			body += fmt.Sprintf("%s%s  %s\n",
				cursor,
				style.Render(name),
				tui.Muted.Render(ep.URL),
			)
		}
	}

	if m.err != nil {
		body += fmt.Sprintf("\n  %s %s", tui.Danger.Render("Error:"), m.err)
	}
	if m.message != "" {
		body += fmt.Sprintf("\n  %s", tui.Success.Render(m.message))
	}

	content := lipgloss.JoinVertical(lipgloss.Left, header, "", body)

	help := "n new · d delete · enter listen · esc back · ctrl+c quit"
	statusBar := components.StatusBar(help, m.width)

	contentHeight := lipgloss.Height(content)
	statusHeight := lipgloss.Height(statusBar)
	gap := m.height - contentHeight - statusHeight
	if gap < 0 {
		gap = 0
	}

	return content + fmt.Sprintf("%*s", gap, "\n") + statusBar
}
