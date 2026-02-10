package tui

import "github.com/charmbracelet/lipgloss"

var (
	// Brand colors (neobrutalism-inspired)
	ColorPrimary   = lipgloss.Color("#FF6B35")
	ColorSecondary = lipgloss.Color("#004E89")
	ColorAccent    = lipgloss.Color("#FCBF49")
	ColorSuccess   = lipgloss.Color("#2EC4B6")
	ColorDanger    = lipgloss.Color("#E71D36")
	ColorMuted     = lipgloss.Color("#6B7280")
	ColorBorder    = lipgloss.Color("#374151")

	// Text styles
	Bold      = lipgloss.NewStyle().Bold(true)
	Muted     = lipgloss.NewStyle().Foreground(ColorMuted)
	Success   = lipgloss.NewStyle().Foreground(ColorSuccess)
	Danger    = lipgloss.NewStyle().Foreground(ColorDanger)
	Accent    = lipgloss.NewStyle().Foreground(ColorAccent)
	Primary   = lipgloss.NewStyle().Foreground(ColorPrimary)
	Secondary = lipgloss.NewStyle().Foreground(ColorSecondary)

	// Menu styles
	MenuItemNormal   = lipgloss.NewStyle().PaddingLeft(2)
	MenuItemSelected = lipgloss.NewStyle().
				PaddingLeft(1).
				Foreground(ColorPrimary).
				Bold(true)

	// Box/container
	BoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(ColorBorder).
			Padding(0, 1)

	// Status indicators
	StatusOnline  = Success.Render("●")
	StatusOffline = Danger.Render("●")

	// Method colors (matches stream.FormatRequest)
	MethodColors = map[string]lipgloss.Style{
		"GET":    lipgloss.NewStyle().Foreground(lipgloss.Color("#10B981")),
		"POST":   lipgloss.NewStyle().Foreground(lipgloss.Color("#3B82F6")),
		"PUT":    lipgloss.NewStyle().Foreground(lipgloss.Color("#F59E0B")),
		"DELETE": lipgloss.NewStyle().Foreground(lipgloss.Color("#EF4444")),
		"PATCH":  lipgloss.NewStyle().Foreground(lipgloss.Color("#A855F7")),
	}
)

func MethodStyle(method string) lipgloss.Style {
	if s, ok := MethodColors[method]; ok {
		return s
	}
	return lipgloss.NewStyle()
}
