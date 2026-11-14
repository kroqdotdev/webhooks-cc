package webhookscc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	waitLookback       = 5 * time.Minute
	minPollInterval    = 10 * time.Millisecond
	maxPollInterval    = time.Minute
	maxWaitIterations  = 10_000
	defaultWaitTimeout = 30 * time.Second
	defaultWaitPoll    = 500 * time.Millisecond
	// pollOverlap is how far before the newest request a wait's next poll
	// starts. The receiver stamps receivedAt before the capture commits, and a
	// capture can wait its turn behind others for the same account.
	pollOverlap = 30 * time.Second
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

// RequestsService lists, waits for, streams, replays, downloads and deletes
// captured requests. Use it as client.Requests.
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

// AttachmentDownload is an attachment of a stored email, downloaded with
// RequestsService.Attachment.
type AttachmentDownload struct {
	// Body is the attachment's bytes, exactly as they were kept.
	Body []byte
	// Filename is the name the server gave the download (the attachment's
	// own, or a stand-in such as "attachment-1"); "" when it named none.
	Filename string
	// ContentType is the attachment's declared type when it is a plain media
	// type, otherwise "application/octet-stream".
	ContentType string
}

// Raw returns a captured email's exact message, its RFC 5322 bytes:
// whatever its size when the email was kept in storage (EmailCapture.Stored),
// otherwise only when the message was at most 1 MiB. A message that was not
// kept matches ErrNotFound; for an HTTP request the error is an *Error with
// status 400.
func (s *RequestsService) Raw(ctx context.Context, id string) ([]byte, error) {
	if err := validateSegment(id, "request id"); err != nil {
		return nil, err
	}
	download, err := s.c.download(ctx, "/requests/"+id+"/raw")
	if err != nil {
		return nil, err
	}
	return download.Body, nil
}

// Attachment downloads one attachment of a stored email
// (EmailCapture.Stored), by its index in EmailCapture.Attachments, from 0 to
// 99. An attachment the email does not have, or whose contents were not
// kept, matches ErrNotFound.
func (s *RequestsService) Attachment(ctx context.Context, id string, index int) (*AttachmentDownload, error) {
	if err := validateSegment(id, "request id"); err != nil {
		return nil, err
	}
	if index < 0 || index > 99 {
		return nil, fmt.Errorf("webhooks.cc: attachment index must be from 0 to 99, not %d", index)
	}
	return s.c.download(ctx, "/requests/"+id+"/attachments/"+strconv.Itoa(index))
}

// download reads a binary response with the client's auth: a raw message or
// an attachment. It is retried like any other GET.
func (c *Client) download(ctx context.Context, path string) (*AttachmentDownload, error) {
	response, err := c.call(ctx, http.MethodGet, path, nil, nil, true)
	if err != nil {
		return nil, err
	}
	contentType := response.header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return &AttachmentDownload{
		Body:        response.body,
		Filename:    dispositionFilename(response.header.Get("Content-Disposition")),
		ContentType: contentType,
	}, nil
}

var (
	plainFilename   = regexp.MustCompile(`(?i)filename="([^"]*)"`)
	encodedFilename = regexp.MustCompile(`(?i)filename\*=UTF-8''([^;]+)`)
)

// dispositionFilename reads a Content-Disposition header's file name: the
// UTF-8 filename* when it decodes, otherwise the plain filename. A name cut
// inside an escape keeps the plain one, as the TypeScript SDK does.
func dispositionFilename(disposition string) string {
	name := ""
	if match := plainFilename.FindStringSubmatch(disposition); match != nil {
		name = match[1]
	}
	if match := encodedFilename.FindStringSubmatch(disposition); match != nil {
		if decoded, err := url.PathUnescape(match[1]); err == nil && utf8.ValidString(decoded) {
			name = decoded
		}
	}
	return name
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
			// A network blip, a poll that timed out or a server error: try
			// again at the next poll.
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

// SearchOptions narrow Requests.Search, SearchPage, Count and CountPage. All
// are optional.
type SearchOptions struct {
	Slug   string
	Method string
	Kind   RequestKind
	// Query is found as a substring of the path, the headers and the body,
	// and of an email's decoded subject, text and addresses.
	Query string
	From  time.Time
	To    time.Time
	// Limit, Offset and Order ("asc" or "desc") apply to Search and
	// SearchPage only. Limit defaults to 50; one page holds at most 200.
	// Offset belongs to a search's first page: a cursor carries what is left
	// of it.
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

// searchDeadline is how long Search and Count keep following the cursor. Each
// page reads for about two seconds on the server.
var searchDeadline = 25 * time.Second

const defaultSearchLimit = 50

// searchDeadlineGrace is what a page of Search or Count may run past their
// deadline before it times out.
var searchDeadlineGrace = 5 * time.Second

// pageContext gives one page of Search or Count the client's timeout, or
// less when the deadline is near, so a page started just before it cannot
// run long past it.
func pageContext(ctx context.Context, deadline time.Time) context.Context {
	return withCallTimeout(ctx, max(0, time.Until(deadline))+searchDeadlineGrace)
}

// cutShortByDeadline reports whether err is the timeout of a page that had
// less than the client's own timeout (see pageContext), while the caller's
// context still runs.
func (c *Client) cutShortByDeadline(ctx context.Context, err error) bool {
	var timeout *TimeoutError
	return ctx.Err() == nil && errors.As(err, &timeout) && timeout.After < c.timeout
}

// isBusySearch reports whether err is the 429 of a busy search server: the
// account already runs two searches, or the server is at its limit.
func isBusySearch(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusTooManyRequests && apiErr.code == "search_busy"
}

// waitOutBusySearch sleeps as long as a busy search server asked (a second at
// least) when the wait still fits before the deadline. It reports whether it
// slept; the error is the context's, when it ended first.
func waitOutBusySearch(ctx context.Context, err error, deadline time.Time) (bool, error) {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		return false, nil
	}
	wait := max(apiErr.RetryAfter, time.Second)
	if !time.Now().Add(wait).Before(deadline) {
		return false, nil
	}
	if err := sleep(ctx, wait); err != nil {
		return false, err
	}
	return true, nil
}

// SearchPage is one page of a search, as Requests.SearchPage returns it. The
// server reads requests one stretch of time after another and answers within
// about two seconds, so a page can be short or empty without being the end.
type SearchPage struct {
	// Requests are the matches this page found. Each ID is the request's own
	// ID, the one Requests.Get and the other request calls take.
	Requests []Request
	// Complete reports whether the whole range was read. When false, older
	// requests (newer ones with Order "asc") were not searched yet: pass
	// Cursor to read on.
	Complete bool
	// SearchedUntil is how far the search read; zero when the server did not
	// say.
	SearchedUntil time.Time
	// Cursor continues the search with the same options; empty once it is
	// complete. It is opaque: pass it back as it is.
	Cursor string
}

// CountPage is one answer of Requests.CountPage.
type CountPage struct {
	// Count is the matches counted by this call.
	Count int
	// Exact reports whether the whole range was counted. When false, Count
	// covers only the requests back to SearchedUntil: pass Cursor to count
	// the next stretch and add the counts up.
	Exact bool
	// SearchedUntil is how far the count read; zero when the server did not
	// say.
	SearchedUntil time.Time
	// Cursor continues the count with the same options; empty once it is
	// exact.
	Cursor string
}

// Search searches retained requests: Query is found as a substring of the
// path, the headers and the body, and of an email's decoded subject, text and
// addresses. Each result's ID is the request's own ID, as Get takes it.
//
// It returns at most Limit matches (50 by default), newest first unless Order
// is "asc". A search reads a long history in pages; Search follows them until
// it has Limit matches, the whole range was read, or 25 seconds have passed,
// so a rare term in a long history can return fewer matches than exist.
// SearchPage reads one page and says how far it got.
//
// When the server is busy with other searches (a 429 "search_busy"), Search
// waits as long as the server asks and tries the page again while that fits
// in the 25 seconds; after that it returns what it has, or the error (matching
// ErrRateLimited) when it has read no page yet.
func (s *RequestsService) Search(ctx context.Context, opts SearchOptions) ([]Request, error) {
	query, err := opts.values()
	if err != nil {
		return nil, err
	}
	if opts.Order != "" {
		query.Set("order", opts.Order)
	}
	wanted := opts.Limit
	if wanted <= 0 {
		wanted = defaultSearchLimit
	}
	deadline := time.Now().Add(searchDeadline)
	var found []Request
	cursor := ""
	for {
		if opts.Limit > 0 || len(found) > 0 {
			query.Set("limit", strconv.Itoa(wanted-len(found)))
		}
		// The cursor carries what is left of the offset.
		if opts.Offset > 0 && cursor == "" {
			query.Set("offset", strconv.Itoa(opts.Offset))
		} else {
			query.Del("offset")
		}
		page, err := s.searchPage(pageContext(ctx, deadline), query, cursor)
		if err != nil {
			// Cut short by the deadline, not by the client's own timeout:
			// the search ends with what it has.
			if cursor != "" && s.c.cutShortByDeadline(ctx, err) {
				break
			}
			// Only a busy search server is waited out, and only a wait that
			// no longer fits ends the search with what it has.
			if !isBusySearch(err) {
				return nil, err
			}
			waited, waitErr := waitOutBusySearch(ctx, err, deadline)
			if waitErr != nil {
				return nil, waitErr
			}
			if waited {
				continue
			}
			if cursor == "" {
				return nil, err
			}
			break
		}
		found = append(found, page.Requests...)
		cursor = page.Cursor
		if len(found) >= wanted || page.Complete || cursor == "" || !time.Now().Before(deadline) {
			break
		}
	}
	if len(found) > wanted {
		found = found[:wanted]
	}
	return found, nil
}

// SearchPage reads one page of a search and reports how far it read. An
// empty cursor starts the search; to read on, pass the same options with the
// Cursor of the page before. Offset is sent with the first page only.
//
// A cursor the server did not issue for this search (one that was changed, or
// that came from a search in the other order) is an error matching
// ErrInvalidCursor. Keep From and To the same across pages.
func (s *RequestsService) SearchPage(ctx context.Context, opts SearchOptions, cursor string) (*SearchPage, error) {
	query, err := opts.values()
	if err != nil {
		return nil, err
	}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 && cursor == "" {
		query.Set("offset", strconv.Itoa(opts.Offset))
	}
	if opts.Order != "" {
		query.Set("order", opts.Order)
	}
	return s.searchPage(ctx, query, cursor)
}

func (s *RequestsService) searchPage(ctx context.Context, query url.Values, cursor string) (*SearchPage, error) {
	query.Set("paged", "true")
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	response, err := s.c.call(ctx, http.MethodGet, "/search/requests", query, nil, true)
	if err != nil {
		return nil, err
	}
	page := &SearchPage{Cursor: response.header.Get("X-Search-Cursor")}
	if len(response.body) > 0 {
		if err := json.Unmarshal(response.body, &page.Requests); err != nil {
			return nil, fmt.Errorf("webhooks.cc: reading the response: %w", err)
		}
	}
	if complete := response.header.Get("X-Search-Complete"); complete != "" {
		page.Complete = strings.EqualFold(strings.TrimSpace(complete), "true")
	} else {
		// A server that sends no progress has nothing more to give.
		page.Complete = page.Cursor == ""
	}
	if until, ok := headerInt64(response.header, "X-Search-Searched-Until"); ok {
		page.SearchedUntil = time.UnixMilli(until)
	}
	return page, nil
}

// Count returns how many retained requests match the search.
//
// Without Query and Method the count is exact. With them the server counts a
// long history in stretches; Count adds them up until the count is exact or
// 25 seconds have passed, and then returns what it counted, which is a lower
// bound. CountPage says whether a count is exact. A busy server (a 429
// "search_busy") is waited out as Search does.
func (s *RequestsService) Count(ctx context.Context, opts SearchOptions) (int, error) {
	query, err := opts.values()
	if err != nil {
		return 0, err
	}
	deadline := time.Now().Add(searchDeadline)
	total := 0
	cursor := ""
	for {
		page, err := s.countPage(pageContext(ctx, deadline), query, cursor)
		if err != nil {
			// Cut short by the deadline, not by the client's own timeout:
			// the search ends with what it has.
			if cursor != "" && s.c.cutShortByDeadline(ctx, err) {
				return total, nil
			}
			// Only a busy search server is waited out, and only a wait that
			// no longer fits ends the search with what it has.
			if !isBusySearch(err) {
				return 0, err
			}
			waited, waitErr := waitOutBusySearch(ctx, err, deadline)
			if waitErr != nil {
				return 0, waitErr
			}
			if waited {
				continue
			}
			if cursor == "" {
				return 0, err
			}
			return total, nil
		}
		total += page.Count
		cursor = page.Cursor
		if page.Exact || cursor == "" || !time.Now().Before(deadline) {
			return total, nil
		}
	}
}

// CountPage counts once and reports whether the count is exact. Without Query
// and Method it always is. With them the server counts for about two seconds:
// when Exact is false, Count covers the requests back to SearchedUntil, and
// the same options with Cursor count the next stretch (the counts add up).
//
// A cursor the server did not issue for this search is an error matching
// ErrInvalidCursor.
func (s *RequestsService) CountPage(ctx context.Context, opts SearchOptions, cursor string) (*CountPage, error) {
	query, err := opts.values()
	if err != nil {
		return nil, err
	}
	return s.countPage(ctx, query, cursor)
}

func (s *RequestsService) countPage(ctx context.Context, query url.Values, cursor string) (*CountPage, error) {
	query.Set("paged", "true")
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	var response struct {
		Count         int     `json:"count"`
		Exact         *bool   `json:"exact"`
		SearchedUntil *int64  `json:"searchedUntil"`
		Cursor        *string `json:"cursor"`
	}
	if err := s.c.api(ctx, http.MethodGet, "/search/requests/count", query, nil, &response); err != nil {
		return nil, err
	}
	page := &CountPage{Count: response.Count}
	if response.Cursor != nil {
		page.Cursor = *response.Cursor
	}
	if response.Exact != nil {
		page.Exact = *response.Exact
	} else {
		// A server that does not say counted everything it will.
		page.Exact = page.Cursor == ""
	}
	if response.SearchedUntil != nil {
		page.SearchedUntil = time.UnixMilli(*response.SearchedUntil)
	}
	return page, nil
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
	// Without Before the server clears up to its own clock, so a repeat after
	// a clear that went through would delete what arrived since.
	return s.c.apiRetrying(ctx, http.MethodDelete, "/endpoints/"+slug+"/requests", query, nil, nil, !opts.Before.IsZero())
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
