package webhookscc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	waitLookback       = 5 * time.Minute
	minPollInterval    = 10 * time.Millisecond
	maxPollInterval    = time.Minute
	maxWaitIterations  = 10_000
	defaultWaitTimeout = 30 * time.Second
	defaultWaitPoll    = 500 * time.Millisecond
	// pollOverlap is how far before the newest request a wait's next poll starts.
	pollOverlap = 5 * time.Second
)

// Not replayed: hop-by-hop headers, credentials, and headers our proxies added.
var replaySkippedHeaders = map[string]bool{
	"host": true, "connection": true, "content-length": true, "transfer-encoding": true,
	"keep-alive": true, "te": true, "trailer": true, "upgrade": true,
	"authorization": true, "cookie": true, "proxy-authorization": true, "set-cookie": true,
	"cdn-loop": true, "cf-connecting-ip": true, "cf-ipcountry": true, "cf-ray": true,
	"cf-visitor": true, "via": true, "x-forwarded-for": true, "x-forwarded-host": true,
	"x-forwarded-proto": true, "x-real-ip": true, "true-client-ip": true,
}

// RequestsService lists, waits for, streams, replays and deletes captured
// requests. Use it as client.Requests.
type RequestsService struct{ c *Client }

// ListOptions narrow Requests.List. All are optional.
type ListOptions struct {
	Limit int
	// Since keeps requests received after this time.
	Since time.Time
	Kind  RequestKind
}

// List returns the requests an endpoint captured, newest first.
func (s *RequestsService) List(ctx context.Context, slug string, opts ListOptions) ([]Request, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	query := url.Values{"extracts": {"true"}}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if !opts.Since.IsZero() {
		query.Set("since", strconv.FormatInt(opts.Since.UnixMilli(), 10))
	}
	if opts.Kind != "" {
		query.Set("kind", string(opts.Kind))
	}
	var requests []Request
	if err := s.c.api(ctx, http.MethodGet, "/endpoints/"+slug+"/requests", query, nil, &requests); err != nil {
		return nil, err
	}
	return requests, nil
}

// PageOptions select a page for Requests.ListPage.
type PageOptions struct {
	Limit int
	// Cursor is the previous page's Cursor; empty for the first page.
	Cursor string
	Kind   RequestKind
}

// ListPage returns one page of captured requests, newest first.
func (s *RequestsService) ListPage(ctx context.Context, slug string, opts PageOptions) (*RequestPage, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	query := url.Values{"extracts": {"true"}}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Cursor != "" {
		query.Set("cursor", opts.Cursor)
	}
	if opts.Kind != "" {
		query.Set("kind", string(opts.Kind))
	}
	var page struct {
		Items   []Request `json:"items"`
		Cursor  *string   `json:"cursor"`
		HasMore bool      `json:"hasMore"`
	}
	if err := s.c.api(ctx, http.MethodGet, "/endpoints/"+slug+"/requests/paginated", query, nil, &page); err != nil {
		return nil, err
	}
	result := &RequestPage{Items: page.Items, HasMore: page.HasMore}
	if page.Cursor != nil {
		result.Cursor = *page.Cursor
	}
	return result, nil
}

// Get returns one captured request.
func (s *RequestsService) Get(ctx context.Context, id string) (*Request, error) {
	if err := validateSegment(id, "request id"); err != nil {
		return nil, err
	}
	var request Request
	if err := s.c.api(ctx, http.MethodGet, "/requests/"+id, url.Values{"extracts": {"true"}}, nil, &request); err != nil {
		return nil, err
	}
	return &request, nil
}

// WaitOptions control Requests.WaitFor and WaitForAll.
type WaitOptions struct {
	// Timeout defaults to 30 seconds.
	Timeout time.Duration
	// PollInterval defaults to 500 milliseconds.
	PollInterval time.Duration
	// Match keeps only matching requests.
	Match Matcher
	// Since is where the wait looks back to; by default five minutes before it
	// starts, so a request that arrived just before still counts.
	Since time.Time
}

// WaitFor polls until a request (matching opts.Match, if set) arrives. When
// time runs out it returns a TimeoutError.
func (s *RequestsService) WaitFor(ctx context.Context, slug string, opts WaitOptions) (*Request, error) {
	requests, err := s.WaitForAll(ctx, slug, 1, opts)
	if err != nil {
		return nil, err
	}
	return &requests[0], nil
}

// WaitForAll polls until count matching requests have arrived and returns
// them oldest first.
func (s *RequestsService) WaitForAll(ctx context.Context, slug string, count int, opts WaitOptions) ([]Request, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	limit := waitListLimit(count)
	return collect(ctx, func(ctx context.Context, since time.Time) ([]Request, error) {
		return s.List(ctx, slug, ListOptions{Since: since, Limit: limit})
	}, count, durationOr(opts.Timeout, defaultWaitTimeout), durationOr(opts.PollInterval, defaultWaitPoll), opts.Match, opts.Since)
}

func durationOr(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

// waitListLimit is the page size a wait polls with: twice the count, between 100 and 1000.
func waitListLimit(count int) int {
	return min(1000, max(100, max(1, count)*2))
}

func collect(
	ctx context.Context,
	fetch func(context.Context, time.Time) ([]Request, error),
	count int,
	timeout, pollInterval time.Duration,
	match Matcher,
	since time.Time,
) ([]Request, error) {
	poll := min(maxPollInterval, max(minPollInterval, pollInterval))
	wanted := max(1, count)
	start := time.Now()
	lastChecked := since
	if lastChecked.IsZero() {
		lastChecked = start.Add(-waitLookback)
	}
	var collected []Request
	seen := map[string]bool{}

	for iterations := 0; time.Since(start) < timeout && iterations < maxWaitIterations; iterations++ {
		requests, err := fetch(ctx, lastChecked)
		switch {
		case err == nil:
			// The next poll starts a little before the newest request seen, on
			// the server's clock. A boundary taken from the local clock would
			// skip whatever arrives in the gap when this machine's clock runs
			// ahead of the server's; the overlap also catches a capture that
			// committed after a newer one. Repeats are skipped by id.
			for _, request := range requests {
				if boundary := request.ReceivedAt.Add(-pollOverlap); boundary.After(lastChecked) {
					lastChecked = boundary
				}
			}
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case errors.Is(err, ErrUnauthorized), errors.Is(err, ErrNotFound):
			return nil, err
		case errors.Is(err, ErrRateLimited):
			// Try again at the next poll.
		default:
			var apiErr *Error
			if errors.As(err, &apiErr) && apiErr.StatusCode < 500 {
				return nil, err
			}
			var timeoutErr *TimeoutError
			if errors.As(err, &timeoutErr) {
				return nil, err
			}
			// A network blip or a server error: try again at the next poll.
		}
		slices.SortStableFunc(requests, func(a, b Request) int { return a.ReceivedAt.Compare(b.ReceivedAt) })
		for _, request := range requests {
			if seen[request.ID] {
				continue
			}
			seen[request.ID] = true
			if match != nil && !match(&request) {
				continue
			}
			collected = append(collected, request)
			if len(collected) >= wanted {
				return collected[:wanted], nil
			}
		}
		remaining := timeout - time.Since(start)
		if err := sleep(ctx, min(poll, max(0, remaining))); err != nil {
			return nil, err
		}
	}
	return nil, &TimeoutError{After: timeout}
}

// SearchOptions narrow Requests.Search and Count. All are optional.
type SearchOptions struct {
	Slug   string
	Method string
	Kind   RequestKind
	// Query is searched for in the path, body and headers.
	Query string
	From  time.Time
	To    time.Time
	// Limit, Offset and Order ("asc" or "desc") apply to Search only.
	Limit  int
	Offset int
	Order  string
}

func (o SearchOptions) values() (url.Values, error) {
	query := url.Values{}
	if o.Slug != "" {
		if err := validateSegment(o.Slug, "slug"); err != nil {
			return nil, err
		}
		query.Set("slug", o.Slug)
	}
	if o.Method != "" {
		query.Set("method", o.Method)
	}
	if o.Kind != "" {
		query.Set("kind", string(o.Kind))
	}
	if o.Query != "" {
		query.Set("q", o.Query)
	}
	if !o.From.IsZero() {
		query.Set("from", strconv.FormatInt(o.From.UnixMilli(), 10))
	}
	if !o.To.IsZero() {
		query.Set("to", strconv.FormatInt(o.To.UnixMilli(), 10))
	}
	return query, nil
}

// Search searches retained requests across path, body and headers.
func (s *RequestsService) Search(ctx context.Context, opts SearchOptions) ([]Request, error) {
	query, err := opts.values()
	if err != nil {
		return nil, err
	}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 {
		query.Set("offset", strconv.Itoa(opts.Offset))
	}
	if opts.Order != "" {
		query.Set("order", opts.Order)
	}
	var requests []Request
	if err := s.c.api(ctx, http.MethodGet, "/search/requests", query, nil, &requests); err != nil {
		return nil, err
	}
	return requests, nil
}

// Count returns how many retained requests match the search.
func (s *RequestsService) Count(ctx context.Context, opts SearchOptions) (int, error) {
	query, err := opts.values()
	if err != nil {
		return 0, err
	}
	var response struct {
		Count int `json:"count"`
	}
	if err := s.c.api(ctx, http.MethodGet, "/search/requests/count", query, nil, &response); err != nil {
		return 0, err
	}
	return response.Count, nil
}

// ClearOptions narrow Requests.Clear.
type ClearOptions struct {
	// Before keeps requests received at or after this time; zero deletes all.
	Before time.Time
}

// Clear deletes an endpoint's requests.
func (s *RequestsService) Clear(ctx context.Context, slug string, opts ClearOptions) error {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return err
	}
	query := url.Values{}
	if !opts.Before.IsZero() {
		query.Set("before", strconv.FormatInt(opts.Before.UnixMilli(), 10))
	}
	return s.c.api(ctx, http.MethodDelete, "/endpoints/"+slug+"/requests", query, nil, nil)
}

// Replay sends a captured request again, to any URL, with its method, headers
// and exact body. Hop-by-hop headers, credentials and headers added by
// proxies are left out, and redirects are not followed.
func (s *RequestsService) Replay(ctx context.Context, id, targetURL string) (*Response, error) {
	if err := validateSegment(id, "request id"); err != nil {
		return nil, err
	}
	if err := validateURL(targetURL, "target URL"); err != nil {
		return nil, err
	}
	captured, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if captured.IsEmail() {
		return nil, fmt.Errorf("webhooks.cc: request %s is a captured email, which cannot be replayed as an HTTP request; turn on forwarding to deliver emails to a URL", id)
	}
	headers := map[string]string{}
	for name, value := range captured.Headers {
		if !replaySkippedHeaders[strings.ToLower(name)] {
			headers[name] = value
		}
	}
	var body []byte
	if method := strings.ToUpper(captured.Method); method != http.MethodGet && method != http.MethodHead {
		body = captured.BodyBytes()
	}
	return s.c.send(ctx, captured.Method, targetURL, headers, body)
}
