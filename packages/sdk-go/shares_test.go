package webhookscc_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	webhookscc "webhooks.cc/go"
)

const shareID = "8e7c0d3a-5f1b-4c2e-9a6d-1b2c3d4e5f60"

func shareListJSON() map[string]any {
	return map[string]any{
		"shares": []any{
			map[string]any{
				"id": shareID, "kind": "share", "name": "acme-demo", "url": "https://acme-demo.sharehooks.cc",
				"endpointSlug": nil, "client": "laptop, Linux", "startedAt": "2026-11-10T18:00:00.000Z",
				"endedAt": nil, "endReason": nil, "expiresAt": nil, "bytes": 2048, "requests": 3,
				"password": true, "notice": false, "mine": true, "startedBy": nil,
			},
			map[string]any{
				"id": "live-1", "kind": "live", "name": nil, "url": "https://go.webhooks.cc/w/acme",
				"endpointSlug": "acme", "client": "ci, Linux", "startedAt": "2026-11-10T17:00:00.000Z",
				"endedAt": "2026-11-10T17:30:00.000Z", "endReason": "you stopped it", "expiresAt": nil,
				"bytes": 0, "requests": 9, "password": false, "notice": false, "mine": false,
				"startedBy": map[string]any{"id": "u2", "email": "teammate@example.com"},
			},
		},
		"usage": map[string]any{
			"month": "2026-11", "bytes": 2048, "limitBytes": 26843545600, "over": false,
			"resetsAt": "2026-12-01T00:00:00.000Z", "message": nil,
		},
		"limits": map[string]any{
			"plan": "pro", "label": "Pro", "shares": 3, "reservedNames": 3, "sessionMinutes": nil,
			"dataGb": 25, "passwords": true, "notice": false,
		},
		"names":     map[string]any{"limit": 3, "used": 1, "usable": 1},
		"suspended": false,
		"hints":     []string{"Share a local port with whk share <port>; it prints the link."},
	}
}

func TestSharesListIsParsed(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/shares", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, shareListJSON())
	})
	list, err := api.client().Shares.List(context.Background(), webhookscc.ListSharesOptions{State: webhookscc.ShareStateLive})
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := api.last(); r.URL.Query().Get("state") != "live" {
		t.Errorf("state = %q", r.URL.RawQuery)
	}
	if len(list.Shares) != 2 {
		t.Fatalf("shares = %+v", list.Shares)
	}
	s := list.Shares[0]
	if s.ID != shareID || s.Kind != "share" || s.Name != "acme-demo" || !s.Password || !s.Mine || !s.Live() ||
		s.Bytes != 2048 || s.Requests != 3 || s.StartedAt.IsZero() || !s.ExpiresAt.IsZero() || s.StartedBy != nil {
		t.Errorf("share = %+v", s)
	}
	live := list.Shares[1]
	if live.Kind != "live" || live.EndpointSlug != "acme" || live.Mine || live.Live() ||
		live.StartedBy == nil || live.StartedBy.Email != "teammate@example.com" || live.EndReason != "you stopped it" {
		t.Errorf("live = %+v", live)
	}
	if list.Usage.Month != "2026-11" || list.Usage.LimitBytes != 26843545600 || list.Usage.Over || list.Usage.ResetsAt.IsZero() {
		t.Errorf("usage = %+v", list.Usage)
	}
	if list.Limits.Plan != "pro" || list.Limits.Label != "Pro" || list.Limits.Shares != 3 ||
		list.Limits.SessionMinutes != 0 || list.Limits.DataGB != 25 || !list.Limits.Passwords {
		t.Errorf("limits = %+v", list.Limits)
	}
	if list.Names == nil || *list.Names != (webhookscc.NamesStanding{Limit: 3, Used: 1, Usable: 1}) {
		t.Errorf("names = %+v", list.Names)
	}
	if list.Suspended || len(list.Hints) != 1 {
		t.Errorf("suspended %v hints %v", list.Suspended, list.Hints)
	}
}

func TestSharesListIsLenient(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/shares", func(w http.ResponseWriter, r *http.Request) {
		// An older server: no names, hints or notice; times as milliseconds.
		writeJSON(w, 200, map[string]any{
			"shares": []any{map[string]any{"id": "a", "startedAt": 1794333455000, "bytes": "x"}, "junk"},
			"usage":  map[string]any{"month": "2026-11"},
			"limits": map[string]any{"plan": "free", "sessionMinutes": 120},
		})
	})
	list, err := api.client().Shares.List(context.Background(), webhookscc.ListSharesOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Shares) != 1 || list.Shares[0].Kind != "share" || !list.Shares[0].Mine || list.Shares[0].StartedAt.IsZero() {
		t.Errorf("shares = %+v", list.Shares)
	}
	if list.Names != nil || list.Hints != nil || list.Limits.SessionMinutes != 120 {
		t.Errorf("list = %+v", list)
	}
	if _, err := api.client().Shares.List(context.Background(), webhookscc.ListSharesOptions{State: "all"}); err == nil {
		t.Error("an unknown state should be refused before any call")
	}
}

func TestSharesStopAndRequests(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/shares/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != shareID {
			writeJSON(w, 404, map[string]string{"error": "Share not found"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "stopped": true, "edgeReached": true})
	})
	api.handle("GET /api/shares/{id}/requests", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"available": true,
			"requests": []any{map[string]any{
				"method": "GET", "path": "/", "status": 200, "ms": 12, "bytes": 512,
				"at": "2026-11-10T18:01:00.000Z", "country": "DK", "device": "computer", "visitor": 1,
			}},
		})
	})
	client := api.client()
	ctx := context.Background()
	if err := client.Shares.Stop(ctx, shareID); err != nil {
		t.Fatal(err)
	}
	if err := client.Shares.Stop(ctx, "missing"); !errors.Is(err, webhookscc.ErrNotFound) {
		t.Errorf("Stop(missing) = %v, want ErrNotFound", err)
	}
	if err := client.Shares.Stop(ctx, "../x"); err == nil {
		t.Error("a bad id should be refused before any call")
	}
	visits, err := client.Shares.Requests(ctx, shareID)
	if err != nil {
		t.Fatal(err)
	}
	if !visits.Available || len(visits.Requests) != 1 {
		t.Fatalf("visits = %+v", visits)
	}
	v := visits.Requests[0]
	if v.Method != "GET" || v.Status != 200 || v.MS != 12 || v.Bytes != 512 || v.Country != "DK" ||
		v.Device != "computer" || v.Visitor != 1 || v.At.IsZero() {
		t.Errorf("visit = %+v", v)
	}
}

func TestNamesCallTheirRoutes(t *testing.T) {
	api := newFakeAPI(t)
	nameJSON := map[string]any{
		"name": "acme-demo", "url": "https://acme-demo.sharehooks.cc",
		"team": map[string]any{"id": "team_1", "name": "Acme"}, "reservedBy": map[string]any{"id": "u1", "email": "me@example.com"},
		"mine": true, "password": false, "live": true, "usable": false, "createdAt": "2026-11-01T00:00:00.000Z",
	}
	api.handle("GET /api/tunnel-names", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"names": []any{nameJSON, map[string]any{"name": "old-server"}},
			"limit": 3, "used": 1, "plan": "team",
			"teams": []any{map[string]any{"id": "team_1", "name": "Acme", "active": false, "limit": 6, "used": 2}},
		})
	})
	api.handle("POST /api/tunnel-names", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 201, map[string]any{"name": nameJSON})
	})
	api.handle("DELETE /api/tunnel-names/{name}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	api.handle("PUT /api/tunnel-names/{name}/password", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "password": true})
	})
	api.handle("DELETE /api/tunnel-names/{name}/password", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "password": false})
	})
	client := api.client()
	ctx := context.Background()

	list, err := client.Names.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if list.Limit != 3 || list.Used != 1 || list.Plan != "team" || len(list.Names) != 2 || len(list.Teams) != 1 {
		t.Fatalf("list = %+v", list)
	}
	n := list.Names[0]
	if n.Name != "acme-demo" || n.Team == nil || n.Team.Name != "Acme" || n.ReservedBy == nil || !n.Live || n.Usable || n.CreatedAt.IsZero() {
		t.Errorf("name = %+v", n)
	}
	if old := list.Names[1]; !old.Usable || !old.Mine || old.Team != nil {
		t.Errorf("a name from an older server should read usable and mine: %+v", old)
	}
	if team := list.Teams[0]; team.Active || team.Limit != 6 || team.Used != 2 {
		t.Errorf("team = %+v", team)
	}

	reserved, err := client.Names.Reserve(ctx, "acme-demo", "team_1")
	if err != nil || reserved.Name != "acme-demo" {
		t.Fatalf("Reserve = %+v, %v", reserved, err)
	}
	if _, body := api.last(); body != `{"name":"acme-demo","team":"team_1"}` {
		t.Errorf("reserve body = %s", body)
	}
	if _, err := client.Names.Reserve(ctx, "acme-demo", ""); err != nil {
		t.Fatal(err)
	}
	if _, body := api.last(); body != `{"name":"acme-demo"}` {
		t.Errorf("reserve body without a team = %s", body)
	}
	if err := client.Names.SetPassword(ctx, "acme-demo", "correct-horse"); err != nil {
		t.Fatal(err)
	}
	if r, body := api.last(); r.Method != http.MethodPut || body != `{"password":"correct-horse"}` {
		t.Errorf("set password = %s %s", r.Method, body)
	}
	if err := client.Names.SetPassword(ctx, "acme-demo", "short"); err == nil {
		t.Error("a short password should be refused before any call")
	}
	if err := client.Names.ClearPassword(ctx, "acme-demo"); err != nil {
		t.Fatal(err)
	}
	if r, _ := api.last(); r.Method != http.MethodDelete || r.URL.Path != "/api/tunnel-names/acme-demo/password" {
		t.Errorf("clear password = %s %s", r.Method, r.URL.Path)
	}
	if err := client.Names.Release(ctx, "acme-demo"); err != nil {
		t.Fatal(err)
	}
	if r, _ := api.last(); r.Method != http.MethodDelete || r.URL.Path != "/api/tunnel-names/acme-demo" {
		t.Errorf("release = %s %s", r.Method, r.URL.Path)
	}
}

func TestNamesReserveErrorKeepsTheServersWords(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("POST /api/tunnel-names", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 403, map[string]string{"error": "Free shares get a random name. Reserved names come with Pro and Business."})
	})
	_, err := api.client().Names.Reserve(context.Background(), "acme-demo", "")
	var apiErr *webhookscc.Error
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 403 || !strings.Contains(apiErr.Message, "Pro and Business") {
		t.Fatalf("err = %v", err)
	}
}
