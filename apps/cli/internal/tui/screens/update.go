package screens

import (
	"context"
	"fmt"

	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"
	"webhooks.cc/cli/internal/update"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type updateState int

const (
	updChecking updateState = iota
	updAvailable
	updCurrent
	updApplying
	updDone
)

type UpdateModel struct {
	version  string
	width    int
	height   int
	state    updateState
	spinner  spinner.Model
	release  *update.Release
	newVer   string
	err      error
}

func NewUpdate(version string) UpdateModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(tui.ColorPrimary)

	return UpdateModel{
		version: version,
		state:   updChecking,
		spinner: s,
	}
}

func (m UpdateModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.checkUpdate())
}

func (m UpdateModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
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
		case msg.String() == "u" && m.state == updAvailable:
			m.state = updApplying
			return m, tea.Batch(m.spinner.Tick, m.applyUpdate())
		}

	case tui.UpdateCheckMsg:
		if msg.Err != nil {
			m.err = msg.Err
			m.state = updCurrent
			return m, nil
		}
		if msg.Available {
			m.state = updAvailable
			if rel, ok := msg.Release.(*update.Release); ok {
				m.release = rel
			}
			m.newVer = msg.Version
		} else {
			m.state = updCurrent
		}

	case tui.UpdateApplyMsg:
		if msg.Err != nil {
			m.err = msg.Err
			m.state = updAvailable
			return m, nil
		}
		m.state = updDone

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m UpdateModel) checkUpdate() tea.Cmd {
	version := m.version
	return func() tea.Msg {
		rel, available, err := update.Check(context.Background(), version)
		if err != nil {
			return tui.UpdateCheckMsg{Err: err}
		}
		var v string
		if rel != nil {
			v = rel.TagName
		}
		return tui.UpdateCheckMsg{Available: available, Version: v, Release: rel}
	}
}

func (m UpdateModel) applyUpdate() tea.Cmd {
	rel := m.release
	return func() tea.Msg {
		err := update.Apply(context.Background(), rel)
		return tui.UpdateApplyMsg{Err: err}
	}
}

func (m UpdateModel) View() string {
	header := components.Header("Update", m.width)

	var body string
	switch m.state {
	case updChecking:
		body = fmt.Sprintf("  %s Checking for updates...", m.spinner.View())
	case updCurrent:
		body = fmt.Sprintf("  %s You're on the latest version (%s)",
			tui.Success.Render("✓"), m.version)
	case updAvailable:
		body = fmt.Sprintf("  Update available: %s → %s\n\n  Press %s to update",
			tui.Muted.Render(m.version),
			tui.Success.Render(m.newVer),
			tui.Bold.Render("u"),
		)
	case updApplying:
		body = fmt.Sprintf("  %s Downloading and applying update...", m.spinner.View())
	case updDone:
		body = fmt.Sprintf("  %s Updated to %s! Restart whk to use the new version.",
			tui.Success.Render("✓"), m.newVer)
	}

	if m.err != nil {
		body += fmt.Sprintf("\n\n  %s %s", tui.Danger.Render("Error:"), m.err)
	}

	content := lipgloss.JoinVertical(lipgloss.Left, header, "", body)

	help := "esc back · ctrl+c quit"
	if m.state == updAvailable {
		help = "u update · esc back · ctrl+c quit"
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
