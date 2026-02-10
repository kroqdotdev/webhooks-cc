package screens

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"webhooks.cc/cli/internal/tui"
	"webhooks.cc/cli/internal/tui/components"
	"webhooks.cc/shared/types"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type detailTab int

const (
	tabOverview detailTab = iota
	tabHeaders
	tabBody
)

type DetailModel struct {
	request  *types.CapturedRequest
	width    int
	height   int
	tab      detailTab
	viewport viewport.Model
	ready    bool
}

func NewDetail(req *types.CapturedRequest) DetailModel {
	return DetailModel{
		request: req,
		tab:     tabOverview,
	}
}

func (m DetailModel) Init() tea.Cmd {
	return nil
}

func (m DetailModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		headerHeight := 4 // header + tabs + blank line
		footerHeight := 2
		vpHeight := m.height - headerHeight - footerHeight
		if vpHeight < 1 {
			vpHeight = 1
		}
		if !m.ready {
			m.viewport = viewport.New(m.width, vpHeight)
			m.viewport.SetContent(m.tabContent())
			m.ready = true
		} else {
			m.viewport.Width = m.width
			m.viewport.Height = vpHeight
		}

	case tea.KeyMsg:
		switch {
		case key.Matches(msg, tui.Keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, tui.Keys.Back):
			return m, func() tea.Msg { return tui.BackMsg{} }
		case key.Matches(msg, tui.Keys.Tab):
			m.tab = (m.tab + 1) % 3
			m.viewport.SetContent(m.tabContent())
			m.viewport.GotoTop()
			return m, nil
		case msg.String() == "1":
			m.tab = tabOverview
			m.viewport.SetContent(m.tabContent())
			m.viewport.GotoTop()
			return m, nil
		case msg.String() == "2":
			m.tab = tabHeaders
			m.viewport.SetContent(m.tabContent())
			m.viewport.GotoTop()
			return m, nil
		case msg.String() == "3":
			m.tab = tabBody
			m.viewport.SetContent(m.tabContent())
			m.viewport.GotoTop()
			return m, nil
		}
	}

	if m.ready {
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m DetailModel) tabContent() string {
	switch m.tab {
	case tabOverview:
		return m.overviewContent()
	case tabHeaders:
		return m.headersContent()
	case tabBody:
		return m.bodyContent()
	default:
		return ""
	}
}

func (m DetailModel) overviewContent() string {
	req := m.request
	ts := time.UnixMilli(req.ReceivedAt).Format("2006-01-02 15:04:05")
	method := tui.MethodStyle(req.Method).Render(req.Method)

	lines := []string{
		fmt.Sprintf("  Method:       %s", method),
		fmt.Sprintf("  Path:         %s", req.Path),
		fmt.Sprintf("  IP:           %s", req.IP),
		fmt.Sprintf("  Size:         %d bytes", req.Size),
		fmt.Sprintf("  Received:     %s", ts),
		fmt.Sprintf("  Content-Type: %s", req.ContentType),
	}

	if len(req.QueryParams) > 0 {
		lines = append(lines, "", "  Query Parameters:")
		keys := sortedKeys(req.QueryParams)
		for _, k := range keys {
			lines = append(lines, fmt.Sprintf("    %s = %s",
				tui.Bold.Render(k), req.QueryParams[k]))
		}
	}

	return strings.Join(lines, "\n")
}

func (m DetailModel) headersContent() string {
	if len(m.request.Headers) == 0 {
		return "  No headers"
	}

	keys := sortedKeys(m.request.Headers)
	var lines []string
	for _, k := range keys {
		lines = append(lines, fmt.Sprintf("  %s: %s",
			tui.Bold.Render(k), m.request.Headers[k]))
	}
	return strings.Join(lines, "\n")
}

func (m DetailModel) bodyContent() string {
	body := m.request.Body
	if body == "" {
		return "  (empty body)"
	}

	// Try to pretty-print JSON
	var parsed any
	if err := json.Unmarshal([]byte(body), &parsed); err == nil {
		pretty, err := json.MarshalIndent(parsed, "  ", "  ")
		if err == nil {
			return "  " + string(pretty)
		}
	}

	// Show raw body with indentation
	var lines []string
	for _, line := range strings.Split(body, "\n") {
		lines = append(lines, "  "+line)
	}
	return strings.Join(lines, "\n")
}

func (m DetailModel) View() string {
	header := components.Header("Request Detail", m.width)

	// Tab bar
	tabs := []string{"Overview", "Headers", "Body"}
	var tabBar string
	for i, t := range tabs {
		label := fmt.Sprintf(" %d:%s ", i+1, t)
		if detailTab(i) == m.tab {
			tabBar += lipgloss.NewStyle().
				Bold(true).
				Foreground(tui.ColorPrimary).
				Underline(true).
				Render(label)
		} else {
			tabBar += tui.Muted.Render(label)
		}
		if i < len(tabs)-1 {
			tabBar += tui.Muted.Render("│")
		}
	}
	tabBar = "  " + tabBar

	var vpView string
	if m.ready {
		vpView = m.viewport.View()
	}

	content := lipgloss.JoinVertical(lipgloss.Left, header, tabBar, "", vpView)

	help := "tab/1-2-3 switch · ↑↓ scroll · esc back · ctrl+c quit"
	statusBar := components.StatusBar(help, m.width)

	contentHeight := lipgloss.Height(content)
	statusHeight := lipgloss.Height(statusBar)
	gap := m.height - contentHeight - statusHeight
	if gap < 0 {
		gap = 0
	}

	return content + fmt.Sprintf("%*s", gap, "\n") + statusBar
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
