// Package conformance loads the TypeScript SDK's conformance vectors for the
// tests. They live in packages/sdk/conformance, outside this module, so a copy
// of the module without the repository around it (a user's go test all)
// skips them. The repository's own CI sets WHK_CONFORMANCE_REQUIRED=1, which
// turns a missing file into a failure.
package conformance

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Dir is the directory holding the vectors.
func Dir() string {
	_, file, _, _ := runtime.Caller(0)
	// packages/sdk-go/internal/conformance -> packages/sdk/conformance
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "sdk", "conformance")
}

// Required reports whether missing vectors fail the tests instead of
// skipping them.
func Required() bool { return os.Getenv("WHK_CONFORMANCE_REQUIRED") == "1" }

// Load reads one vector file (such as "signing.json") into v.
func Load(t testing.TB, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(Dir(), name))
	if errors.Is(err, fs.ErrNotExist) && !Required() {
		t.Skipf("conformance vectors not found (%v); run the tests from the webhooks-cc repository", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}
