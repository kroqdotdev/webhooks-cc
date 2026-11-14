package webhookscc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBackoffDelayDoublesUpToACap(t *testing.T) {
	cases := []struct {
		base    time.Duration
		attempt int
		want    time.Duration
	}{
		{time.Second, 1, time.Second},
		{time.Second, 2, 2 * time.Second},
		{time.Second, 5, 16 * time.Second},
		{time.Second, 6, 30 * time.Second},
		{time.Second, 500, 30 * time.Second}, // no overflow
		{time.Minute, 3, time.Minute},        // a longer base is kept
		{time.Millisecond, 3, 4 * time.Millisecond},
	}
	for _, c := range cases {
		if got := backoffDelay(c.base, c.attempt); got != c.want {
			t.Errorf("backoffDelay(%s, %d) = %s, want %s", c.base, c.attempt, got, c.want)
		}
	}
}

func TestSSEReaderRefusesOversizedLinesAndEvents(t *testing.T) {
	previous := maxSSEBytes
	maxSSEBytes = 100
	defer func() { maxSSEBytes = previous }()

	read := func(stream string) (sseFrame, error) {
		return newSSEReader(strings.NewReader(stream), nil).next()
	}
	if frame, err := read("event: request\ndata: " + strings.Repeat("x", 50) + "\n\n"); err != nil || len(frame.data) != 50 {
		t.Errorf("a small event: %v, %v", frame, err)
	}
	if _, err := read("data: " + strings.Repeat("x", 200)); !errors.Is(err, errSSETooLarge) {
		t.Errorf("an unterminated long line: %v", err)
	}
	many := strings.Repeat("data: "+strings.Repeat("x", 40)+"\n", 5) + "\n"
	if _, err := read(many); !errors.Is(err, errSSETooLarge) {
		t.Errorf("an event of many lines: %v", err)
	}
}

// Header numbers read as parseInt reads them: ASCII digits after JavaScript's
// whitespace, with the header's bytes taken as Latin-1.
func TestHeaderDigitsSkipJavaScriptWhitespace(t *testing.T) {
	cases := map[string]string{
		"7":      "7",
		" \t7s":  "7",
		"\xa07":  "7", // a no-break space
		"\x857":  "",  // U+0085 is not whitespace to JavaScript
		"\x1c7":  "",
		"\u0663": "", // an Arabic-Indic digit
		"seven":  "",
		"12, 3":  "12",
		"":       "",
	}
	for value, want := range cases {
		header := http.Header{"Retry-After": {value}}
		got, ok := headerDigits(header, "Retry-After")
		if got != want || ok != (want != "") {
			t.Errorf("headerDigits(%q) = %q, %v; want %q", value, got, ok, want)
		}
	}
}

func TestConnectionNeverPrintsItsClaimToken(t *testing.T) {
	conn := &Connection{registrationID: "reg_1", claimToken: "clm_secret"}
	sandbox := &Sandbox{registrationID: "reg_2", claimToken: "clm_secret"}
	for _, value := range []any{conn, sandbox} {
		for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
			if got := fmt.Sprintf(format, value); strings.Contains(got, "clm_") {
				t.Fatalf("%s printed the claim token: %s", format, got)
			}
		}
	}
}

func TestOnlyAFinishedRegistrationStartsANewOne(t *testing.T) {
	for code, want := range map[string]bool{
		"claim_expired":        true,
		"invalid_claim_token":  true,
		"too_many_attempts":    true,
		"rate_limited":         false,
		"claimed_or_in_flight": false,
	} {
		if got := registrationOver(&AgentAuthError{Code: code, Status: 400}); got != want {
			t.Errorf("%s: got %v, want %v", code, got, want)
		}
	}
	if registrationOver(errors.New("network")) {
		t.Error("a network error must not start a new registration")
	}
}

func TestDispositionFilenamePrefersAnEncodedNameThatDecodes(t *testing.T) {
	cases := []struct{ header, want string }{
		{`attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`, "r\u00e9sum\u00e9.csv"},
		{`attachment; filename="plain.txt"`, "plain.txt"},
		{`attachment; filename*=utf-8''Invoice%20(1).pdf`, "Invoice (1).pdf"},
		// Cut inside an escape, or not UTF-8: the plain name.
		{`attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A`, "r_sum_.csv"},
		{`attachment; filename="x.bin"; filename*=UTF-8''%FF.bin`, "x.bin"},
		{"", ""},
	}
	for _, c := range cases {
		if got := dispositionFilename(c.header); got != c.want {
			t.Errorf("dispositionFilename(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

// Search and Count stop following the cursor at their deadline and return
// what they have.
func TestSearchAndCountStopAtTheirDeadline(t *testing.T) {
	previous := searchDeadline
	searchDeadline = 0
	defer func() { searchDeadline = previous }()

	var cursors []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cursors = append(cursors, r.URL.Path+"?cursor="+r.URL.Query().Get("cursor"))
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/count") {
			fmt.Fprint(w, `{"count":2,"exact":false,"searchedUntil":1767225000000,"cursor":"more"}`)
			return
		}
		w.Header().Set("X-Search-Complete", "false")
		w.Header().Set("X-Search-Cursor", "more")
		fmt.Fprint(w, `[{"id":"r1","slug":"acme-test","method":"POST","receivedAt":1767225000000}]`)
	}))
	defer server.Close()
	client, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	found, err := client.Requests.Search(ctx, SearchOptions{Query: "rare"})
	if err != nil || len(found) != 1 || found[0].ID != "r1" {
		t.Errorf("search = %+v, %v", found, err)
	}
	count, err := client.Requests.Count(ctx, SearchOptions{Query: "rare"})
	if err != nil || count != 2 {
		t.Errorf("count = %d, %v", count, err)
	}
	if got := strings.Join(cursors, " "); got != "/api/search/requests?cursor= /api/search/requests/count?cursor=" {
		t.Errorf("calls = %s", got)
	}
}

// busySearchServer answers each call with the next scripted answer: "busy" is
// a 429 search_busy, "limited" an ordinary 429, anything else the JSON body
// of a 200 (search pages carry a cursor and are not complete).
func busySearchServer(t *testing.T, retryAfter string, answers ...string) (*Client, *[]string) {
	t.Helper()
	var cursors []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer := answers[min(len(cursors), len(answers)-1)]
		cursors = append(cursors, r.URL.Query().Get("cursor"))
		w.Header().Set("Content-Type", "application/json")
		switch answer {
		case "broken":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"error":"Internal server error"}`)
		case "invalid":
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":"invalid_cursor"}`)
		case "busy", "limited":
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.WriteHeader(http.StatusTooManyRequests)
			if answer == "busy" {
				fmt.Fprint(w, `{"error":"search_busy","message":"busy"}`)
			} else {
				fmt.Fprint(w, `{"error":"Too many requests"}`)
			}
		default:
			if !strings.HasSuffix(r.URL.Path, "/count") {
				w.Header().Set("X-Search-Complete", fmt.Sprint(strings.Contains(answer, "last")))
				if !strings.Contains(answer, "last") {
					w.Header().Set("X-Search-Cursor", "c1")
				}
			}
			fmt.Fprint(w, answer)
		}
	}))
	t.Cleanup(server.Close)
	client, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	return client, &cursors
}

// Search and Count wait out a busy server whatever the retry options say, and
// ask for the same page again.
func TestSearchAndCountWaitOutABusyServer(t *testing.T) {
	ctx := context.Background()
	client, cursors := busySearchServer(t, "", "busy", `[{"id":"r1"}]`, "busy", `[{"id":"last"}]`)
	started := time.Now()
	found, err := client.Requests.Search(ctx, SearchOptions{Query: "x"})
	if err != nil || len(found) != 2 || found[1].ID != "last" {
		t.Fatalf("search = %+v, %v", found, err)
	}
	if got := strings.Join(*cursors, ","); got != ",,c1,c1" {
		t.Errorf("search cursors = %q", got)
	}
	// A second at least for each, when the server names no wait.
	if waited := time.Since(started); waited < 2*time.Second {
		t.Errorf("waited %s for two busy answers", waited)
	}

	client, cursors = busySearchServer(t, "0",
		`{"count":2,"exact":false,"cursor":"c1"}`, "busy", `{"count":5,"exact":true,"cursor":null}`)
	count, err := client.Requests.Count(ctx, SearchOptions{Query: "x"})
	if err != nil || count != 7 {
		t.Errorf("count = %d, %v", count, err)
	}
	if got := strings.Join(*cursors, ","); got != ",c1,c1" {
		t.Errorf("count cursors = %q", got)
	}
}

// A wait that does not fit before the deadline ends the search: with what it
// has after the first page, with the error on it.
func TestABusyWaitPastTheDeadlineEndsTheSearch(t *testing.T) {
	ctx := context.Background()
	started := time.Now()
	client, _ := busySearchServer(t, "60", `[{"id":"r1"}]`, "busy")
	if found, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); err != nil || len(found) != 1 {
		t.Errorf("search after a page = %+v, %v", found, err)
	}
	client, _ = busySearchServer(t, "60", `{"count":2,"exact":false,"cursor":"c1"}`, "busy")
	if count, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); err != nil || count != 2 {
		t.Errorf("count after a page = %d, %v", count, err)
	}
	client, _ = busySearchServer(t, "60", "busy")
	var apiErr *Error
	if _, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); !errors.Is(err, ErrRateLimited) || !errors.As(err, &apiErr) || apiErr.RetryAfter != time.Minute {
		t.Errorf("search on the first page: %v", err)
	}
	if _, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); !errors.Is(err, ErrRateLimited) {
		t.Errorf("count on the first page: %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Error("a wait past the deadline was slept")
	}
}

// An ordinary rate limit, and a busy answer to a page call, go to the caller.
func TestOnlyABusySearchIsWaitedOut(t *testing.T) {
	ctx := context.Background()
	started := time.Now()
	client, cursors := busySearchServer(t, "1", "limited")
	if _, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); !errors.Is(err, ErrRateLimited) {
		t.Errorf("search: %v", err)
	}
	if _, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); !errors.Is(err, ErrRateLimited) {
		t.Errorf("count: %v", err)
	}
	if len(*cursors) != 2 {
		t.Errorf("an ordinary rate limit was tried %d times", len(*cursors))
	}
	client, cursors = busySearchServer(t, "1", "busy")
	if _, err := client.Requests.SearchPage(ctx, SearchOptions{Query: "x"}, ""); !errors.Is(err, ErrRateLimited) {
		t.Errorf("search page: %v", err)
	}
	if _, err := client.Requests.CountPage(ctx, SearchOptions{Query: "x"}, ""); !errors.Is(err, ErrRateLimited) {
		t.Errorf("count page: %v", err)
	}
	if len(*cursors) != 2 || time.Since(started) > 900*time.Millisecond {
		t.Errorf("page calls: %d tries in %s", len(*cursors), time.Since(started))
	}
}

func TestSearchCollectsMoreThanAPageHolds(t *testing.T) {
	var limits []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limits = append(limits, r.URL.Query().Get("limit"))
		items := make([]string, 200)
		for i := range items {
			items[i] = fmt.Sprintf(`{"id":"r%d-%d"}`, len(limits), i)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Search-Complete", "false")
		w.Header().Set("X-Search-Cursor", "more")
		fmt.Fprint(w, "["+strings.Join(items, ",")+"]")
	}))
	defer server.Close()
	client, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	found, err := client.Requests.Search(context.Background(), SearchOptions{Query: "x", Limit: 450})
	if err != nil || len(found) != 450 {
		t.Fatalf("found %d, %v", len(found), err)
	}
	if got := strings.Join(limits, ","); got != "450,250,50" {
		t.Errorf("limits = %s", got)
	}
}

// An error on a later page is the call's error, never a short result.
func TestAnErrorOnALaterPageIsReturned(t *testing.T) {
	ctx := context.Background()
	started := time.Now()
	cases := []struct {
		answer string
		is     func(error) bool
	}{
		{"broken", func(err error) bool {
			var apiErr *Error
			return errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusInternalServerError
		}},
		{"limited", func(err error) bool { return errors.Is(err, ErrRateLimited) }},
		{"invalid", func(err error) bool { return errors.Is(err, ErrInvalidCursor) }},
	}
	for _, c := range cases {
		client, cursors := busySearchServer(t, "1", `[{"id":"r1"}]`, c.answer)
		if found, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); found != nil || !c.is(err) {
			t.Errorf("%s: search = %+v, %v", c.answer, found, err)
		}
		if got := strings.Join(*cursors, ","); got != ",c1" {
			t.Errorf("%s: search cursors = %q", c.answer, got)
		}
		client, _ = busySearchServer(t, "1", `{"count":2,"exact":false,"cursor":"c1"}`, c.answer)
		if count, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); count != 0 || !c.is(err) {
			t.Errorf("%s: count = %d, %v", c.answer, count, err)
		}
	}
	if time.Since(started) > 900*time.Millisecond {
		t.Error("an ordinary rate limit was waited out")
	}
}

// A context that ends in the middle of a search ends it with the context's
// error: on a later page, and during a busy wait.
func TestAContextCancelledMidSearchEndsIt(t *testing.T) {
	for _, later := range []string{`[{"id":"r2"}]`, "busy"} {
		ctx, cancel := context.WithCancel(context.Background())
		calls := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Header().Set("Content-Type", "application/json")
			if calls > 1 {
				cancel()
				if later == "busy" {
					w.WriteHeader(http.StatusTooManyRequests)
					fmt.Fprint(w, `{"error":"search_busy"}`)
					return
				}
				// The answer never comes: the caller gave up.
				<-r.Context().Done()
				return
			}
			w.Header().Set("X-Search-Complete", "false")
			w.Header().Set("X-Search-Cursor", "c1")
			if strings.HasSuffix(r.URL.Path, "/count") {
				fmt.Fprint(w, `{"count":2,"exact":false,"cursor":"c1"}`)
				return
			}
			fmt.Fprint(w, `[{"id":"r1"}]`)
		}))
		client, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL))
		if err != nil {
			t.Fatal(err)
		}
		if found, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); found != nil || !errors.Is(err, context.Canceled) {
			t.Errorf("%s: search = %+v, %v", later, found, err)
		}
		ctx, cancel = context.WithCancel(context.Background())
		calls = 0
		if count, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); count != 0 || !errors.Is(err, context.Canceled) {
			t.Errorf("%s: count = %d, %v", later, count, err)
		}
		cancel()
		server.Close()
	}
}

// A page of Search or Count started near the deadline times out soon after
// it; the page calls keep the client's timeout.
func TestAPageNearTheDeadlineGetsAShorterTimeout(t *testing.T) {
	deadline := time.Now().Add(time.Hour)
	if got, _ := pageContext(context.Background(), deadline).Value(callTimeoutKey{}).(time.Duration); got < time.Hour {
		t.Errorf("far from the deadline: %s", got)
	}
	if got, _ := pageContext(context.Background(), time.Now().Add(-time.Minute)).Value(callTimeoutKey{}).(time.Duration); got != searchDeadlineGrace {
		t.Errorf("past the deadline: %s", got)
	}

	previous, previousGrace := searchDeadline, searchDeadlineGrace
	searchDeadline, searchDeadlineGrace = 0, 100*time.Millisecond
	defer func() { searchDeadline, searchDeadlineGrace = previous, previousGrace }()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	client, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL), WithTimeout(700*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var timeout *TimeoutError
	started := time.Now()
	if _, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); !errors.As(err, &timeout) || timeout.After > 150*time.Millisecond {
		t.Errorf("search: %v", err)
	}
	if _, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); !errors.As(err, &timeout) || timeout.After > 150*time.Millisecond {
		t.Errorf("count: %v", err)
	}
	if took := time.Since(started); took > 600*time.Millisecond {
		t.Errorf("two pages past the deadline took %s", took)
	}
	started = time.Now()
	if _, err := client.Requests.SearchPage(ctx, SearchOptions{Query: "x"}, ""); !errors.As(err, &timeout) || timeout.After != 700*time.Millisecond {
		t.Errorf("search page: %v", err)
	}
	if took := time.Since(started); took < 650*time.Millisecond {
		t.Errorf("the page call timed out after %s", took)
	}
}

// A later page that timed out because the deadline cut it short ends the
// search with what it has; the client's own timeout is an error.
func TestALaterPageCutShortByTheDeadlineEndsTheSearch(t *testing.T) {
	previous, previousGrace := searchDeadline, searchDeadlineGrace
	searchDeadline, searchDeadlineGrace = 0, 100*time.Millisecond
	defer func() { searchDeadline, searchDeadlineGrace = previous, previousGrace }()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") != "" {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/count") {
			fmt.Fprint(w, `{"count":2,"exact":false,"cursor":"c1"}`)
			return
		}
		w.Header().Set("X-Search-Complete", "false")
		w.Header().Set("X-Search-Cursor", "c1")
		fmt.Fprint(w, `[{"id":"r1"}]`)
	}))
	defer server.Close()
	defer close(release)
	ctx := context.Background()

	// 300 ms to the deadline and 100 ms of grace: less than the client's 5 s.
	searchDeadline = 300 * time.Millisecond
	client, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL), WithTimeout(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if found, err := client.Requests.Search(ctx, SearchOptions{Query: "x"}); err != nil || len(found) != 1 || found[0].ID != "r1" {
		t.Errorf("search = %+v, %v", found, err)
	}
	if count, err := client.Requests.Count(ctx, SearchOptions{Query: "x"}); err != nil || count != 2 {
		t.Errorf("count = %d, %v", count, err)
	}

	// The client's own 100 ms ran out first: the error.
	searchDeadline = time.Hour
	own, err := New(WithAPIKey("whcc_test"), WithBaseURL(server.URL), WithTimeout(100*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	if found, err := own.Requests.Search(ctx, SearchOptions{Query: "x"}); found != nil || !errors.Is(err, ErrTimeout) {
		t.Errorf("own timeout: search = %+v, %v", found, err)
	}
	if count, err := own.Requests.Count(ctx, SearchOptions{Query: "x"}); count != 0 || !errors.Is(err, ErrTimeout) {
		t.Errorf("own timeout: count = %d, %v", count, err)
	}
}
