package webhookscc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// DefaultEmailDomain is the domain endpoints receive email on.
const DefaultEmailDomain = "mailhooks.cc"

const (
	maxLocalPart        = 64
	defaultEmailTimeout = time.Minute
	defaultEmailPoll    = time.Second
)

var (
	// Printable ASCII without the characters an unquoted local part cannot hold.
	emailTagPattern  = regexp.MustCompile(`^[!#-'*+\-./0-9=?A-Z^-~]+$`)
	emailSlugPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,50}$`)
)

// IsValidEmailTag reports whether tag can follow the plus sign in the address
// of the endpoint slug: printable ASCII without spaces, quotes, brackets, @,
// comma, semicolon or colon, and a local part (slug, +, tag) of at most 64
// characters. Pass an empty slug to check the tag alone.
func IsValidEmailTag(tag, slug string) bool {
	length := len(tag)
	if slug != "" {
		length += len(slug) + 1
	}
	return tag != "" && emailTagPattern.MatchString(tag) && length <= maxLocalPart
}

// FormatEmailAddress returns the address an endpoint receives email at:
// FormatEmailAddress("my-app", "run-42", "") is my-app+run-42@mailhooks.cc. Mail to
// a tagged address lands on the same endpoint and keeps its tag, so a test
// can find its own email. An empty tag gives the plain address and an empty
// domain the default one.
func FormatEmailAddress(slug, tag, domain string) (string, error) {
	if !emailSlugPattern.MatchString(slug) {
		return "", fmt.Errorf("webhooks.cc: invalid endpoint slug %q", slug)
	}
	if domain == "" {
		domain = DefaultEmailDomain
	}
	local := strings.ToLower(slug)
	if tag != "" {
		if !IsValidEmailTag(tag, slug) {
			return "", fmt.Errorf("webhooks.cc: invalid email tag %q: use printable ASCII without spaces, quotes, brackets, @ , ; or :, at most %d characters", tag, maxLocalPart-len(slug)-1)
		}
		local += "+" + tag
	}
	return local + "@" + domain, nil
}

// EmailsService reads and waits for email captured at {slug}@mailhooks.cc
// and {slug}+{tag}@mailhooks.cc. Use it as client.Emails.
//
// Use a fresh tag per test run to find your own email:
//
//	run := "signup-" + strconv.FormatInt(time.Now().UnixNano(), 36)
//	address, _ := client.Emails.Address(endpoint.Slug, run)
//	signUp(address)
//	email, err := client.Emails.WaitFor(ctx, endpoint.Slug, webhookscc.EmailQuery{Tag: run})
type EmailsService struct{ c *Client }

// Address returns the address the endpoint slug receives email at, with tag
// when it is not empty, on the client's email domain.
func (s *EmailsService) Address(slug, tag string) (string, error) {
	return FormatEmailAddress(slug, tag, s.c.emailDomain)
}

// AddressOf returns the address an endpoint receives email at, with tag when
// it is not empty, on the domain the server reported for it.
func (s *EmailsService) AddressOf(endpoint *Endpoint, tag string) (string, error) {
	at := strings.LastIndex(endpoint.EmailAddress, "@")
	if at <= 0 {
		return s.Address(endpoint.Slug, tag)
	}
	if tag == "" {
		return endpoint.EmailAddress, nil
	}
	local, domain := endpoint.EmailAddress[:at], endpoint.EmailAddress[at+1:]
	if !IsValidEmailTag(tag, local) {
		return "", fmt.Errorf("webhooks.cc: invalid email tag %q", tag)
	}
	return local + "+" + tag + "@" + domain, nil
}

// EmailQuery selects captured emails for Emails.List, Latest, WaitFor and
// WaitForAll. Every field is optional; the filters combine.
type EmailQuery struct {
	// Tag keeps mail sent to the address's +tag, exactly.
	Tag string
	// Untagged keeps only mail sent without a tag.
	Untagged bool
	// Subject keeps emails whose subject contains it (case-sensitive).
	Subject        string
	SubjectPattern *regexp.Regexp
	// From keeps emails from this address, in any case. FromPattern is
	// searched in "Name <address>".
	From        string
	FromPattern *regexp.Regexp
	// To keeps emails to this address in To or Cc, or delivered to it.
	To        string
	ToPattern *regexp.Regexp
	// Match adds a condition of your own.
	Match Matcher

	// Since keeps emails received after it. Waits look back five minutes by default.
	Since time.Time
	// Limit caps List (default 50).
	Limit int
	// Timeout (default 60 seconds) and PollInterval (default 1 second) apply to waits.
	Timeout      time.Duration
	PollInterval time.Duration
}

func (q EmailQuery) matcher() Matcher {
	criteria := MatchEmail(q)
	if q.Match == nil {
		return criteria
	}
	return MatchAll(criteria, q.Match)
}

// List returns the emails an endpoint captured, newest first.
func (s *EmailsService) List(ctx context.Context, slug string, q EmailQuery) ([]Request, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	requests, err := s.c.Requests.List(ctx, slug, ListOptions{Kind: KindEmail, Limit: limit, Since: q.Since})
	if err != nil {
		return nil, err
	}
	match := q.matcher()
	emails := requests[:0]
	for i := range requests {
		if match(&requests[i]) {
			emails = append(emails, requests[i])
		}
	}
	return emails, nil
}

// Get returns one captured email, or ErrNotFound for anything else.
func (s *EmailsService) Get(ctx context.Context, id string) (*Request, error) {
	request, err := s.c.Requests.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !IsEmailRequest(request) {
		return nil, &Error{StatusCode: http.StatusNotFound, Message: fmt.Sprintf("request %s is not a captured email", id)}
	}
	return request, nil
}

// Latest returns the newest email matching q, or nil when there is none.
func (s *EmailsService) Latest(ctx context.Context, slug string, q EmailQuery) (*Request, error) {
	q.Limit = 100
	emails, err := s.List(ctx, slug, q)
	if err != nil {
		return nil, err
	}
	var latest *Request
	for i := range emails {
		if latest == nil || emails[i].ReceivedAt.After(latest.ReceivedAt) {
			latest = &emails[i]
		}
	}
	return latest, nil
}

// WaitFor polls until an email matching q arrives (by default for 60 seconds).
func (s *EmailsService) WaitFor(ctx context.Context, slug string, q EmailQuery) (*Request, error) {
	emails, err := s.WaitForAll(ctx, slug, 1, q)
	if err != nil {
		return nil, err
	}
	return &emails[0], nil
}

// WaitForAll polls until count emails matching q have arrived and returns
// them oldest first.
func (s *EmailsService) WaitForAll(ctx context.Context, slug string, count int, q EmailQuery) ([]Request, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	limit := waitListLimit(count)
	return collect(ctx, func(ctx context.Context, since time.Time) ([]Request, error) {
		return s.c.Requests.List(ctx, slug, ListOptions{Since: since, Limit: limit, Kind: KindEmail})
	}, count, durationOr(q.Timeout, defaultEmailTimeout), durationOr(q.PollInterval, defaultEmailPoll), q.matcher(), q.Since)
}

// SendTest delivers a sample email, with a code and a link, to an endpoint.
// It is captured and counted like any other email, but does not travel over
// SMTP, so no sender checks run on it. tag may be empty.
func (s *EmailsService) SendTest(ctx context.Context, slug, tag string) (*SendTestEmailResult, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	body := map[string]any{"slug": slug}
	if tag != "" {
		if !IsValidEmailTag(tag, slug) {
			return nil, fmt.Errorf("webhooks.cc: invalid email tag %q", tag)
		}
		body["tag"] = tag
	}
	var raw json.RawMessage
	if err := s.c.api(ctx, http.MethodPost, "/send-test-email", nil, body, &raw); err != nil {
		return nil, err
	}
	var o rawObject
	_ = json.Unmarshal(raw, &o)
	return &SendTestEmailResult{Status: o.str("status"), RequestID: o.str("requestId"), Raw: raw}, nil
}

func extracts(email *Request) (*EmailExtracts, error) {
	if !email.IsEmail() {
		return nil, fmt.Errorf("webhooks.cc: request %s is not a captured email", email.ID)
	}
	if email.Extracts == nil {
		return nil, fmt.Errorf(`webhooks.cc: email %s has no codes or links attached: read emails through client.Emails (which asks the API for them), and keep the endpoint's "Show codes and links found in emails" setting on`, email.ID)
	}
	return email.Extracts, nil
}

// ExtractCode returns the first one-time code in an email (subject first), or
// "" when there is none. The codes are the ones the dashboard shows;
// webhooks.cc finds them and client.Emails returns them with each email. It
// fails for an email read without them (see Request.Extracts).
func ExtractCode(email *Request) (string, error) {
	found, err := extracts(email)
	if err != nil || len(found.Codes) == 0 {
		return "", err
	}
	return found.Codes[0], nil
}

// ExtractLink returns the link an email asks you to click (confirm, verify,
// reset, sign in) when it has one, otherwise the first link worth keeping, or
// "" when there is none. It fails like ExtractCode.
func ExtractLink(email *Request) (string, error) {
	found, err := extracts(email)
	if err != nil || len(found.Links) == 0 {
		return "", err
	}
	return found.Links[0].URL, nil
}

// ExtractActionLink is ExtractLink, but only a link the email asks you to
// click counts.
func ExtractActionLink(email *Request) (string, error) {
	found, err := extracts(email)
	if err != nil || len(found.Links) == 0 || !found.Links[0].Action {
		return "", err
	}
	return found.Links[0].URL, nil
}

// ForwardingService reads and rotates the signing secret of an endpoint's
// forwarding, for verifying what it delivers. Use it as client.Forwarding.
// It is the secret of the endpoint's primary destination;
// DestinationsService reads and rotates each destination's own.
type ForwardingService struct{ c *Client }

// Secret returns the endpoint's whsec_ signing secret. It returns ErrNotFound
// until a forwarding URL was saved.
func (s *ForwardingService) Secret(ctx context.Context, slug string) (string, error) {
	return s.secret(ctx, http.MethodGet, slug)
}

// RotateSecret replaces the signing secret. Every delivery from now on,
// retries included, uses the new one.
func (s *ForwardingService) RotateSecret(ctx context.Context, slug string) (string, error) {
	return s.secret(ctx, http.MethodPost, slug)
}

func (s *ForwardingService) secret(ctx context.Context, method, slug string) (string, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return "", err
	}
	var response struct {
		Secret string `json:"secret"`
	}
	if err := s.c.api(ctx, method, "/endpoints/"+slug+"/forwarding", nil, nil, &response); err != nil {
		return "", err
	}
	return response.Secret, nil
}
