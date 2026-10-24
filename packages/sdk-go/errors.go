package webhookscc

import (
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Sentinel errors to test with errors.Is.
var (
	// ErrUnauthorized: the API key is missing or invalid (401).
	ErrUnauthorized = errors.New("webhooks.cc: unauthorized")
	// ErrNotFound: the endpoint, request or email does not exist (404).
	ErrNotFound = errors.New("webhooks.cc: not found")
	// ErrRateLimited: too many requests (429).
	ErrRateLimited = errors.New("webhooks.cc: rate limited")
	// ErrTimeout: an API call, a wait or a stream ran out of time.
	ErrTimeout = errors.New("webhooks.cc: timed out")
	// ErrMissingAPIKey: New got no API key and WHK_API_KEY is not set.
	ErrMissingAPIKey = errors.New("webhooks.cc: missing API key: pass WithAPIKey or set WHK_API_KEY. Get one at https://webhooks.cc/account/api-keys")
)

// Error is an error response from the webhooks.cc API.
//
// errors.Is matches it against ErrUnauthorized, ErrNotFound and
// ErrRateLimited by status code.
type Error struct {
	StatusCode int
	Message    string
	// RetryAfter is how long a 429 asked to wait, when the server said.
	RetryAfter time.Duration
	// RateLimit is set on a 429 that carried all the X-RateLimit headers.
	RateLimit *RateLimit
}

// RateLimit is what a 429's X-RateLimit headers said.
type RateLimit struct {
	Limit     int
	Remaining int
	Reset     int64
}

func (e *Error) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("webhooks.cc: HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("webhooks.cc: %s (HTTP %d)", e.Message, e.StatusCode)
}

// Is reports whether the error has the status code of target.
func (e *Error) Is(target error) bool {
	switch target {
	case ErrUnauthorized:
		return e.StatusCode == http.StatusUnauthorized
	case ErrNotFound:
		return e.StatusCode == http.StatusNotFound
	case ErrRateLimited:
		return e.StatusCode == http.StatusTooManyRequests
	}
	return false
}

// TimeoutError is returned when an API call, a wait or a stream ran out of
// time. errors.Is(err, ErrTimeout) matches it.
//
// When the context you passed ends first, the SDK returns the context's error
// instead.
type TimeoutError struct {
	// After is the timeout that ran out.
	After   time.Duration
	message string
}

func (e *TimeoutError) Error() string {
	if e.message != "" {
		return "webhooks.cc: " + e.message
	}
	return fmt.Sprintf("webhooks.cc: timed out after %s", e.After)
}

// Is matches ErrTimeout.
func (e *TimeoutError) Is(target error) bool { return target == ErrTimeout }

// Timeout reports true, as net.Error does for timeouts.
func (e *TimeoutError) Timeout() bool { return true }
