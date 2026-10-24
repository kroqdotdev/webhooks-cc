package webhookscc_test

import (
	"encoding/json"
	"testing"

	webhookscc "webhooks.cc/go"
	"webhooks.cc/go/internal/conformance"
)

type matcherSpec struct {
	Fn   string            `json:"fn"`
	Args []json.RawMessage `json:"args"`
}

func buildMatcher(t *testing.T, spec matcherSpec) webhookscc.Matcher {
	t.Helper()
	str := func(i int) string {
		var value string
		if err := json.Unmarshal(spec.Args[i], &value); err != nil {
			t.Fatalf("%s arg %d: %v", spec.Fn, i, err)
		}
		return value
	}
	value := func(i int) any {
		var v any
		if err := json.Unmarshal(spec.Args[i], &v); err != nil {
			t.Fatalf("%s arg %d: %v", spec.Fn, i, err)
		}
		return v
	}
	nested := func() []webhookscc.Matcher {
		var matchers []webhookscc.Matcher
		for _, arg := range spec.Args {
			var inner matcherSpec
			if err := json.Unmarshal(arg, &inner); err != nil {
				t.Fatal(err)
			}
			matchers = append(matchers, buildMatcher(t, inner))
		}
		return matchers
	}
	switch spec.Fn {
	case "matchMethod":
		return webhookscc.MatchMethod(str(0))
	case "matchHeader":
		if len(spec.Args) == 1 {
			return webhookscc.MatchHeaderPresent(str(0))
		}
		return webhookscc.MatchHeader(str(0), str(1))
	case "matchPath":
		return webhookscc.MatchPath(str(0))
	case "matchQueryParam":
		if len(spec.Args) == 1 {
			return webhookscc.MatchQueryParamPresent(str(0))
		}
		return webhookscc.MatchQueryParam(str(0), str(1))
	case "matchBodyPath":
		return webhookscc.MatchBodyPath(str(0), value(1))
	case "matchBodySubset":
		return webhookscc.MatchBodySubset(value(0))
	case "matchContentType":
		return webhookscc.MatchContentType(str(0))
	case "matchVerified":
		return webhookscc.MatchVerified()
	case "matchUnverified":
		return webhookscc.MatchUnverified()
	case "matchAll":
		return webhookscc.MatchAll(nested()...)
	case "matchAny":
		return webhookscc.MatchAny(nested()...)
	case "isEmailRequest":
		return webhookscc.IsEmailRequest
	case "matchEmail":
		var criteria map[string]*string
		if err := json.Unmarshal(spec.Args[0], &criteria); err != nil {
			t.Fatal(err)
		}
		var query webhookscc.EmailQuery
		for key, value := range criteria {
			switch key {
			case "tag":
				if value == nil {
					query.Untagged = true
				} else {
					query.Tag = *value
				}
			case "subject":
				query.Subject = *value
			case "from":
				query.From = *value
			case "to":
				query.To = *value
			default:
				t.Fatalf("matchEmail: unknown criterion %q", key)
			}
		}
		return webhookscc.MatchEmail(query)
	}
	t.Fatalf("unknown matcher %q", spec.Fn)
	return nil
}

func TestMatchersConformance(t *testing.T) {
	var file struct {
		Version  int                        `json:"version"`
		Requests map[string]json.RawMessage `json:"requests"`
		Vectors  []struct {
			Name     string      `json:"name"`
			Request  string      `json:"request"`
			Matcher  matcherSpec `json:"matcher"`
			Expected bool        `json:"expected"`
		} `json:"vectors"`
	}
	conformance.Load(t, "matchers.json", &file)
	if file.Version != 1 {
		t.Fatalf("matchers.json version %d; this test reads version 1", file.Version)
	}
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, vector := range file.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			var request webhookscc.Request
			if err := json.Unmarshal(file.Requests[vector.Request], &request); err != nil {
				t.Fatal(err)
			}
			if got := buildMatcher(t, vector.Matcher)(&request); got != vector.Expected {
				t.Errorf("got %v, want %v", got, vector.Expected)
			}
		})
	}
}

// Beyond the vectors: globs cross line breaks, ? takes a whole character, and
// a pattern that is not valid UTF-8 does not panic.
func TestMatchPathGlobs(t *testing.T) {
	request := &webhookscc.Request{Path: "/a/b\nc/é"}
	for pattern, want := range map[string]bool{
		"/a/**":       true,
		"/a/*/?":      true,
		"/a/b?c/é":    true,
		"/a/**/c/é":   true,
		"/a/b":        false,
		"/a/*":        false,
		"/a/b\xffc/é": false,
	} {
		if got := webhookscc.MatchPath(pattern)(request); got != want {
			t.Errorf("MatchPath(%q) = %v, want %v", pattern, got, want)
		}
	}
}
