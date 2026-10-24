package webhookscc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

const (
	streamConnectTimeout     = 30 * time.Second
	streamDedupWindow        = 1000
	streamRapidRotation      = 5 * time.Second
	streamRapidRotationLimit = 2
	defaultStreamIdleTimeout = 90 * time.Second
	defaultReconnectAttempts = 5
	defaultReconnectBackoff  = time.Second
)

// SubscribeOptions control Requests.Subscribe. All are optional.
type SubscribeOptions struct {
	// Timeout ends the stream; zero streams until ctx ends.
	Timeout time.Duration
	// Reconnect follows the server's 30-minute connection rotation, resuming
	// after the last request so none is missed, and recovers from dropped
	// connections. Without it the stream ends at the first rotation.
	Reconnect bool
	// MaxReconnectAttempts is how many reconnects in a row are tried
	// (default 5), backing off from ReconnectBackoff (default 1 second),
	// doubled each time up to 30 seconds.
	MaxReconnectAttempts int
	ReconnectBackoff     time.Duration
	// IdleTimeout drops a connection that went silent (default 90 seconds,
	// three keepalives). Without Reconnect that ends the stream with a
	// TimeoutError. A negative value turns it off.
	IdleTimeout time.Duration
	// OnReconnect is called before each reconnect with the attempt number.
	OnReconnect func(attempt int)
}

// Subscribe streams requests to an endpoint as they arrive, over a
// server-sent event stream:
//
//	for request, err := range client.Requests.Subscribe(ctx, slug, webhookscc.SubscribeOptions{Timeout: 5 * time.Minute, Reconnect: true}) {
//		if err != nil {
//			return err
//		}
//		fmt.Println(request.Method, request.Path)
//	}
//
// The stream ends at opts.Timeout, when the endpoint is deleted, or when you
// stop iterating. An error ends it too, after being yielded once; when ctx
// ends, that error is ctx.Err().
//
// Streamed requests carry no parsed email; read it with Emails.Get(request.ID).
func (s *RequestsService) Subscribe(ctx context.Context, slug string, opts SubscribeOptions) iter.Seq2[*Request, error] {
	return func(yield func(*Request, error) bool) {
		if err := validateSegment(slug, "slug"); err != nil {
			yield(nil, err)
			return
		}
		stream := &subscription{
			c:           s.c,
			slug:        slug,
			opts:        opts,
			maxAttempts: opts.MaxReconnectAttempts,
			backoff:     durationOr(opts.ReconnectBackoff, defaultReconnectBackoff),
			idle:        opts.IdleTimeout,
			seen:        newRecentIDs(streamDedupWindow),
		}
		if stream.maxAttempts <= 0 {
			stream.maxAttempts = defaultReconnectAttempts
		}
		if stream.idle == 0 {
			stream.idle = defaultStreamIdleTimeout
		}
		stream.run(ctx, yield)
	}
}

type subscription struct {
	c           *Client
	slug        string
	opts        SubscribeOptions
	maxAttempts int
	backoff     time.Duration
	idle        time.Duration

	attempts       int
	lastReceivedAt time.Time
	// Where a reconnect resumes before any request arrived: the server's clock
	// at the first connection, so the gap is replayed rather than skipped.
	resumeFloor     time.Time
	rapidRotations  int
	endpointDeleted bool
	seen            *recentIDs
}

// errStop means the consumer stopped iterating.
var errStop = errors.New("stop")

func (s *subscription) run(parent context.Context, yield func(*Request, error) bool) {
	ctx := parent
	if s.opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(parent, s.opts.Timeout)
		defer cancel()
	}
	// finish ends the stream: quietly when its own timeout ran out, with the
	// caller's error when theirs ended.
	finish := func() {
		if err := parent.Err(); err != nil {
			yield(nil, err)
		}
	}

	for ctx.Err() == nil {
		rotated, err := s.connect(ctx, yield)
		if errors.Is(err, errStop) {
			return
		}
		if ctx.Err() != nil {
			finish()
			return
		}
		if err != nil {
			if !s.retryable(err) {
				yield(nil, err)
				return
			}
			if s.backOff(ctx) {
				continue
			}
			if ctx.Err() != nil {
				finish()
				return
			}
			yield(nil, err)
			return
		}
		if rotated {
			if !s.opts.Reconnect {
				return
			}
			if s.rapidRotations >= streamRapidRotationLimit && !s.backOff(ctx) {
				finish()
				return
			}
			continue
		}
		if s.endpointDeleted {
			return
		}
		// The stream ended without a terminal event (network drop, server restart).
		if s.backOff(ctx) {
			continue
		}
		finish()
		return
	}
	finish()
}

func (s *subscription) retryable(err error) bool {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusTooManyRequests || apiErr.StatusCode >= 500
	}
	return true
}

func (s *subscription) backOff(ctx context.Context) bool {
	if !s.opts.Reconnect || s.attempts >= s.maxAttempts || ctx.Err() != nil {
		return false
	}
	s.attempts++
	if s.opts.OnReconnect != nil {
		func() {
			// A callback must not break the stream.
			defer func() { _ = recover() }()
			s.opts.OnReconnect(s.attempts)
		}()
	}
	_ = sleep(ctx, backoffDelay(s.backoff, s.attempts))
	return ctx.Err() == nil
}

// connect streams one connection. It reports whether the server rotated it.
func (s *subscription) connect(ctx context.Context, yield func(*Request, error) bool) (bool, error) {
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	query := url.Values{}
	switch {
	case !s.lastReceivedAt.IsZero():
		query.Set("since", strconv.FormatInt(max(0, s.lastReceivedAt.UnixMilli()-1), 10))
	case !s.resumeFloor.IsZero():
		query.Set("since", strconv.FormatInt(max(0, s.resumeFloor.UnixMilli()), 10))
	}
	target := s.c.baseURL + "/api/stream/" + s.slug
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	request, err := http.NewRequestWithContext(connCtx, http.MethodGet, target, nil)
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "Bearer "+s.c.apiKey)
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("User-Agent", userAgent)

	// A client Timeout would cut the stream off; the timers below bound it instead.
	client := *s.c.http
	client.Timeout = 0
	var connectTimedOut, idleTimedOut atomic.Bool
	connectTimer := time.AfterFunc(streamConnectTimeout, func() {
		connectTimedOut.Store(true)
		cancel()
	})
	connectStarted := time.Now()
	response, err := client.Do(request)
	connectTimer.Stop()
	if err != nil {
		if connectTimedOut.Load() && ctx.Err() == nil {
			return false, &TimeoutError{After: streamConnectTimeout, message: fmt.Sprintf("stream connection timed out after %s", streamConnectTimeout)}
		}
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return false, errorFromResponse(&apiResponse{status: response.StatusCode, header: response.Header, body: body})
	}
	connectedAt := time.Now()
	if s.resumeFloor.IsZero() {
		if date, err := http.ParseTime(response.Header.Get("Date")); err == nil {
			s.resumeFloor = date
		} else {
			s.resumeFloor = connectStarted.Add(-time.Second)
		}
	}

	var idleTimer *time.Timer
	onLine := func() {}
	if s.idle > 0 {
		idleTimer = time.AfterFunc(s.idle, func() {
			idleTimedOut.Store(true)
			cancel()
		})
		defer idleTimer.Stop()
		onLine = func() { idleTimer.Reset(s.idle) }
	}

	reader := newSSEReader(response.Body, onLine)
	for {
		frame, err := reader.next()
		if err != nil {
			if ctx.Err() != nil {
				return false, nil
			}
			if idleTimedOut.Load() {
				return false, &TimeoutError{After: s.idle, message: fmt.Sprintf("stream idle for %s: no data or keepalive received", s.idle)}
			}
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return false, nil
			}
			return false, err
		}
		if ctx.Err() != nil {
			return false, nil
		}
		switch frame.event {
		case "request":
			request := streamRequest(frame.data)
			if request == nil {
				continue
			}
			// A delivered request proves the stream healthy.
			s.attempts = 0
			if request.ID != "" && s.seen.has(request.ID) {
				continue
			}
			if request.ID != "" {
				s.seen.add(request.ID)
			}
			if s.lastReceivedAt.IsZero() || request.ReceivedAt.After(s.lastReceivedAt) {
				s.lastReceivedAt = request.ReceivedAt
			}
			s.rapidRotations = 0
			// The idle clock only runs while waiting for the server: a slow
			// loop body is not a silent connection.
			if idleTimer != nil {
				idleTimer.Stop()
			}
			if !yield(request, nil) {
				return false, errStop
			}
			if idleTimer != nil {
				idleTimer.Reset(s.idle)
			}
		case "timeout":
			// The server's scheduled rotation (every 30 minutes): not a failure.
			if time.Since(connectedAt) < streamRapidRotation {
				s.rapidRotations++
			} else {
				s.rapidRotations = 0
			}
			return true, nil
		case "endpoint_deleted":
			s.endpointDeleted = true
			return false, nil
		case "comment":
			s.attempts = 0 // a keepalive: the connection is healthy
		}
	}
}

func streamRequest(data string) *Request {
	var o rawObject
	if json.Unmarshal([]byte(data), &o) != nil || o == nil {
		return nil
	}
	if _, ok := o.strOK("endpointId"); !ok {
		return nil
	}
	if _, ok := o.strOK("method"); !ok {
		return nil
	}
	if _, ok := o.numOK("receivedAt"); !ok || o.object("headers") == nil {
		return nil
	}
	var request Request
	if json.Unmarshal([]byte(data), &request) != nil {
		return nil
	}
	return &request
}

// recentIDs remembers the last capacity ids, oldest evicted first.
type recentIDs struct {
	ids   map[string]bool
	order []string
	limit int
}

func newRecentIDs(limit int) *recentIDs {
	return &recentIDs{ids: map[string]bool{}, limit: max(1, limit)}
}

func (r *recentIDs) has(id string) bool { return r.ids[id] }

func (r *recentIDs) add(id string) {
	if r.ids[id] {
		return
	}
	r.ids[id] = true
	r.order = append(r.order, id)
	if len(r.order) > r.limit {
		delete(r.ids, r.order[0])
		r.order = r.order[1:]
	}
}
