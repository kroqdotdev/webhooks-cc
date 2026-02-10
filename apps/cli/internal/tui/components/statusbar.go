package components

import (
	"github.com/charmbracelet/lipgloss"
)

var (
	barStyle = lipgloss.NewStyle().
			BorderTop(true).
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("#374151")).
			Foreground(lipgloss.Color("#6B7280"))
)

func StatusBar(help string, width int) string {
	return barStyle.Width(width).Render(help)
}
