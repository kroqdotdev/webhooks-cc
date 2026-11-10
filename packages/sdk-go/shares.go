package webhookscc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SharesService reads and stops previews of local ports (`whk share`) and
// live tunnels (`whk tunnel --live`), and starts previews by running the
// whk CLI. Previews are served at <name>.sharehooks.cc; Free previews get a
// random name ending in -free and a time limit. Use it as client.Shares.
type SharesService struct{ c *Client }

// ShareState narrows SharesService.List.
type ShareState string

const (
	// ShareStateLive lists only what runs now.
	ShareStateLive ShareState = "live"
	// ShareStateEnded lists only what has ended.
	ShareStateEnded ShareState = "ended"
)

// ListSharesOptions say what SharesService.List returns.
type ListSharesOptions struct {
	// State is ShareStateLive or ShareStateEnded; empty lists both, live
	// first.
	State ShareState
}

// List returns the account's previews and live tunnels (live first, then
// the latest that ended), its teams' live previews, this month's shared
// data, the plan's limits, where it stands on reserved names, whether
// sharing is suspended, and Hints: what to do next, as whk commands.
func (s *SharesService) List(ctx context.Context, opts ListSharesOptions) (*ShareList, error) {
	var query url.Values
	switch opts.State {
	case "":
	case ShareStateLive, ShareStateEnded:
		query = url.Values{"state": {string(opts.State)}}
	default:
		return nil, fmt.Errorf("webhooks.cc: invalid share state %q: use ShareStateLive or ShareStateEnded", opts.State)
	}
	var list ShareList
	if err := s.c.api(ctx, http.MethodGet, "/shares", query, nil, &list); err != nil {
		return nil, err
	}
	return &list, nil
}

// Stop stops a preview or live tunnel by its ID. Its CLI is told why and
// exits.
func (s *SharesService) Stop(ctx context.Context, id string) error {
	if err := validateSegment(id, "share id"); err != nil {
		return err
	}
	return s.c.apiRetrying(ctx, http.MethodPost, "/shares/"+id+"/stop", nil, map[string]any{}, nil, true)
}

// Requests returns the last visitor requests to a preview, newest first,
// with no visitor addresses (a number per visitor instead).
func (s *SharesService) Requests(ctx context.Context, id string) (*ShareVisits, error) {
	if err := validateSegment(id, "share id"); err != nil {
		return nil, err
	}
	var visits ShareVisits
	if err := s.c.api(ctx, http.MethodGet, "/shares/"+id+"/requests", nil, nil, &visits); err != nil {
		return nil, err
	}
	return &visits, nil
}

// Start shares a local port at a public link as this client's account, by
// running the whk CLI (see Share). An API-key client passes its key; a
// client acting for a connected agent has whk use the same agent credential
// file, so the share belongs to the account this client sees and never to
// this machine's own whk login. APIKey, AgentAuth, AgentFile and BaseURL in
// opts are set from the client.
func (s *SharesService) Start(ctx context.Context, opts ShareOptions) (*LiveShare, error) {
	c := s.c
	opts.APIKey, opts.AgentAuth, opts.AgentFile = "", false, ""
	opts.BaseURL = c.baseURL
	switch {
	case c.sandbox:
		return nil, &ShareError{Message: "a sandbox cannot share a port: connect the agent to an account first (Sandbox.Claim or Connect)"}
	case c.tokens != nil:
		opts.AgentAuth = true
		if c.agentFileSet {
			opts.AgentFile = c.agentFile
		}
	case c.apiKey != "":
		opts.APIKey = c.apiKey
	default:
		return nil, &ShareError{Message: "Shares.Start needs a client with an API key or a connected agent: whk must share as the same account"}
	}
	return Share(ctx, opts)
}

// NamesService manages reserved preview names (Pro and Business):
// <name>.sharehooks.cc, the same link every time. Use it as client.Names.
type NamesService struct{ c *Client }

// List returns the account's names and its teams' names, with how many its
// plan and each team allow.
func (s *NamesService) List(ctx context.Context) (*NameList, error) {
	var list NameList
	if err := s.c.api(ctx, http.MethodGet, "/tunnel-names", nil, nil, &list); err != nil {
		return nil, err
	}
	return &list, nil
}

// Reserve keeps a name. With a team ID (see NameList.Teams) the name belongs
// to that team, counts against the team's names, and every member may
// share under it; an empty teamID keeps it as the account's own.
func (s *NamesService) Reserve(ctx context.Context, name, teamID string) (*TunnelName, error) {
	if err := validateSegment(name, "name"); err != nil {
		return nil, err
	}
	body := map[string]string{"name": name}
	if teamID != "" {
		if err := validateSegment(teamID, "team id"); err != nil {
			return nil, err
		}
		body["team"] = teamID
	}
	var out struct {
		Name TunnelName `json:"name"`
	}
	if err := s.c.api(ctx, http.MethodPost, "/tunnel-names", nil, body, &out); err != nil {
		return nil, err
	}
	return &out.Name, nil
}

// Release gives a name back: one you reserved, or, as the team's owner, a
// team name. Previews running under it stop.
func (s *NamesService) Release(ctx context.Context, name string) error {
	if err := validateSegment(name, "name"); err != nil {
		return err
	}
	return s.c.api(ctx, http.MethodDelete, "/tunnel-names/"+name, nil, nil, nil)
}

// SetPassword puts a password (8 to 200 characters) on every preview under
// the name. It is never returned.
func (s *NamesService) SetPassword(ctx context.Context, name, password string) error {
	if err := validateSegment(name, "name"); err != nil {
		return err
	}
	if n := len([]rune(password)); n < 8 || n > 200 {
		return errors.New("webhooks.cc: a name's password is 8 to 200 characters")
	}
	return s.c.api(ctx, http.MethodPut, "/tunnel-names/"+name+"/password", nil, map[string]string{"password": password}, nil)
}

// ClearPassword removes the name's password.
func (s *NamesService) ClearPassword(ctx context.Context, name string) error {
	if err := validateSegment(name, "name"); err != nil {
		return err
	}
	return s.c.api(ctx, http.MethodDelete, "/tunnel-names/"+name+"/password", nil, nil, nil)
}

// --- models ------------------------------------------------------------------------

// ShareList is what SharesService.List returns.
type ShareList struct {
	Shares []TunnelShare
	// Usage is this month's shared data (UTC month).
	Usage TunnelUsage
	// Limits is what the plan allows for sharing.
	Limits TunnelLimits
	// Names is where the account stands on its own reserved names; nil from
	// older servers.
	Names *NamesStanding
	// Suspended is true when sharing is suspended on the account.
	Suspended bool
	// Hints say what the account can do next, as whk commands, so an agent
	// never needs the dashboard.
	Hints []string
}

// UnmarshalJSON reads a share list as the API returns it.
func (l *ShareList) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	out := ShareList{Shares: []TunnelShare{}, Suspended: o.boolean("suspended"), Hints: o.strList("hints")}
	for _, raw := range o.array("shares") {
		var share TunnelShare
		if isJSONObject(raw) && json.Unmarshal(raw, &share) == nil {
			out.Shares = append(out.Shares, share)
		}
	}
	if raw := o.raw("usage"); isJSONObject(raw) {
		_ = json.Unmarshal(raw, &out.Usage)
	}
	if raw := o.raw("limits"); isJSONObject(raw) {
		_ = json.Unmarshal(raw, &out.Limits)
	}
	if names := o.object("names"); names != nil {
		out.Names = &NamesStanding{
			Limit:  int(names.num("limit")),
			Used:   int(names.num("used")),
			Usable: int(names.num("usable")),
		}
	}
	*l = out
	return nil
}

// TunnelShare is a preview (`whk share`) or a live tunnel (`whk tunnel
// --live`).
type TunnelShare struct {
	ID string
	// Kind is "share" for a preview at a name, "live" for an endpoint's
	// captures relayed to a local app.
	Kind string
	// Name is the preview's name; empty for a live tunnel.
	Name string
	// URL is the preview's link, or the capture URL of a live tunnel.
	URL string
	// EndpointSlug is the endpoint of a live tunnel.
	EndpointSlug string
	// Client is what it runs on: "laptop, macOS".
	Client    string
	StartedAt time.Time
	// EndedAt is zero while it runs.
	EndedAt time.Time
	// EndReason says why it ended, in words.
	EndReason string
	// ExpiresAt is when the plan's session time runs out; zero without a
	// limit.
	ExpiresAt time.Time
	// Bytes is the data sent to visitors.
	Bytes    int64
	Requests int64
	// Password is true when visitors need a password.
	Password bool
	// Notice is true when visitors see a short notice before the page.
	Notice bool
	// Mine is false for a teammate's preview under a team name, or a
	// teammate's live tunnel on one of your endpoints.
	Mine bool
	// StartedBy names who started it, for a teammate's; nil for your own.
	StartedBy *TunnelPerson
}

// Live reports whether it still runs.
func (s TunnelShare) Live() bool { return s.EndedAt.IsZero() }

// UnmarshalJSON reads a share as the API returns it.
func (s *TunnelShare) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*s = TunnelShare{
		ID:           o.str("id"),
		Kind:         o.str("kind"),
		Name:         o.str("name"),
		URL:          o.str("url"),
		EndpointSlug: o.str("endpointSlug"),
		Client:       o.str("client"),
		StartedAt:    o.isoTime("startedAt"),
		EndedAt:      o.isoTime("endedAt"),
		EndReason:    o.str("endReason"),
		ExpiresAt:    o.isoTime("expiresAt"),
		Bytes:        int64(o.num("bytes")),
		Requests:     int64(o.num("requests")),
		Password:     o.boolean("password"),
		Notice:       o.boolean("notice"),
		Mine:         true,
		StartedBy:    o.person("startedBy"),
	}
	if mine := o.optBool("mine"); mine != nil {
		s.Mine = *mine
	}
	if s.Kind == "" {
		s.Kind = "share"
	}
	return nil
}

// TunnelPerson is an account named in a share or a name.
type TunnelPerson struct {
	ID    string
	Email string
}

// TunnelUsage is this month's shared data (UTC month).
type TunnelUsage struct {
	// Month is "2026-11".
	Month      string
	Bytes      int64
	LimitBytes int64
	// Over is true once the month's data is used: previews pause until
	// ResetsAt.
	Over     bool
	ResetsAt time.Time
	// Message says why previews are paused and until when; empty when not.
	Message string
}

// UnmarshalJSON reads usage as the API returns it.
func (u *TunnelUsage) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*u = TunnelUsage{
		Month:      o.str("month"),
		Bytes:      int64(o.num("bytes")),
		LimitBytes: int64(o.num("limitBytes")),
		Over:       o.boolean("over"),
		ResetsAt:   o.isoTime("resetsAt"),
		Message:    o.str("message"),
	}
	return nil
}

// TunnelLimits is what the account's plan allows for sharing.
type TunnelLimits struct {
	// Plan is the plan the limits come from ("free", "pro", "team_business").
	Plan string
	// Label is the plan's name for people ("Pro").
	Label string
	// Shares is the previews that may run at once.
	Shares        int
	ReservedNames int
	// SessionMinutes is how long a preview may run; 0 without a limit.
	SessionMinutes int
	// DataGB is the data a month, in GB.
	DataGB    int
	Passwords bool
	// Notice is true when visitors see a short notice before the page.
	Notice bool
}

// UnmarshalJSON reads limits as the API returns them.
func (l *TunnelLimits) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*l = TunnelLimits{
		Plan:           o.str("plan"),
		Label:          o.str("label"),
		Shares:         int(o.num("shares")),
		ReservedNames:  int(o.num("reservedNames")),
		SessionMinutes: int(o.num("sessionMinutes")),
		DataGB:         int(o.num("dataGb")),
		Passwords:      o.boolean("passwords"),
		Notice:         o.boolean("notice"),
	}
	return nil
}

// NamesStanding is where an account stands on its own reserved names.
type NamesStanding struct {
	// Limit is the own names the plan allows, Used the ones kept, Usable the
	// ones a preview may run under now (names past a smaller plan's count
	// are kept but not usable).
	Limit, Used, Usable int
}

// ShareVisits is what SharesService.Requests returns.
type ShareVisits struct {
	// Available is false when the edge could not be asked just now.
	Available bool
	// Requests are newest first.
	Requests []ShareVisit
}

// UnmarshalJSON reads visits as the API returns them.
func (v *ShareVisits) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	out := ShareVisits{Available: true, Requests: []ShareVisit{}}
	if available := o.optBool("available"); available != nil {
		out.Available = *available
	}
	for _, raw := range o.array("requests") {
		var r rawObject
		if !isJSONObject(raw) || json.Unmarshal(raw, &r) != nil {
			continue
		}
		out.Requests = append(out.Requests, ShareVisit{
			Method:  r.str("method"),
			Path:    r.str("path"),
			Status:  int(r.num("status")),
			MS:      int64(r.num("ms")),
			Bytes:   int64(r.num("bytes")),
			At:      r.isoTime("at"),
			Country: r.str("country"),
			Device:  r.str("device"),
			Visitor: int(r.num("visitor")),
		})
	}
	*v = out
	return nil
}

// ShareVisit is one visitor request to a preview, from the edge's memory.
type ShareVisit struct {
	Method string
	Path   string
	Status int
	MS     int64
	Bytes  int64
	At     time.Time
	// Country is a two-letter code, or empty.
	Country string
	// Device is "phone", "tablet", "computer", "bot" or "unknown".
	Device string
	// Visitor is 1 for the first visitor seen, 2 for the next.
	Visitor int
}

// NameList is what NamesService.List returns.
type NameList struct {
	Names []TunnelName
	// Limit is the own names (outside teams) the plan allows; Used the own
	// names kept.
	Limit, Used int
	// Plan is the plan the sharing limits come from.
	Plan string
	// Teams are each team's own count: team names count against the team.
	Teams []TeamNameCount
}

// UnmarshalJSON reads a name list as the API returns it.
func (l *NameList) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	out := NameList{
		Names: []TunnelName{},
		Limit: int(o.num("limit")),
		Used:  int(o.num("used")),
		Plan:  o.str("plan"),
	}
	for _, raw := range o.array("names") {
		var name TunnelName
		if isJSONObject(raw) && json.Unmarshal(raw, &name) == nil {
			out.Names = append(out.Names, name)
		}
	}
	for _, raw := range o.array("teams") {
		var t rawObject
		if !isJSONObject(raw) || json.Unmarshal(raw, &t) != nil {
			continue
		}
		count := TeamNameCount{ID: t.str("id"), Name: t.str("name"), Active: true, Limit: int(t.num("limit")), Used: int(t.num("used"))}
		if active := t.optBool("active"); active != nil {
			count.Active = *active
		}
		out.Teams = append(out.Teams, count)
	}
	*l = out
	return nil
}

// TeamNameCount is how many names a team keeps against how many it may.
type TeamNameCount struct {
	ID   string
	Name string
	// Active is false while the team has no subscription: its names wait,
	// unusable.
	Active bool
	// Limit is the names the team may keep (its plan's names per seat).
	Limit int
	Used  int
}

// TunnelName is a reserved preview name.
type TunnelName struct {
	Name string
	// URL is the preview link it gives.
	URL string
	// Team is the team it belongs to, when reserved inside one.
	Team       *TunnelTeam
	ReservedBy *TunnelPerson
	// Mine is false for a teammate's name.
	Mine bool
	// Password is true when the name has a password of its own.
	Password bool
	// Live is true when a preview runs under it now.
	Live bool
	// Usable is false when the plan no longer covers it (past the count
	// after a downgrade, or a team without a subscription): it is kept, but
	// nothing can be shared under it until the plan grows or another name
	// is released.
	Usable    bool
	CreatedAt time.Time
}

// UnmarshalJSON reads a name as the API returns it.
func (n *TunnelName) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*n = TunnelName{
		Name:       o.str("name"),
		URL:        o.str("url"),
		ReservedBy: o.person("reservedBy"),
		Mine:       true,
		Password:   o.boolean("password"),
		Live:       o.boolean("live"),
		Usable:     true,
		CreatedAt:  o.isoTime("createdAt"),
	}
	if team := o.object("team"); team != nil {
		n.Team = &TunnelTeam{ID: team.str("id"), Name: team.str("name")}
	}
	if mine := o.optBool("mine"); mine != nil {
		n.Mine = *mine
	}
	if usable := o.optBool("usable"); usable != nil {
		n.Usable = *usable
	}
	return nil
}

// TunnelTeam is the team a name belongs to.
type TunnelTeam struct {
	ID   string
	Name string
}

// isoTime reads an RFC 3339 time, or milliseconds since the epoch; zero when
// missing or unreadable.
func (o rawObject) isoTime(key string) time.Time {
	if value, ok := o.strOK(key); ok {
		if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
			return t
		}
		return time.Time{}
	}
	return o.millis(key)
}

// person reads {id, email} (or a bare id string) as a TunnelPerson.
func (o rawObject) person(key string) *TunnelPerson {
	if id, ok := o.strOK(key); ok {
		return &TunnelPerson{ID: id}
	}
	if p := o.object(key); p != nil {
		return &TunnelPerson{ID: p.str("id"), Email: p.str("email")}
	}
	return nil
}
