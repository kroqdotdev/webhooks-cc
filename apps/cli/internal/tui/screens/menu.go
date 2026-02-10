package screens

import (
	"fmt"

	"webhooks.cc/cli/internal/auth"
	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type menuItem struct {
	title  string
	desc   string
	screen tui.Screen
	data   any
}

type MenuModel struct {
	items    []menuItem
	cursor   int
	width    int
	height   int
	version  string
	loggedIn bool
	email    string
}

func NewMenu(version string) MenuModel {
	loggedIn := auth.IsLoggedIn()
	var email string
	if loggedIn {
		if tok, err := auth.LoadToken(); err == nil {
			email = tok.Email
		}
	}

	return MenuModel{
		items: []menuItem{
			{title: "Tunnel", desc: "Forward webhooks to localhost", screen: tui.ScreenTunnel},
			{title: "Listen", desc: "Stream incoming requests", screen: tui.ScreenListen},
			{title: "Create", desc: "Create a new endpoint", screen: tui.ScreenEndpoints, data: "create"},
			{title: "Endpoints", desc: "Manage your endpoints", screen: tui.ScreenEndpoints},
			{title: "Auth", desc: "Login / logout", screen: tui.ScreenAuth},
			{title: "Update", desc: "Check for updates", screen: tui.ScreenUpdate},
		},
		version:  version,
		loggedIn: loggedIn,
		email:    email,
	}
}

func (m MenuModel) Init() tea.Cmd {
	return nil
}

func (m MenuModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		switch {
		case key.Matches(msg, tui.Keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, tui.Keys.Up):
			if m.cursor > 0 {
				m.cursor--
			}
		case key.Matches(msg, tui.Keys.Down):
			if m.cursor < len(m.items)-1 {
				m.cursor++
			}
		case key.Matches(msg, tui.Keys.Enter):
			item := m.items[m.cursor]
			return m, func() tea.Msg {
				return tui.NavigateMsg{Screen: item.screen, Data: item.data}
			}
		case msg.String() == "q":
			return m, tea.Quit
		}
	}

	return m, nil
}

func (m MenuModel) View() string {
	header := components.Header("", m.width)

	// Auth status
	var authLine string
	if m.loggedIn {
		authLine = fmt.Sprintf("  %s Logged in as %s",
			tui.Success.Render("●"),
			tui.Bold.Render(m.email))
	} else {
		authLine = fmt.Sprintf("  %s Not logged in",
			tui.Danger.Render("●"))
	}

	// Menu items
	var items string
	for i, item := range m.items {
		cursor := "  "
		style := tui.MenuItemNormal
		if i == m.cursor {
			cursor = tui.Primary.Render("▸ ")
			style = tui.MenuItemSelected
		}
		title := style.Render(item.title)
		desc := tui.Muted.Render(" " + item.desc)
		items += fmt.Sprintf("%s%s%s\n", cursor, title, desc)
	}

	version := tui.Muted.Render(fmt.Sprintf("  v%s", m.version))

	content := lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		authLine,
		"",
		items,
		version,
	)

	help := "↑↓ navigate · enter select · q quit"
	statusBar := components.StatusBar(help, m.width)

	// Fill remaining space
	contentHeight := lipgloss.Height(content)
	statusHeight := lipgloss.Height(statusBar)
	gap := m.height - contentHeight - statusHeight
	if gap < 0 {
		gap = 0
	}

	return content + fmt.Sprintf("%*s", gap, "\n") + statusBar
}
