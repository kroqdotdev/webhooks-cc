package screens

import (
	"context"

	"webhooks.cc/cli/internal/api"
	"webhooks.cc/cli/internal/tui"

	tea "github.com/charmbracelet/bubbletea"
)

func loadEndpointsCmd(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		eps, err := client.ListEndpointsWithContext(context.Background())
		if err != nil {
			return tui.EndpointsLoadedMsg{Err: err}
		}
		result := make([]tui.Endpoint, len(eps))
		for i, ep := range eps {
			teamName := ""
			isShared := false
			if ep.FromTeam != nil {
				teamName = ep.FromTeam.TeamName
				isShared = true
			} else if len(ep.SharedWith) > 0 {
				teamName = ep.SharedWith[0].TeamName
			}
			result[i] = tui.Endpoint{
				ID:       ep.ID,
				Slug:     ep.Slug,
				Name:     ep.Name,
				URL:      ep.URL,
				TeamName: teamName,
				IsShared: isShared,
			}
		}
		return tui.EndpointsLoadedMsg{Endpoints: result}
	}
}
