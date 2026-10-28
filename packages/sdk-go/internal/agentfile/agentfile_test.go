package agentfile

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"webhooks.cc/go/internal/conformance"
)

type vectors struct {
	Paths []struct {
		Name     string            `json:"name"`
		Platform string            `json:"platform"`
		Home     *string           `json:"home"`
		Env      map[string]string `json:"env"`
		Expected *string           `json:"expected"`
	} `json:"paths"`
	Issuers []struct {
		Input    string `json:"input"`
		Expected string `json:"expected"`
	} `json:"issuers"`
	Reads []struct {
		Name     string          `json:"name"`
		Now      string          `json:"now"`
		Issuer   string          `json:"issuer"`
		File     json.RawMessage `json:"file"`
		FileText *string         `json:"fileText"`
		Expected struct {
			Claimed      bool `json:"claimed"`
			Sandbox      bool `json:"sandbox"`
			ClaimedToken bool `json:"claimedToken"`
			SandboxToken bool `json:"sandboxToken"`
		} `json:"expected"`
	} `json:"reads"`
	Writes []struct {
		Name   string          `json:"name"`
		Now    string          `json:"now"`
		Issuer string          `json:"issuer"`
		Before json.RawMessage `json:"before"`
		Op     struct {
			Set    string          `json:"set"`
			Slot   json.RawMessage `json:"slot"`
			Remove string          `json:"remove"`
		} `json:"op"`
		Expected json.RawMessage `json:"expected"`
	} `json:"writes"`
}

func load(t *testing.T) vectors {
	t.Helper()
	var v vectors
	conformance.Load(t, "agent-credentials.json", &v)
	if len(v.Paths) == 0 || len(v.Issuers) == 0 || len(v.Reads) == 0 || len(v.Writes) == 0 {
		t.Fatal("agent-credentials.json has an empty section")
	}
	return v
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, ok := ParseTime(value)
	if !ok {
		t.Fatalf("bad time %q in the vectors", value)
	}
	return parsed
}

// isNull reports whether a vector field is absent or JSON null.
func isNull(raw json.RawMessage) bool {
	return len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func TestConformancePaths(t *testing.T) {
	for _, c := range load(t).Paths {
		home := ""
		if c.Home != nil {
			home = *c.Home
		}
		got := ResolvePath(c.Platform, home, func(name string) string { return c.Env[name] })
		want := ""
		if c.Expected != nil {
			want = *c.Expected
		}
		if strings.ReplaceAll(got, `\`, "/") != strings.ReplaceAll(want, `\`, "/") {
			t.Errorf("%s: path = %q, want %q", c.Name, got, want)
		}
	}
}

func TestConformanceIssuers(t *testing.T) {
	for _, c := range load(t).Issuers {
		if got := NormalizeIssuer(c.Input); got != c.Expected {
			t.Errorf("NormalizeIssuer(%q) = %q, want %q", c.Input, got, c.Expected)
		}
	}
}

func TestConformanceReads(t *testing.T) {
	for _, c := range load(t).Reads {
		var data []byte
		switch {
		case c.FileText != nil:
			data = []byte(*c.FileText)
		case len(c.File) > 0:
			data = c.File
		}
		now := mustTime(t, c.Now)
		slots := ReadSlots(data, c.Issuer, now)
		got := [4]bool{
			slots.Claimed != nil,
			slots.Sandbox != nil,
			slots.Claimed != nil && slots.Claimed.UsableToken(now) != "",
			slots.Sandbox != nil && slots.Sandbox.UsableToken(now) != "",
		}
		want := [4]bool{c.Expected.Claimed, c.Expected.Sandbox, c.Expected.ClaimedToken, c.Expected.SandboxToken}
		if got != want {
			t.Errorf("%s: claimed, sandbox, claimedToken, sandboxToken = %v, want %v", c.Name, got, want)
		}
	}
}

func TestConformanceWrites(t *testing.T) {
	for _, c := range load(t).Writes {
		var before []byte
		if !isNull(c.Before) {
			before = c.Before
		}
		op := Op{Slot: c.Op.Remove}
		if c.Op.Set != "" {
			op = Op{Slot: c.Op.Set, Value: c.Op.Slot}
		}
		after, outcome := ApplyWrite(before, c.Issuer, op, mustTime(t, c.Now))

		var expected any
		if err := json.Unmarshal(c.Expected, &expected); err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		switch {
		case expected == nil:
			if outcome != Delete {
				t.Errorf("%s: outcome %d, want the file deleted", c.Name, outcome)
			}
		case expected == "unchanged":
			if outcome != Unchanged {
				t.Errorf("%s: outcome %d, want unchanged", c.Name, outcome)
			}
		default:
			if outcome != Write {
				t.Errorf("%s: outcome %d, want a write", c.Name, outcome)
				continue
			}
			var got any
			if err := json.Unmarshal(after, &got); err != nil {
				t.Fatalf("%s: wrote invalid JSON: %v", c.Name, err)
			}
			if !reflect.DeepEqual(got, expected) {
				t.Errorf("%s:\n got %s\nwant %s", c.Name, after, c.Expected)
			}
		}
	}
}

func TestParseTime(t *testing.T) {
	for _, value := range []string{"2026-10-29T11:00:00Z", "2026-10-29T11:00:00.1Z", "2026-10-29T13:00:00+02:00", "2026-10-29T11:00:00.123456789-05:30", "2028-02-29T00:00:00Z", "2026-10-29T11:00:00+23:59"} {
		if _, ok := ParseTime(value); !ok {
			t.Errorf("ParseTime(%q) refused", value)
		}
	}
	for _, value := range []string{
		"", "2026-10-29", "2026-10-29 11:00:00Z", "2026-10-29T11:00Z", "2026-10-29T11:00:00", "2026-10-29T11:00:00+0200", "tomorrow",
		"2026-10-29t11:00:00z", "2026-02-29T11:00:00Z", "2026-10-29T24:00:00Z", "2026-10-29T11:60:00Z", "2026-10-29T11:00:60Z",
		"2026-13-01T11:00:00Z", "2026-10-29T11:00:00+24:00", "2026-10-29T11:00:00-23:60",
	} {
		if _, ok := ParseTime(value); ok {
			t.Errorf("ParseTime(%q) accepted", value)
		}
	}
	if got, _ := ParseTime("2026-10-29T11:00:00.123999Z"); got.Nanosecond() != 123_000_000 {
		t.Errorf("fraction = %d ns, want milliseconds only", got.Nanosecond())
	}
}

func slotFor(id string, expires time.Time) Slot {
	return Slot{
		RegistrationID:    id,
		IdentityAssertion: "eyJ.assertion." + id,
		AssertionExpires:  expires.UTC().Format(TimeFormat),
		ClientName:        "test",
	}
}

func TestStoreWritesPrivatelyAndAtomically(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "whk", "agent.json")
	store := &Store{Path: path}
	issuer := "http://localhost:3000"
	if err := store.Save(issuer, Sandbox, slotFor("one", time.Now().Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("file mode = %o, want 600", mode)
		}
		dir, err := os.Stat(filepath.Dir(path))
		if err != nil {
			t.Fatal(err)
		}
		if mode := dir.Mode().Perm(); mode != 0o700 {
			t.Errorf("directory mode = %o, want 700", mode)
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("directory holds %d files, want only agent.json (no temporary files left)", len(entries))
	}
	if slots := store.Load(issuer+"/", time.Now()); slots.Sandbox == nil || slots.Sandbox.RegistrationID != "one" {
		t.Fatalf("Load = %+v", slots)
	}

	// Update only touches the registration it was given.
	updated := slotFor("one", time.Now().Add(time.Hour))
	updated.AccessToken = "whcc_cached"
	updated.AccessTokenExpires = time.Now().Add(time.Hour).UTC().Format(TimeFormat)
	if err := store.Update(issuer, Sandbox, updated); err != nil {
		t.Fatal(err)
	}
	if got := store.Load(issuer, time.Now()).Sandbox.UsableToken(time.Now()); got != "whcc_cached" {
		t.Errorf("cached token = %q", got)
	}
	if err := store.Update(issuer, Sandbox, slotFor("two", time.Now().Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err := store.Update(issuer, Claimed, slotFor("three", time.Now().Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	slots := store.Load(issuer, time.Now())
	if slots.Sandbox.RegistrationID != "one" || slots.Claimed != nil {
		t.Errorf("Update wrote over another registration: %+v", slots)
	}

	// Remove with another registration leaves the slot; with its own, the
	// file goes once nothing is left.
	if err := store.Remove(issuer, Sandbox, "two"); err != nil {
		t.Fatal(err)
	}
	if store.Load(issuer, time.Now()).Sandbox == nil {
		t.Error("Remove dropped another registration's slot")
	}
	if err := store.Remove(issuer, Sandbox, "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the file is still there after its last slot went: %v", err)
	}
}

func TestStoreLeavesANewerVersionAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	newer := []byte(`{"version":2,"issuers":{"https://webhooks.cc":{"claimed":{"anything":true}}}}`)
	if err := os.WriteFile(path, newer, 0o600); err != nil {
		t.Fatal(err)
	}
	store := &Store{Path: path}
	if err := store.Save("https://webhooks.cc", Sandbox, slotFor("one", time.Now().Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); !bytes.Equal(data, newer) {
		t.Errorf("a version 2 file was rewritten: %s", data)
	}
	if slots := store.Load("https://webhooks.cc", time.Now()); slots.Sandbox != nil || slots.Claimed != nil {
		t.Errorf("a version 2 file read as %+v", slots)
	}
}

func TestStoreReportsFailuresWithoutContents(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a directory the user cannot write")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	store := &Store{Path: filepath.Join(dir, "agent.json")}
	slot := slotFor("secret-registration", time.Now().Add(time.Hour))
	err := store.Save("https://webhooks.cc", Sandbox, slot)
	if err == nil {
		t.Fatal("writing into a read-only directory succeeded")
	}
	if strings.Contains(err.Error(), slot.IdentityAssertion) || strings.Contains(err.Error(), slot.RegistrationID) {
		t.Errorf("the error holds the slot: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("a failed write left %d files behind", len(entries))
	}
}

func TestNilStoreIsNoFile(t *testing.T) {
	var store *Store
	if slots := store.Load("https://webhooks.cc", time.Now()); slots.Claimed != nil || slots.Sandbox != nil {
		t.Error("a nil store read slots")
	}
	if err := store.Save("https://webhooks.cc", Claimed, slotFor("x", time.Now().Add(time.Hour))); err != nil {
		t.Error(err)
	}
	if Open("", false) != nil {
		t.Error("Open with no path returned a store")
	}
}
