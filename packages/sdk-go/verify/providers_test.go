package verify

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"

	"webhooks.cc/go/internal/conformance"
)

// A provider added to the TypeScript SDK must be ported here too.
func TestProvidersMatchTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(conformance.Dir(), "..", "src", "templates.ts"))
	if errors.Is(err, fs.ErrNotExist) && !conformance.Required() {
		t.Skipf("templates.ts not found (%v); run the tests from the webhooks-cc repository", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)export const VERIFY_PROVIDERS = \[(.*?)\]`).FindSubmatch(data)
	if block == nil {
		t.Fatal("templates.ts has no VERIFY_PROVIDERS")
	}
	var want []string
	for _, match := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(block[1], -1) {
		want = append(want, string(match[1]))
	}
	if got := Providers(); !slices.Equal(got, want) {
		t.Errorf("Providers() = %v\nVERIFY_PROVIDERS = %v", got, want)
	}
}
