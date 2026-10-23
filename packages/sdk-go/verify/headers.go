package verify

import (
	"net/http"
	"strings"
)

// Headers is a request's headers: http.Header, Map, or anything else with a
// Get method. Names match in any case.
type Headers interface {
	Get(name string) string
}

// Map adapts a map of header names to values, such as the headers of a
// captured request, to Headers. Get matches names in any case.
type Map map[string]string

// Get returns the value of the header name, matched in any case, or "".
func (m Map) Get(name string) string {
	if value, ok := m[name]; ok {
		return value
	}
	for key, value := range m {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

// header reads one header. Repeated headers in an http.Header are joined with
// ", ", as Node.js joins them, and a key that is not in canonical form is
// still found.
func header(headers Headers, name string) string {
	switch h := headers.(type) {
	case nil:
		return ""
	case http.Header:
		values := h.Values(name)
		if len(values) == 0 {
			for key, list := range h {
				if strings.EqualFold(key, name) {
					values = list
					break
				}
			}
		}
		return strings.Join(values, ", ")
	default:
		return headers.Get(name)
	}
}

// svixHeaders lets the svix-* headers Clerk and Resend send stand in for the
// webhook-* headers of Standard Webhooks.
type svixHeaders struct{ Headers }

func (h svixHeaders) Get(name string) string {
	if value := header(h.Headers, name); value != "" {
		return value
	}
	if rest, ok := strings.CutPrefix(strings.ToLower(name), "webhook-"); ok {
		return header(h.Headers, "svix-"+rest)
	}
	return ""
}
