// Package agentfile reads and writes the agent credential file that the MCP
// server, the TypeScript, Python and Go SDKs and the whk CLI share
// (packages/sdk/conformance/agent-credentials.md): the identity assertions
// of an agent's registrations, per webhooks.cc app, so a connection a human
// approved once survives restarts and works from every tool.
//
// The rules are pure functions of their inputs, which the conformance
// vectors drive; Store does the file I/O. Nothing here ever prints or
// returns the file's contents in an error.
package agentfile

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// The two slots an app's entry holds.
const (
	// Claimed is a registration a human connected to their account.
	Claimed = "claimed"
	// Sandbox is an unclaimed anonymous registration.
	Sandbox = "sandbox"
)

// Env names the file in full, overriding the default location.
const Env = "WHK_AGENT_FILE"

// TimeFormat is how slot times are written: RFC 3339 in UTC with
// milliseconds, as JavaScript's toISOString writes them.
const TimeFormat = "2006-01-02T15:04:05.000Z07:00"

const (
	formatVersion = 1
	// liveMargin: a slot or a cached token closer to expiry than this is gone.
	liveMargin = 60 * time.Second
)

var (
	slotNames = []string{Claimed, Sandbox}
	rfc3339   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$`)
)

// Slot is one registration in the file. Keys are snake_case, as every
// implementation writes them.
type Slot struct {
	RegistrationID    string `json:"registration_id"`
	IdentityAssertion string `json:"identity_assertion"`
	// AssertionExpires is RFC 3339.
	AssertionExpires string `json:"assertion_expires"`
	Scope            string `json:"scope,omitempty"`
	Email            string `json:"email,omitempty"`
	ClientName       string `json:"client_name,omitempty"`
	SavedAt          string `json:"saved_at,omitempty"`
	// AccessToken caches the last token exchanged from the assertion.
	AccessToken        string `json:"access_token,omitempty"`
	AccessTokenExpires string `json:"access_token_expires,omitempty"`
}

// Live reports whether the slot's assertion has more than a minute left.
func (s Slot) Live(now time.Time) bool {
	expires, ok := ParseTime(s.AssertionExpires)
	return ok && expires.Sub(now) > liveMargin
}

// UsableToken returns the cached access token when it is a webhooks.cc token
// with more than a minute left, else "".
func (s Slot) UsableToken(now time.Time) string {
	if !strings.HasPrefix(s.AccessToken, "whcc_") {
		return ""
	}
	if expires, ok := ParseTime(s.AccessTokenExpires); ok && expires.Sub(now) > liveMargin {
		return s.AccessToken
	}
	return ""
}

// Slots are the live slots of one app.
type Slots struct {
	Claimed *Slot
	Sandbox *Slot
}

// ParseTime reads an RFC 3339 timestamp with an uppercase T, seconds, an
// optional fraction and a Z or numeric offset, to the millisecond (as every
// implementation compares them). It must be a real date and time: no
// February 30, hour 24, leap second, or offset past 23:59. Anything else, a
// bare date included, is not a timestamp.
func ParseTime(value string) (time.Time, bool) {
	match := rfc3339.FindStringSubmatch(value)
	if match == nil {
		return time.Time{}, false
	}
	// time.Parse checks the date and the time of day, but takes any offset
	// of two digits each.
	if match[1] != "" && (match[1] > "23" || match[2] > "59") {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(t.UnixMilli()), true
}

// ResolvePath returns the file's path for a platform (runtime.GOOS or
// Node's process.platform names), a home directory ("" when there is none)
// and an environment; "" means there is no file. The default is the
// directory the CLI keeps token.json in (Rust's dirs::config_dir()), unless
// WHK_AGENT_FILE names a file.
func ResolvePath(platform, home string, getenv func(string) string) string {
	if override := getenv(Env); override != "" {
		return override
	}
	switch platform {
	case "windows", "win32":
		base := getenv("APPDATA")
		if base == "" && home != "" {
			base = joinPath(home, `\`, "AppData", "Roaming")
		}
		if base == "" {
			return ""
		}
		return joinPath(base, `\`, "whk", "agent.json")
	case "darwin":
		if home == "" {
			return ""
		}
		return joinPath(home, "/", "Library", "Application Support", "whk", "agent.json")
	}
	base := getenv("XDG_CONFIG_HOME")
	if !strings.HasPrefix(base, "/") {
		base = ""
		if home != "" {
			base = joinPath(home, "/", ".config")
		}
	}
	if base == "" {
		return ""
	}
	return joinPath(base, "/", "whk", "agent.json")
}

// joinPath joins parts onto base with separator, dropping the base's
// trailing separators (but never its first character).
func joinPath(base, separator string, parts ...string) string {
	end := len(base)
	for end > 1 && (base[end-1] == '/' || base[end-1] == '\\') {
		end--
	}
	return strings.Join(append([]string{base[:end]}, parts...), separator)
}

// DefaultPath is the file's path in this process ("" when there is none).
func DefaultPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return ResolvePath(runtime.GOOS, home, os.Getenv)
}

// NormalizeIssuer turns an app's base URL into its key in the file: trailing
// slashes removed, scheme and host lowercased, the path left as it is.
func NormalizeIssuer(baseURL string) string {
	url := strings.TrimRight(baseURL, "/")
	scheme := strings.Index(url, "://")
	if scheme < 0 {
		return url
	}
	pathStart := strings.Index(url[scheme+3:], "/")
	if pathStart < 0 {
		return strings.ToLower(url)
	}
	pathStart += scheme + 3
	return strings.ToLower(url[:pathStart]) + url[pathStart:]
}

// parseSlot returns the slot when it is well formed: an object with the
// three required fields as non-empty strings and a valid expiry. It says
// nothing about whether the slot is live.
func parseSlot(raw json.RawMessage) (*Slot, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, false
	}
	str := func(key string) (string, bool) {
		var value string
		if json.Unmarshal(fields[key], &value) != nil {
			return "", false
		}
		return value, true
	}
	slot := &Slot{}
	for key, target := range map[string]*string{
		"registration_id":    &slot.RegistrationID,
		"identity_assertion": &slot.IdentityAssertion,
		"assertion_expires":  &slot.AssertionExpires,
	} {
		value, ok := str(key)
		if !ok || value == "" {
			return nil, false
		}
		*target = value
	}
	if _, ok := ParseTime(slot.AssertionExpires); !ok {
		return nil, false
	}
	// Optional fields that are not strings are left out.
	for key, target := range map[string]*string{
		"scope":                &slot.Scope,
		"email":                &slot.Email,
		"client_name":          &slot.ClientName,
		"saved_at":             &slot.SavedAt,
		"access_token":         &slot.AccessToken,
		"access_token_expires": &slot.AccessTokenExpires,
	} {
		*target, _ = str(key)
	}
	return slot, true
}

// object decodes a JSON object, or reports that the value is not one.
func object(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, false
	}
	return value, true
}

// versionOne reports whether a top-level object says version 1 (a number:
// "1" is not, and null leaves version at 0).
func versionOne(root map[string]json.RawMessage) bool {
	var version float64
	return json.Unmarshal(root["version"], &version) == nil && version == formatVersion
}

// ReadSlots returns the live slots for an issuer in the file's contents
// (nil when there is no file). A broken file reads as empty.
func ReadSlots(data []byte, issuer string, now time.Time) Slots {
	root, ok := object(data)
	if !ok || !versionOne(root) {
		return Slots{}
	}
	issuers, ok := object(root["issuers"])
	if !ok {
		return Slots{}
	}
	entry, ok := object(issuers[NormalizeIssuer(issuer)])
	if !ok {
		return Slots{}
	}
	live := func(raw json.RawMessage) *Slot {
		if slot, ok := parseSlot(raw); ok && slot.Live(now) {
			return slot
		}
		return nil
	}
	return Slots{Claimed: live(entry[Claimed]), Sandbox: live(entry[Sandbox])}
}

// Op is one write: set a slot to Value, or remove it when Value is nil.
type Op struct {
	Slot  string
	Value json.RawMessage
}

// Outcome is what a write does to the file.
type Outcome int

const (
	// Write replaces the file with the new contents.
	Write Outcome = iota
	// Delete removes the file: no app has a slot left.
	Delete
	// Unchanged leaves the file alone: a newer format owns it.
	Unchanged
)

// ApplyWrite returns the file after a write, given its contents before (nil
// when there is none; contents that are not JSON read as none). Only the
// one slot changes; other apps and unknown keys stay, slots that are no
// longer live go, and so do apps left with nothing.
func ApplyWrite(before []byte, issuer string, op Op, now time.Time) ([]byte, Outcome) {
	root, isObject := object(before)
	if isObject {
		if _, has := root["version"]; has && !versionOne(root) {
			return nil, Unchanged
		}
	}
	if !isObject || !versionOne(root) {
		root = map[string]json.RawMessage{}
	}
	root["version"] = json.RawMessage("1")
	issuers, ok := object(root["issuers"])
	if !ok {
		issuers = map[string]json.RawMessage{}
	}

	key := NormalizeIssuer(issuer)
	entry, ok := object(issuers[key])
	if !ok {
		entry = map[string]json.RawMessage{}
	}
	if op.Value != nil {
		entry[op.Slot] = op.Value
	} else {
		delete(entry, op.Slot)
	}
	issuers[key] = mustMarshal(entry)

	for name, raw := range issuers {
		value, ok := object(raw)
		if !ok {
			delete(issuers, name)
			continue
		}
		for _, slotName := range slotNames {
			slotRaw, has := value[slotName]
			if !has {
				continue
			}
			if slot, ok := parseSlot(slotRaw); !ok || !slot.Live(now) {
				delete(value, slotName)
			}
		}
		if len(value) == 0 {
			delete(issuers, name)
			continue
		}
		issuers[name] = mustMarshal(value)
	}
	if len(issuers) == 0 {
		return nil, Delete
	}
	root["issuers"] = mustMarshal(issuers)
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(root); err != nil {
		// Every value came out of json.Unmarshal or mustMarshal.
		return nil, Unchanged
	}
	return out.Bytes(), Write
}

func mustMarshal(value map[string]json.RawMessage) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

// Store reads and writes the file at Path. A nil Store is no file: it reads
// as empty and never writes. Writes are best effort; the error they return
// never holds the file's contents, and callers carry on without it.
type Store struct {
	Path string
}

// Open returns the store for path, or for the default path when useDefault
// is set; nil when there is no file.
func Open(path string, useDefault bool) *Store {
	if useDefault {
		path = DefaultPath()
	}
	if path == "" {
		return nil
	}
	return &Store{Path: path}
}

// read returns the file's bytes, nil when it does not exist, and ok false
// when it exists but cannot be read now (permissions, a Windows sharing
// violation mid-rename): such a file must never be written over.
func (s *Store) read() (data []byte, ok bool) {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			return nil, true
		}
		return nil, false
	}
	return data, true
}

// Load returns the live slots for an issuer.
func (s *Store) Load(issuer string, now time.Time) Slots {
	if s == nil {
		return Slots{}
	}
	data, _ := s.read()
	return ReadSlots(data, issuer, now)
}

// Save sets a slot.
func (s *Store) Save(issuer, name string, slot Slot) error {
	return s.write(issuer, name, &slot, "")
}

// Update sets a slot only while the file still holds the same registration
// there, so a cached token never overwrites a registration another process
// saved since, nor brings back one it removed.
func (s *Store) Update(issuer, name string, slot Slot) error {
	return s.write(issuer, name, &slot, slot.RegistrationID)
}

// Remove drops a slot when it holds registrationID ("" drops whatever it holds).
func (s *Store) Remove(issuer, name, registrationID string) error {
	return s.write(issuer, name, nil, registrationID)
}

// write applies one change: it reads the file again right before writing,
// and skips the change when onlyIf is set and the slot does not hold that
// registration.
func (s *Store) write(issuer, name string, slot *Slot, onlyIf string) error {
	if s == nil {
		return nil
	}
	before, ok := s.read()
	if !ok {
		return errors.New("could not read the agent credential file at " + s.Path + "; left it as it is")
	}
	if onlyIf != "" && currentRegistration(before, issuer, name) != onlyIf {
		return nil
	}
	op := Op{Slot: name}
	if slot != nil {
		data, err := json.Marshal(slot)
		if err != nil {
			return err
		}
		op.Value = data
	}
	after, outcome := ApplyWrite(before, issuer, op, time.Now())
	switch outcome {
	case Unchanged:
		return nil
	case Delete:
		if err := os.Remove(s.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return errors.New("could not remove the agent credential file at " + s.Path)
		}
		return nil
	}
	if err := writeAtomic(s.Path, after); err != nil {
		return errors.New("could not write the agent credential file at " + s.Path)
	}
	return nil
}

// currentRegistration is the registration id a slot holds in the file, if any.
func currentRegistration(data []byte, issuer, name string) string {
	root, ok := object(data)
	if !ok || !versionOne(root) {
		return ""
	}
	issuers, ok := object(root["issuers"])
	if !ok {
		return ""
	}
	entry, ok := object(issuers[NormalizeIssuer(issuer)])
	if !ok {
		return ""
	}
	slot, ok := parseSlot(entry[name])
	if !ok {
		return ""
	}
	return slot.RegistrationID
}

// writeAtomic writes data to a new file in the same directory, created
// exclusively with mode 0600, flushes it, and renames it over path, so a
// reader never sees half a file. The directory is created with mode 0700.
func writeAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	temp := filepath.Join(dir, filepath.Base(path)+"."+hex.EncodeToString(suffix[:])+".tmp")
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(temp)
		}
	}()
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, path)
}
