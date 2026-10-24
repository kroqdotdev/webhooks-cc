package webhookscc

import (
	"regexp"
	"strconv"
	"strings"

	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/webtext"
)

// Matcher reports whether a captured request matches. Pass one to WaitFor and
// WaitForAll, combine them with MatchAll and MatchAny, or write your own.
type Matcher func(*Request) bool

// MatchMethod matches the HTTP method, in any case.
func MatchMethod(method string) Matcher {
	return func(r *Request) bool { return strings.EqualFold(r.Method, method) }
}

// MatchHeader matches a header (name in any case) whose value is exactly value.
func MatchHeader(name, value string) Matcher {
	return func(r *Request) bool {
		actual, ok := r.Headers.Lookup(name)
		return ok && actual == value
	}
}

// MatchHeaderPresent matches requests that carry the header, in any case.
func MatchHeaderPresent(name string) Matcher {
	return func(r *Request) bool {
		_, ok := r.Headers.Lookup(name)
		return ok
	}
}

// MatchPath matches the path against a glob: * within one segment, ** across
// segments.
func MatchPath(pattern string) Matcher {
	var source strings.Builder
	source.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch {
		case strings.HasPrefix(pattern[i:], "**"):
			source.WriteString(".*")
			i++
		case pattern[i] == '*':
			source.WriteString("[^/]*")
		default:
			source.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
		}
	}
	source.WriteString("$")
	compiled := regexp.MustCompile(source.String())
	return func(r *Request) bool { return compiled.MatchString(r.Path) }
}

// MatchQueryParam matches a query parameter whose value is exactly value.
func MatchQueryParam(key, value string) Matcher {
	return func(r *Request) bool {
		actual, ok := r.QueryParams[key]
		return ok && actual == value
	}
}

// MatchQueryParamPresent matches requests that carry the query parameter.
func MatchQueryParamPresent(key string) Matcher {
	return func(r *Request) bool {
		_, ok := r.QueryParams[key]
		return ok
	}
}

// MatchBodyPath matches a JSON body with value at a dot-separated path, where
// numeric segments index arrays:
//
//	webhookscc.MatchBodyPath("data.object.id", "obj_123")
//	webhookscc.MatchBodyPath("items.0.sku", "A")
//
// Only strings, numbers, booleans and nil match; values compare as JSON does,
// so 2000 matches 2000.0 but not "2000".
func MatchBodyPath(path string, value any) Matcher {
	keys := strings.Split(path, ".")
	expected, ok := normalizeJSON(value)
	return func(r *Request) bool {
		if !ok {
			return false
		}
		current, parsed := parseBody(r)
		if !parsed {
			return false
		}
		switch current.(type) {
		case jsonx.Object, []any:
		default:
			return false
		}
		for _, key := range keys {
			switch node := current.(type) {
			case []any:
				index, err := strconv.Atoi(key)
				if err != nil || !isASCIIDigits(key) || index >= len(node) {
					return false
				}
				current = node[index]
			case jsonx.Object:
				next, found := node.Get(key)
				if !found {
					return false
				}
				current = next
			default:
				return false
			}
		}
		return sameJSON(expected, current)
	}
}

// MatchBodySubset matches a JSON body that contains subset: objects may have
// more keys, and arrays match by position.
//
//	webhookscc.MatchBodySubset(map[string]any{"data": map[string]any{"status": "paid"}})
func MatchBodySubset(subset any) Matcher {
	expected, ok := normalizeJSON(subset)
	return func(r *Request) bool {
		actual, parsed := parseBody(r)
		return ok && parsed && isSubset(expected, actual)
	}
}

// MatchContentType matches the content type, ignoring parameters such as charset.
func MatchContentType(contentType string) Matcher {
	expected := strings.ToLower(webtext.JSTrim(contentType))
	return func(r *Request) bool {
		raw := r.ContentType
		if raw == "" {
			raw = r.Headers.Get("content-type")
		}
		if raw == "" {
			return false
		}
		normalized := strings.ToLower(webtext.JSTrim(raw))
		return normalized == expected || strings.HasPrefix(normalized, expected+";")
	}
}

// MatchAll matches when every matcher does.
func MatchAll(matchers ...Matcher) Matcher {
	return func(r *Request) bool {
		for _, match := range matchers {
			if !match(r) {
				return false
			}
		}
		return true
	}
}

// MatchAny matches when at least one matcher does.
func MatchAny(matchers ...Matcher) Matcher {
	return func(r *Request) bool {
		for _, match := range matchers {
			if match(r) {
				return true
			}
		}
		return false
	}
}

// MatchVerified matches requests whose signature webhooks.cc checked and found valid.
func MatchVerified() Matcher {
	return func(r *Request) bool { return r.SignatureVerified != nil && *r.SignatureVerified }
}

// MatchUnverified matches requests whose signature webhooks.cc checked and found invalid.
func MatchUnverified() Matcher {
	return func(r *Request) bool { return r.SignatureVerified != nil && !*r.SignatureVerified }
}

// IsEmailRequest reports whether a request is a captured email that carries
// its parsed message. Requests from Requests.Subscribe have none; read the
// whole email with Emails.Get(request.ID).
func IsEmailRequest(r *Request) bool { return r.IsEmail() && r.Email != nil }

// MatchEmail matches captured emails by the filters of q (Tag, Untagged,
// Subject, From, To and their patterns); its other fields are ignored.
func MatchEmail(q EmailQuery) Matcher {
	return func(r *Request) bool {
		if !IsEmailRequest(r) {
			return false
		}
		email := r.Email
		if q.Untagged && email.Tag != "" {
			return false
		}
		if q.Tag != "" && email.Tag != q.Tag {
			return false
		}
		if q.Subject != "" && !strings.Contains(email.Subject, q.Subject) {
			return false
		}
		if q.SubjectPattern != nil && !q.SubjectPattern.MatchString(email.Subject) {
			return false
		}
		if !matchesAddress(email.From, q.From, q.FromPattern) {
			return false
		}
		recipients := append(append(append([]EmailAddress{}, email.To...), email.Cc...), EmailAddress{Address: r.Path})
		return matchesAddress(recipients, q.To, q.ToPattern)
	}
}

func matchesAddress(addresses []EmailAddress, address string, pattern *regexp.Regexp) bool {
	if address != "" {
		found := false
		for _, entry := range addresses {
			if strings.EqualFold(entry.Address, address) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if pattern != nil {
		for _, entry := range addresses {
			if pattern.MatchString(entry.String()) {
				return true
			}
		}
		return false
	}
	return true
}

func parseBody(r *Request) (any, bool) {
	if r.Body == "" {
		return nil, false
	}
	value, err := jsonx.Parse([]byte(r.Body))
	return value, err == nil
}

// normalizeJSON turns a Go value into what jsonx.Parse would give for its
// JSON, so expected values compare like parsed bodies.
func normalizeJSON(value any) (any, bool) {
	text, err := jsonx.Stringify(value)
	if err != nil {
		return nil, false
	}
	normalized, err := jsonx.Parse([]byte(text))
	return normalized, err == nil
}

// sameJSON compares JSON primitives like JavaScript's Object.is; objects and
// arrays never match.
func sameJSON(expected, actual any) bool {
	switch expected := expected.(type) {
	case nil:
		return actual == nil
	case bool:
		value, ok := actual.(bool)
		return ok && value == expected
	case float64:
		value, ok := actual.(float64)
		return ok && value == expected
	case string:
		value, ok := actual.(string)
		return ok && value == expected
	}
	return false
}

func isSubset(expected, actual any) bool {
	switch expected := expected.(type) {
	case []any:
		items, ok := actual.([]any)
		if !ok || len(expected) > len(items) {
			return false
		}
		for i, value := range expected {
			if !isSubset(value, items[i]) {
				return false
			}
		}
		return true
	case jsonx.Object:
		object, ok := actual.(jsonx.Object)
		if !ok {
			return false
		}
		for _, member := range expected {
			value, found := object.Get(member.Key)
			if !found || !isSubset(member.Value, value) {
				return false
			}
		}
		return true
	}
	return sameJSON(expected, actual)
}

func isASCIIDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}
