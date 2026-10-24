package webhookscc

import (
	"context"
	"errors"
	"slices"
	"time"
)

const (
	cleanupTimeout      = 30 * time.Second
	captureListLimit    = 100
	defaultCaptureWait  = 30 * time.Second
	defaultCapturePoll  = 200 * time.Millisecond
	minCapturePollDelay = 10 * time.Millisecond
)

// WithTemporaryEndpoint creates an endpoint, calls fn with it, and deletes it
// when fn returns, however fn ends. In tests, whktest.Endpoint does the same
// with t.Cleanup.
func (c *Client) WithTemporaryEndpoint(ctx context.Context, opts CreateEndpointOptions, fn func(*Endpoint) error) (err error) {
	endpoint, err := c.Endpoints.Create(ctx, opts)
	if err != nil {
		return err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		if deleteErr := c.Endpoints.Delete(cleanupCtx, endpoint.Slug); deleteErr != nil && !errors.Is(deleteErr, ErrNotFound) && err == nil {
			err = deleteErr
		}
	}()
	return fn(endpoint)
}

// CaptureOptions control CaptureDuring. All are optional.
type CaptureOptions struct {
	// Name names the temporary endpoint.
	Name string
	// Count is how many requests to wait for (default 1).
	Count int
	// Timeout defaults to 30 seconds, PollInterval to 200 milliseconds.
	Timeout      time.Duration
	PollInterval time.Duration
	// Match keeps only matching requests.
	Match Matcher
}

// CaptureDuring runs action with a temporary endpoint and returns the requests
// it sent there, oldest first, once opts.Count of them (matching opts.Match)
// have arrived. The endpoint is deleted afterwards.
//
//	requests, err := client.CaptureDuring(ctx, func(endpoint *webhookscc.Endpoint) error {
//		return notify(endpoint.URL)
//	}, webhookscc.CaptureOptions{})
func (c *Client) CaptureDuring(ctx context.Context, action func(*Endpoint) error, opts CaptureOptions) ([]Request, error) {
	timeout := durationOr(opts.Timeout, defaultCaptureWait)
	poll := max(minCapturePollDelay, durationOr(opts.PollInterval, defaultCapturePoll))
	wanted := max(1, opts.Count)
	limit := max(captureListLimit, wanted*5)
	var captured []Request
	err := c.WithTemporaryEndpoint(ctx, CreateEndpointOptions{Name: opts.Name}, func(endpoint *Endpoint) error {
		started := time.Now()
		if err := action(endpoint); err != nil {
			return err
		}
		for time.Since(started) < timeout {
			requests, err := c.Requests.List(ctx, endpoint.Slug, ListOptions{Limit: limit})
			if err != nil {
				return err
			}
			var matched []Request
			for i := range requests {
				if opts.Match == nil || opts.Match(&requests[i]) {
					matched = append(matched, requests[i])
				}
			}
			slices.SortStableFunc(matched, func(a, b Request) int { return a.ReceivedAt.Compare(b.ReceivedAt) })
			if len(matched) >= wanted {
				captured = matched[:wanted]
				return nil
			}
			if err := sleep(ctx, poll); err != nil {
				return err
			}
		}
		return &TimeoutError{After: timeout}
	})
	return captured, err
}

// CaptureEmailOptions control CaptureEmailDuring. All are optional.
type CaptureEmailOptions struct {
	// Query filters the emails and sets the timeout. With Query.Tag, the
	// address passed to the action carries the tag.
	Query EmailQuery
	// Count is how many emails to wait for (default 1).
	Count int
	// Name names the temporary endpoint.
	Name string
}

// CaptureEmailDuring runs action with a temporary endpoint's email address
// and returns the emails it sent there, oldest first. The endpoint is
// deleted afterwards.
//
//	emails, err := client.CaptureEmailDuring(ctx, func(address string, _ *webhookscc.Endpoint) error {
//		return signUp(address)
//	}, webhookscc.CaptureEmailOptions{Query: webhookscc.EmailQuery{Subject: "Confirm your email"}})
func (c *Client) CaptureEmailDuring(ctx context.Context, action func(address string, endpoint *Endpoint) error, opts CaptureEmailOptions) ([]Request, error) {
	var captured []Request
	err := c.WithTemporaryEndpoint(ctx, CreateEndpointOptions{Name: opts.Name}, func(endpoint *Endpoint) error {
		address, err := c.Emails.AddressOf(endpoint, opts.Query.Tag)
		if err != nil {
			return err
		}
		if err := action(address, endpoint); err != nil {
			return err
		}
		query := opts.Query
		// A new endpoint: everything it received counts, measured on the server's clock.
		query.Since = endpoint.CreatedAt
		captured, err = c.Emails.WaitForAll(ctx, endpoint.Slug, max(1, opts.Count), query)
		return err
	})
	return captured, err
}
