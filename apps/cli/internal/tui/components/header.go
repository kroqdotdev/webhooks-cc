package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

var (
	brandStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FF6B35"))

	titleSep = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6B7280")).
			Render(" / ")

	titleStyle = lipgloss.NewStyle().
			Bold(true)
)

func Header(screenTitle string, width int) string {
	brand := brandStyle.Render("whk")
	var title string
	if screenTitle != "" {
		title = fmt.Sprintf("%s%s%s", brand, titleSep, titleStyle.Render(screenTitle))
	} else {
		title = brand
	}

	line := lipgloss.NewStyle().
		Width(width).
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("#374151")).
		Render(title)

	return line
}
