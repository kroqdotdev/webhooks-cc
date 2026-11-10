package webhookscc_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

// fakeShareEnv makes this test binary act as `whk share` (see TestMain).
const fakeShareEnv = "WHK_GO_SDK_FAKE_SHARE"

// TestMain lets the test binary stand in for whk: Share runs it with
// fakeShareEnv set and the share arguments.
func TestMain(m *testing.M) {
	if mode := os.Getenv(fakeShareEnv); mode != "" {
		os.Exit(fakeWhk(mode))
	}
	os.Exit(m.Run())
}

// fakeWhk prints what `whk share --json` would. The notice event reports the
// arguments and environment it got, for the tests to check.
func fakeWhk(mode string) int {
	out := json.NewEncoder(os.Stdout)
	switch mode {
	case "old":
		fmt.Fprintln(os.Stderr, "error: unrecognized subcommand 'share'")
		return 2
	case "refuse":
		_ = out.Encode(map[string]any{"event": "error", "message": "Free allows 1 live share at a time. Stop one with whk shares stop."})
		return 1
	}
	_ = out.Encode(map[string]any{
		"event": "live", "url": "https://calm-river-7f2a-free.sharehooks.cc", "name": "calm-river-7f2a-free",
		"expiresAt": "2026-11-10T20:00:00.000Z", "notice": true, "password": os.Getenv("WHK_SHARE_PASSWORD") != "",
	})
	seen := map[string]any{
		"args":     os.Args[1:],
		"apiKey":   os.Getenv("WHK_API_KEY"),
		"auth":     os.Getenv("WHK_AUTH"),
		"agent":    os.Getenv("WHK_AGENT_FILE"),
		"password": os.Getenv("WHK_SHARE_PASSWORD"),
		"apiUrl":   os.Getenv("WHK_API_URL"),
		"tunnel":   os.Getenv("WHK_TUNNEL_URL"),
	}
	text, _ := json.Marshal(seen)
	_ = out.Encode(map[string]any{"event": "notice", "text": string(text)})
	_ = out.Encode(map[string]any{"event": "request", "method": "GET", "path": "/", "status": 200, "ms": 4})
	if mode == "stubborn" {
		// Ignores its stdin closing, so Stop has to signal it.
		time.Sleep(time.Minute)
		return 0
	}
	// --until-stdin-closes: run until stdin closes.
	reader := bufio.NewReader(os.Stdin)
	for {
		if _, err := reader.ReadByte(); err != nil {
			break
		}
	}
	_ = out.Encode(map[string]any{"event": "stopped", "reason": "you stopped it on this computer"})
	return 0
}

func fakeShareOptions(t *testing.T, mode string) webhookscc.ShareOptions {
	t.Helper()
	t.Setenv(fakeShareEnv, mode)
	return webhookscc.ShareOptions{Port: 3000, WhkPath: os.Args[0], OpenTimeout: 20 * time.Second}
}

// seen reads the arguments and environment the fake whk reported.
func seen(t *testing.T, live *webhookscc.LiveShare) map[string]any {
	t.Helper()
	for {
		select {
		case event, ok := <-live.Events():
			if !ok {
				t.Fatal("the share ended before its notice")
			}
			if event.Event != "notice" {
				continue
			}
			var got map[string]any
			if err := json.Unmarshal([]byte(event.Text), &got); err != nil {
				t.Fatal(err)
			}
			return got
		case <-time.After(10 * time.Second):
			t.Fatal("no notice from the fake whk")
		}
	}
}

func TestShareOpensAndStops(t *testing.T) {
	t.Setenv("WHK_API_KEY", "whcc_from_the_environment")
	t.Setenv("WHK_AUTH", "agent")
	opts := fakeShareOptions(t, "live")
	opts.Name = "acme-demo"
	opts.Password = "correct-horse"
	opts.TunnelURL = "ws://localhost:4000"
	opts.BaseURL = "http://localhost:3000/"

	live, err := webhookscc.Share(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if live.URL != "https://calm-river-7f2a-free.sharehooks.cc" || live.Name != "calm-river-7f2a-free" ||
		!live.Notice || !live.Password || live.ExpiresAt.IsZero() || live.Port != 3000 {
		t.Errorf("live = %+v", live)
	}
	got := seen(t, live)
	args, _ := json.Marshal(got["args"])
	if string(args) != `["share","3000","--json","--until-stdin-closes","--name","acme-demo","--password"]` {
		t.Errorf("args = %s", args)
	}
	if strings.Contains(string(args), "correct-horse") {
		t.Error("the password must never be an argument")
	}
	if got["password"] != "correct-horse" || got["apiUrl"] != "http://localhost:3000" || got["tunnel"] != "ws://localhost:4000" {
		t.Errorf("env = %v", got)
	}
	// No key or agent auth given: the environment's key is passed on, a
	// stray WHK_AUTH is not.
	if got["apiKey"] != "whcc_from_the_environment" || got["auth"] != "" {
		t.Errorf("auth env = %v", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := live.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if reason := live.Reason(); reason != "you stopped it on this computer" {
		t.Errorf("reason = %q", reason)
	}
	if reason, err := live.Wait(ctx); err != nil || reason == "" {
		t.Errorf("Wait = %q, %v", reason, err)
	}
	for range live.Events() {
		// Drains; the channel closes once the share ended.
	}
}

func TestShareWithAnAPIKeyOrAnAgentConnection(t *testing.T) {
	t.Setenv("WHK_API_KEY", "whcc_from_the_environment")
	opts := fakeShareOptions(t, "live")
	opts.APIKey = "whcc_given"
	live, err := webhookscc.Share(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if got := seen(t, live); got["apiKey"] != "whcc_given" || got["auth"] != "" || got["password"] != "" {
		t.Errorf("env = %v", got)
	}
	_ = live.Stop(context.Background())

	opts = fakeShareOptions(t, "live")
	opts.AgentAuth = true
	opts.AgentFile = filepath.Join(t.TempDir(), "agent.json")
	live, err = webhookscc.Share(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if got := seen(t, live); got["apiKey"] != "" || got["auth"] != "agent" || got["agent"] != opts.AgentFile {
		t.Errorf("agent env = %v", got)
	}
	_ = live.Stop(context.Background())
}

func TestShareReportsTheCLIsRefusal(t *testing.T) {
	_, err := webhookscc.Share(context.Background(), fakeShareOptions(t, "refuse"))
	var shareErr *webhookscc.ShareError
	if !errors.As(err, &shareErr) || !strings.Contains(shareErr.Message, "Free allows 1 live share") {
		t.Fatalf("err = %v", err)
	}
}

func TestShareNamesAnOldCLI(t *testing.T) {
	_, err := webhookscc.Share(context.Background(), fakeShareOptions(t, "old"))
	if err == nil || !strings.Contains(err.Error(), "newer whk") {
		t.Fatalf("err = %v", err)
	}
}

func TestShareWithoutWhk(t *testing.T) {
	_, err := webhookscc.Share(context.Background(), webhookscc.ShareOptions{
		Port: 3000, WhkPath: filepath.Join(t.TempDir(), "no-whk-here"),
	})
	if !errors.Is(err, webhookscc.ErrWhkNotInstalled) || !strings.Contains(err.Error(), webhookscc.WhkInstallHint()) {
		t.Fatalf("err = %v", err)
	}
}

func TestShareRefusesBadOptionsBeforeRunning(t *testing.T) {
	for _, opts := range []webhookscc.ShareOptions{
		{Port: 0},
		{Port: 70000},
		{Port: 3000, Name: "Not A Name"},
		{Port: 3000, Password: "short"},
	} {
		opts.WhkPath = filepath.Join(t.TempDir(), "never-run")
		if _, err := webhookscc.Share(context.Background(), opts); err == nil || errors.Is(err, webhookscc.ErrWhkNotInstalled) {
			t.Errorf("%+v: err = %v", opts, err)
		}
	}
}

func TestShareEndsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	live, err := webhookscc.Share(ctx, fakeShareOptions(t, "live"))
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-live.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("cancelling the context did not stop the share")
	}
	if live.Reason() != "you stopped it on this computer" {
		t.Errorf("reason = %q", live.Reason())
	}
}

func TestShareStopSignalsAStubbornCLI(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the stop grace")
	}
	live, err := webhookscc.Share(context.Background(), fakeShareOptions(t, "stubborn"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	start := time.Now()
	if err := live.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if waited := time.Since(start); waited < 4*time.Second {
		t.Errorf("stopped after %s, before the grace", waited)
	}
}

func TestSharesStartPicksTheClientsAccount(t *testing.T) {
	api := newFakeAPI(t)
	opts := fakeShareOptions(t, "live")
	opts.APIKey = "whcc_ignored"
	live, err := api.client().Shares.Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	got := seen(t, live)
	if got["apiKey"] != "whcc_test" || got["auth"] != "" || !strings.HasPrefix(fmt.Sprint(got["apiUrl"]), "http://127.0.0.1") {
		t.Errorf("env = %v", got)
	}
	_ = live.Stop(context.Background())
}
