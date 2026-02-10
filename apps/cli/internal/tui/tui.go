package tui

import (
	"fmt"

	"webhooks.cc/cli/internal/api"
	"webhooks.cc/shared/types"

	tea "github.com/charmbracelet/bubbletea"
)

type App struct {
	client  *api.Client
	version string
	screen  Screen
	active  tea.Model
	width   int
	height  int

	// Factory functions set by the Run caller
	menuFactory      func(version string) tea.Model
	authFactory      func(client *api.Client) tea.Model
	endpointsFactory func(client *api.Client, mode string) tea.Model
	updateFactory    func(version string) tea.Model
	listenFactory    func(client *api.Client, slug string) tea.Model
	tunnelFactory    func(client *api.Client) tea.Model
	detailFactory    func(req *types.CapturedRequest) tea.Model
}

func (a App) Init() tea.Cmd {
	return a.active.Init()
}

func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height
		// Forward to active screen
		var cmd tea.Cmd
		a.active, cmd = a.active.Update(msg)
		return a, cmd

	case NavigateMsg:
		return a.navigate(msg)

	case BackMsg:
		return a.navigateToMenu()
	}

	var cmd tea.Cmd
	a.active, cmd = a.active.Update(msg)
	return a, cmd
}

func (a App) View() string {
	return a.active.View()
}

func (a App) navigate(msg NavigateMsg) (tea.Model, tea.Cmd) {
	a.screen = msg.Screen

	switch msg.Screen {
	case ScreenMenu:
		a.active = a.menuFactory(a.version)
	case ScreenAuth:
		a.active = a.authFactory(a.client)
	case ScreenEndpoints:
		mode := ""
		if s, ok := msg.Data.(string); ok {
			mode = s
		}
		a.active = a.endpointsFactory(a.client, mode)
	case ScreenUpdate:
		a.active = a.updateFactory(a.version)
	case ScreenListen:
		slug := ""
		if s, ok := msg.Data.(string); ok {
			slug = s
		}
		a.active = a.listenFactory(a.client, slug)
	case ScreenTunnel:
		a.active = a.tunnelFactory(a.client)
	case ScreenDetail:
		if req, ok := msg.Data.(*types.CapturedRequest); ok {
			a.active = a.detailFactory(req)
		}
	}

	// Send initial window size + init
	var cmds []tea.Cmd
	cmds = append(cmds, a.active.Init())
	if a.width > 0 && a.height > 0 {
		cmds = append(cmds, func() tea.Msg {
			return tea.WindowSizeMsg{Width: a.width, Height: a.height}
		})
	}

	return a, tea.Batch(cmds...)
}

func (a App) navigateToMenu() (tea.Model, tea.Cmd) {
	return a.navigate(NavigateMsg{Screen: ScreenMenu})
}

// Run starts the TUI. screenFactories are injected by the caller so
// the tui package doesn't import screens (avoiding circular imports).
func Run(client *api.Client, version string, factories ScreenFactories) error {
	menu := factories.Menu(version)
	app := App{
		client:           client,
		version:          version,
		screen:           ScreenMenu,
		active:           menu,
		menuFactory:      factories.Menu,
		authFactory:      factories.Auth,
		endpointsFactory: factories.Endpoints,
		updateFactory:    factories.Update,
		listenFactory:    factories.Listen,
		tunnelFactory:    factories.Tunnel,
		detailFactory:    factories.Detail,
	}

	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}
	return nil
}

// ScreenFactories holds factory functions for creating screen models.
// This avoids circular imports between tui and screens packages.
type ScreenFactories struct {
	Menu      func(version string) tea.Model
	Auth      func(client *api.Client) tea.Model
	Endpoints func(client *api.Client, mode string) tea.Model
	Update    func(version string) tea.Model
	Listen    func(client *api.Client, slug string) tea.Model
	Tunnel    func(client *api.Client) tea.Model
	Detail    func(req *types.CapturedRequest) tea.Model
}
