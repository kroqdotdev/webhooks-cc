package webhookscc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// WhkInstallCommand installs the whk CLI on macOS and Linux (Homebrew:
// brew install kroqdotdev/tap/whk).
const WhkInstallCommand = "curl -fsSL https://webhooks.cc/install.sh | sh"

// WhkInstallWindows is how to get the whk CLI on Windows, which has no
// install script: a release download.
const WhkInstallWindows = "download whk for Windows from https://github.com/kroqdotdev/webhooks-cc/releases and put it on your PATH"

// WhkInstallHint is how to install the whk CLI on this platform.
func WhkInstallHint() string {
	if runtime.GOOS == "windows" {
		return WhkInstallWindows
	}
	return WhkInstallCommand
}

// ErrWhkNotInstalled: Share found no whk CLI to run. errors.Is matches a
// ShareError that wraps it.
var ErrWhkNotInstalled = errors.New("webhooks.cc: the whk CLI is not installed")

// ShareError is why a share could not open, or ended: the CLI's own words
// where it gave them.
type ShareError struct {
	Message string
	// Err is ErrWhkNotInstalled when whk is missing, the context's error
	// when it ended first, or nil.
	Err error
}

func (e *ShareError) Error() string { return "webhooks.cc: " + e.Message }

// Unwrap returns Err.
func (e *ShareError) Unwrap() error { return e.Err }

const (
	// defaultShareOpenTimeout is how long Share waits for the link.
	defaultShareOpenTimeout = 60 * time.Second
	// shareStopGrace is how long Stop waits after closing the CLI's stdin
	// before it signals it, and again before it kills it.
	shareStopGrace = 5 * time.Second
	// shareEventBuffer is how many events wait for a reader before the
	// oldest unread ones are dropped: a share never waits on its reader.
	shareEventBuffer = 256
)

var shareNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ShareOptions configure Share.
type ShareOptions struct {
	// Port is the local port to share, 1 to 65535.
	Port int
	// Name is a name you reserved (Pro and Business): <name>.sharehooks.cc.
	// Free shares get a random name.
	Name string
	// Password is what visitors must type to open it (Pro and Business), 8
	// to 200 characters. It goes to whk through the environment, never the
	// command line.
	Password string
	// WhkPath is the whk binary to run (default: whk on the PATH).
	WhkPath string
	// TunnelURL is the tunnel to connect to (default: whk's own,
	// wss://tunnel.webhooks.cc).
	TunnelURL string
	// BaseURL is the API base URL whk talks to (default: whk's own).
	BaseURL string
	// APIKey is the key whk shares with. Without it, and without AgentAuth,
	// whk uses WHK_API_KEY from this process's environment, else its own
	// login or the agent credential file, as it does on its own.
	APIKey string
	// AgentAuth makes whk use the agent credential file and never this
	// machine's own login, so the share belongs to the account an agent
	// connection names. SharesService.Start sets it for a connected agent.
	AgentAuth bool
	// AgentFile is the agent credential file whk reads with AgentAuth
	// (default: its own).
	AgentFile string
	// OpenTimeout bounds the wait for the link (default 60 seconds); the
	// share is stopped when it runs out.
	OpenTimeout time.Duration
}

// ShareEvent is one line `whk share --json` prints.
type ShareEvent struct {
	// Event is "live", "reconnected", "request", "notice", "retrying",
	// "stopped" or "error".
	Event string
	// URL, Name, ExpiresAt, Notice and Password come with "live" (again on
	// a reconnect at another address).
	URL       string
	Name      string
	ExpiresAt time.Time
	Notice    bool
	Password  bool
	// Method, Path, Status and MS come with "request": a visitor request,
	// once answered.
	Method string
	Path   string
	Status int
	MS     int64
	// Text comes with "notice": something the edge said, such as a response
	// it kept back.
	Text string
	// Message comes with "retrying" and "error"; Seconds with "retrying".
	Message string
	Seconds float64
	// Reason comes with "stopped".
	Reason string
	// Raw is the line as printed.
	Raw json.RawMessage
}

func parseShareEvent(line []byte) (ShareEvent, bool) {
	var o rawObject
	if json.Unmarshal(line, &o) != nil {
		return ShareEvent{}, false
	}
	name, ok := o.strOK("event")
	if !ok {
		return ShareEvent{}, false
	}
	return ShareEvent{
		Event:     name,
		URL:       o.str("url"),
		Name:      o.str("name"),
		ExpiresAt: o.isoTime("expiresAt"),
		Notice:    o.boolean("notice"),
		Password:  o.boolean("password"),
		Method:    o.str("method"),
		Path:      o.str("path"),
		Status:    int(o.num("status")),
		MS:        int64(o.num("ms")),
		Text:      o.str("text"),
		Message:   o.str("message"),
		Seconds:   o.num("seconds"),
		Reason:    o.str("reason"),
		Raw:       append(json.RawMessage(nil), line...),
	}, true
}

// LiveShare is a running share of a local port.
type LiveShare struct {
	// URL is the public link and Name its name: a reserved one, or a random
	// one ending in -free on Free. A reconnect at another address arrives
	// as a "live" event; these keep the first.
	URL  string
	Name string
	// ExpiresAt is when the plan's session time runs out; zero without a
	// limit.
	ExpiresAt time.Time
	// Notice is true when visitors see a short notice before the page (Free,
	// and paid accounts in their first days).
	Notice bool
	// Password is true when visitors need a password.
	Password bool
	// Port is the local port it forwards to.
	Port int

	events chan ShareEvent
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	done   chan struct{}

	mu       sync.Mutex
	stopping bool
	reason   string
}

// Events delivers what whk prints after the link opened (visitor requests,
// notices, reconnects, the ending), and closes when the share ends. Events
// nobody reads in time are dropped, so a share never waits on its reader.
func (s *LiveShare) Events() <-chan ShareEvent { return s.events }

// Done is closed when the share has ended, however it ended.
func (s *LiveShare) Done() <-chan struct{} { return s.done }

// Reason says why the share ended; empty while it runs.
func (s *LiveShare) Reason() string {
	select {
	case <-s.done:
	default:
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reason
}

// Wait blocks until the share ends and returns why, or returns the
// context's error first.
func (s *LiveShare) Wait(ctx context.Context) (string, error) {
	select {
	case <-s.done:
		return s.Reason(), nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Stop ends the share: it closes whk's stdin, which ends it cleanly on every
// platform, then signals it after 5 seconds and kills it after 10. It
// returns once whk has exited, or the context's error first (the share is
// still being stopped then).
func (s *LiveShare) Stop(ctx context.Context) error {
	s.mu.Lock()
	first := !s.stopping
	s.stopping = true
	s.mu.Unlock()
	if first {
		_ = s.stdin.Close()
		go s.escalate()
	}
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// escalate signals, then kills, a whk that did not exit after its stdin
// closed.
func (s *LiveShare) escalate() {
	timer := time.NewTimer(shareStopGrace)
	defer timer.Stop()
	select {
	case <-s.done:
		return
	case <-timer.C:
	}
	if s.cmd.Process != nil {
		if runtime.GOOS == "windows" || s.cmd.Process.Signal(syscall.SIGTERM) != nil {
			_ = s.cmd.Process.Kill()
		}
	}
	timer.Reset(shareStopGrace)
	select {
	case <-s.done:
	case <-timer.C:
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
	}
}

// Share shares a local port at a public link by running the webhooks.cc CLI
// (`whk share <port> --json --until-stdin-closes`) and returns once the link
// works. The tunnel is the CLI's: this only starts it, listens and stops
// it. The share keeps running until Stop, the context ends (ctx bounds the
// share's whole life, not only the wait for the link), the plan's session
// limit, or a stop from webhooks.cc; whk also ends when this process's end
// closes its stdin, so no share outlives the program that started it.
//
//	live, err := webhookscc.Share(ctx, webhookscc.ShareOptions{Port: 3000})
//	if err != nil {
//		return err
//	}
//	defer live.Stop(context.Background())
//	fmt.Println(live.URL) // https://sample-preview-1234-free.sharehooks.cc
//
// Use client.Shares.Start to share as a client's account.
func Share(ctx context.Context, opts ShareOptions) (*LiveShare, error) {
	if opts.Port < 1 || opts.Port > 65535 {
		return nil, &ShareError{Message: fmt.Sprintf("%d is not a port (1 to 65535)", opts.Port)}
	}
	if opts.Name != "" && !shareNamePattern.MatchString(opts.Name) {
		return nil, &ShareError{Message: "a share name is lowercase letters, digits and dashes, starting with a letter or digit"}
	}
	if opts.Password != "" {
		if n := len([]rune(opts.Password)); n < 8 || n > 200 {
			return nil, &ShareError{Message: "a share password is 8 to 200 characters"}
		}
	}
	bin := opts.WhkPath
	if bin == "" {
		bin = "whk"
	}
	args := []string{"share", fmt.Sprint(opts.Port), "--json", "--until-stdin-closes"}
	if opts.Name != "" {
		args = append(args, "--name", opts.Name)
	}
	if opts.Password != "" {
		args = append(args, "--password")
	}

	cmd := exec.Command(bin, args...)
	cmd.Env = shareEnv(os.Environ(), opts)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, &ShareError{Message: "could not run " + bin + ": " + err.Error()}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, &ShareError{Message: "could not run " + bin + ": " + err.Error()}
	}
	stderr := &tailBuffer{max: 4000}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			where := "which is not installed"
			if opts.WhkPath != "" {
				where = "and there is none at " + bin
			}
			return nil, &ShareError{
				Message: fmt.Sprintf("sharing a port needs the webhooks.cc CLI (whk), %s. To install it, %s", where, installClause()),
				Err:     ErrWhkNotInstalled,
			}
		}
		return nil, &ShareError{Message: "could not run " + bin + ": " + err.Error()}
	}

	share := &LiveShare{
		Port:   opts.Port,
		events: make(chan ShareEvent, shareEventBuffer),
		cmd:    cmd,
		stdin:  stdin,
		done:   make(chan struct{}),
	}
	opened := make(chan struct{})
	var (
		openOnce  sync.Once
		words     string
		lastRetry string
		wordsMu   sync.Mutex
	)

	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		isOpen := false
		for scanner.Scan() {
			event, ok := parseShareEvent(scanner.Bytes())
			if !ok {
				continue
			}
			switch event.Event {
			case "live":
				if !isOpen {
					isOpen = true
					share.URL, share.Name = event.URL, event.Name
					share.ExpiresAt, share.Notice, share.Password = event.ExpiresAt, event.Notice, event.Password
					openOnce.Do(func() { close(opened) })
					continue
				}
			case "retrying":
				wordsMu.Lock()
				lastRetry = event.Message
				wordsMu.Unlock()
			case "stopped":
				wordsMu.Lock()
				words = event.Reason
				wordsMu.Unlock()
			case "error":
				wordsMu.Lock()
				words = event.Message
				wordsMu.Unlock()
			}
			if isOpen {
				select {
				case share.events <- event:
				default:
				}
			}
		}
		// Drain whatever is left so whk never blocks on a full pipe.
		_, _ = io.Copy(io.Discard, stdout)
		waitErr := cmd.Wait()

		wordsMu.Lock()
		said := words
		wordsMu.Unlock()
		if said == "" {
			said = cliProblem(bin, stderr.String())
		}
		if said == "" {
			said = strings.TrimSpace(stderr.String())
		}
		share.mu.Lock()
		switch {
		case share.stopping:
			share.reason = "you stopped it on this computer"
		case said != "":
			share.reason = said
		default:
			share.reason = fmt.Sprintf("whk share exited (%v)", exitWords(waitErr))
		}
		share.mu.Unlock()
		close(share.events)
		close(share.done)
	}()

	openTimeout := opts.OpenTimeout
	if openTimeout <= 0 {
		openTimeout = defaultShareOpenTimeout
	}
	timer := time.NewTimer(openTimeout)
	defer timer.Stop()

	select {
	case <-opened:
		// The share now lives as long as ctx does.
		go func() {
			select {
			case <-ctx.Done():
				_ = share.Stop(context.Background())
			case <-share.done:
			}
		}()
		return share, nil
	case <-share.done:
		reason := share.Reason()
		if reason == "" {
			reason = "whk share exited before the link was ready"
		}
		return nil, &ShareError{Message: reason}
	case <-ctx.Done():
		_ = share.Stop(context.Background())
		return nil, &ShareError{Message: "the share did not open before the context ended", Err: ctx.Err()}
	case <-timer.C:
		wordsMu.Lock()
		retry := lastRetry
		wordsMu.Unlock()
		_ = share.Stop(context.Background())
		message := fmt.Sprintf("the share did not open within %s", openTimeout)
		if retry != "" {
			message += ": " + retry
		}
		return nil, &ShareError{Message: message, Err: ErrTimeout}
	}
}

// shareEnv is the environment whk runs with: whose share it is is the key
// given, else the agent connection when asked, else what this process's
// environment holds, never a stray WHK_AUTH; the password only when given.
func shareEnv(base []string, opts ShareOptions) []string {
	inherited := ""
	env := make([]string, 0, len(base)+6)
	for _, kv := range base {
		key, value, _ := strings.Cut(kv, "=")
		switch key {
		case "WHK_SHARE_PASSWORD", "WHK_AUTH":
			continue
		case "WHK_API_KEY":
			inherited = value
			continue
		case "WHK_AGENT_FILE":
			if opts.AgentAuth && opts.AgentFile != "" {
				continue
			}
		case "WHK_API_URL":
			if opts.BaseURL != "" {
				continue
			}
		case "WHK_TUNNEL_URL":
			if opts.TunnelURL != "" {
				continue
			}
		}
		env = append(env, kv)
	}
	switch {
	case opts.APIKey != "":
		env = append(env, "WHK_API_KEY="+opts.APIKey)
	case opts.AgentAuth:
		env = append(env, "WHK_AUTH=agent")
		if opts.AgentFile != "" {
			env = append(env, "WHK_AGENT_FILE="+opts.AgentFile)
		}
	case inherited != "":
		env = append(env, "WHK_API_KEY="+inherited)
	}
	if opts.Password != "" {
		env = append(env, "WHK_SHARE_PASSWORD="+opts.Password)
	}
	if opts.BaseURL != "" {
		env = append(env, "WHK_API_URL="+strings.TrimRight(opts.BaseURL, "/"))
	}
	if opts.TunnelURL != "" {
		env = append(env, "WHK_TUNNEL_URL="+opts.TunnelURL)
	}
	return env
}

// installClause is the install instructions as the end of a sentence.
func installClause() string {
	if hint := WhkInstallHint(); hint != WhkInstallCommand {
		return hint + "."
	}
	return "run: " + WhkInstallCommand
}

// cliProblem is the words for a whk too old to share, or empty.
func cliProblem(bin, stderr string) string {
	lower := strings.ToLower(stderr)
	if strings.Contains(lower, "unrecognized subcommand") || strings.Contains(lower, "unexpected argument") {
		return fmt.Sprintf("sharing a port needs a newer whk than the one at %s. Update it with `whk update`; to install it again, %s", bin, installClause())
	}
	return ""
}

func exitWords(err error) string {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Sprintf("code %d", exit.ExitCode())
	}
	if err != nil {
		return err.Error()
	}
	return "code 0"
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		b.buf = append([]byte(nil), b.buf[len(b.buf)-b.max:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}
