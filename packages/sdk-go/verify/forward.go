package verify

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"time"

	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/sigutil"
)

// ErrorCode says why a forwarded request failed verification.
type ErrorCode string

// The codes an *Error carries.
const (
	// CodeMissingHeaders: a signature header is missing.
	CodeMissingHeaders ErrorCode = "missing_headers"
	// CodeTimestampOutOfRange: webhook-timestamp is too far from now.
	CodeTimestampOutOfRange ErrorCode = "timestamp_out_of_range"
	// CodeInvalidSignature: the signature does not match the body and secret.
	CodeInvalidSignature ErrorCode = "invalid_signature"
	// CodeInvalidPayload: the signature is valid but the body is not the
	// expected event. Answer it with 400 rather than 401.
	CodeInvalidPayload ErrorCode = "invalid_payload"
)

// Error is returned when a request is not a genuine delivery from
// webhooks.cc forwarding. Answer it with 401, or 400 for CodeInvalidPayload.
type Error struct {
	Code    ErrorCode
	Message string
}

func (e *Error) Error() string { return e.Message }

// ErrEmptyKey is returned, wrapped, for a secret that decodes to no key at
// all, such as "whsec_" or whitespace, from the checks keyed with a whsec_
// secret: forwarding, Standard Webhooks, Clerk and Resend. An HMAC keyed with
// nothing is one anyone can compute, so it is a setup error, reported
// before the request is looked at; test it with errors.Is.
var ErrEmptyKey = sigutil.ErrEmptyKey

// Event is an event webhooks.cc forwarded as signed JSON: email.received for
// email, request.received for an HTTP request.
type Event struct {
	// ID is the webhook-id header: the same on every retry of a delivery,
	// so it tells repeats apart.
	ID string
	// Type is "email.received" or "request.received".
	Type string
	// Timestamp is when the event was created, RFC 3339 UTC.
	Timestamp string
	// Data is the email or request as JSON; unmarshal it into a struct of
	// your own.
	Data json.RawMessage
}

// Relayed is the metadata of a request webhooks.cc forwarded as received.
type Relayed struct {
	// RequestID is the request's id in webhooks.cc, the same on every try
	// and redelivery: remember it to ignore repeats.
	RequestID string
	// ReceivedAt is when webhooks.cc received the request, exactly as sent
	// (RFC 3339 UTC with milliseconds).
	ReceivedAt string
	// Endpoint is the endpoint's slug, when the header is present.
	Endpoint string
	// Attempt is which try this is, from 1; 0 when unknown.
	Attempt int
}

// ForwardOption changes how ForwardedEmail, ForwardedRequest and
// ForwardedJSON check a delivery.
type ForwardOption func(*forwardConfig)

type forwardConfig struct {
	tolerance time.Duration
	now       time.Time
}

// WithTolerance sets how far webhook-timestamp may be from now. The default
// is five minutes.
func WithTolerance(tolerance time.Duration) ForwardOption {
	return func(c *forwardConfig) { c.tolerance = tolerance }
}

// WithNow sets the clock the timestamp is compared with.
func WithNow(now time.Time) ForwardOption {
	return func(c *forwardConfig) { c.now = now }
}

// ForwardedEmail verifies an email webhooks.cc forwarded to you and returns
// the email.received event.
//
// It checks webhook-id, webhook-timestamp and webhook-signature against the
// endpoint's whsec_ forwarding secret and refuses a timestamp more than five
// minutes from now. Pass the raw body, before any JSON parsing. Failures are
// *Error values; a secret with no key is ErrEmptyKey.
func ForwardedEmail(body []byte, headers Headers, secret string, opts ...ForwardOption) (*Event, error) {
	return forwarded(body, headers, secret, "email.received", []string{"id", "address"}, opts)
}

// ForwardedRequest verifies a request webhooks.cc forwarded as signed JSON
// and returns the request.received event, with the same checks as
// ForwardedEmail.
func ForwardedRequest(body []byte, headers Headers, secret string, opts ...ForwardOption) (*Event, error) {
	return forwarded(body, headers, secret, "request.received", []string{"id", "method", "path"}, opts)
}

// ForwardedJSON verifies a delivery of a destination that sends your own JSON
// (format "template") and returns its body: the same checks as
// ForwardedRequest, with the destination's whsec_ secret, but the body is
// whatever the destination's template made, so it can be any JSON value and
// only its being JSON is checked. Unmarshal it into a type of your own.
func ForwardedJSON(body []byte, headers Headers, secret string, opts ...ForwardOption) (json.RawMessage, error) {
	_, text, _, err := signedForward(body, headers, secret, opts)
	if err != nil {
		return nil, err
	}
	return text, nil
}

func forwarded(body []byte, headers Headers, secret, eventType string, stringFields []string, opts []ForwardOption) (*Event, error) {
	messageID, text, parsed, err := signedForward(body, headers, secret, opts)
	if err != nil {
		return nil, err
	}
	data := topLevelValue(text, "data")
	if !isEvent(parsed, eventType, stringFields) || data == nil {
		return nil, &Error{CodeInvalidPayload, "the body is not an " + eventType + " event"}
	}
	created, _ := parsed.(jsonx.Object).Get("timestamp")
	return &Event{ID: messageID, Type: eventType, Timestamp: created.(string), Data: data}, nil
}

// signedForward checks the Standard Webhooks headers of a forwarded delivery
// and parses its body as JSON. It returns the webhook-id, the body as text
// and the parsed value.
func signedForward(body []byte, headers Headers, secret string, opts []ForwardOption) (string, []byte, any, error) {
	if secret == "" {
		return "", nil, nil, errors.New("verify: forwarding verification requires a non-empty secret")
	}
	if _, err := sigutil.StandardWebhookKey(secret); err != nil {
		return "", nil, nil, fmt.Errorf("verify: forwarding secret: %w", err)
	}
	config := forwardConfig{tolerance: 5 * time.Minute}
	for _, opt := range opts {
		opt(&config)
	}
	if config.now.IsZero() {
		config.now = time.Now()
	}

	messageID := header(headers, "webhook-id")
	timestampHeader := header(headers, "webhook-timestamp")
	signatureHeader := header(headers, "webhook-signature")
	if messageID == "" || timestampHeader == "" || signatureHeader == "" {
		return "", nil, nil, &Error{CodeMissingHeaders, "missing webhook-id, webhook-timestamp or webhook-signature header"}
	}

	timestamp := jsNumber(timestampHeader)
	clock := float64(config.now.UnixNano()) / 1e9
	tolerance := config.tolerance.Seconds()
	if math.IsNaN(timestamp) || math.IsInf(timestamp, 0) || math.Abs(clock-timestamp) > tolerance {
		return "", nil, nil, &Error{CodeTimestampOutOfRange, "webhook-timestamp is more than " + strconv.FormatFloat(tolerance, 'f', -1, 64) + " seconds from now"}
	}
	if valid, err := standardWebhook(body, headers, secret); err != nil {
		return "", nil, nil, err
	} else if !valid {
		return "", nil, nil, &Error{CodeInvalidSignature, "the webhook-signature does not match the body and secret"}
	}

	text := []byte(bodyText(body))
	parsed, err := jsonx.Parse(text)
	if err != nil {
		return "", nil, nil, &Error{CodeInvalidPayload, "the body is not JSON"}
	}
	return messageID, text, parsed, nil
}

// topLevelValue returns the raw JSON of a key of the top-level object, the
// last one when it repeats (as JSON.parse keeps it). Keys match exactly,
// unlike encoding/json's struct fields.
func topLevelValue(text []byte, key string) json.RawMessage {
	decoder := json.NewDecoder(bytes.NewReader(text))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	var found json.RawMessage
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}
		if name, _ := token.(string); name == key {
			found = value
		}
	}
	return found
}

// isEvent checks the shape the other SDKs check: the type, a string
// timestamp, and data with string fields and headers as an object or array.
func isEvent(value any, eventType string, stringFields []string) bool {
	object, ok := value.(jsonx.Object)
	if !ok {
		return false
	}
	if typ, _ := object.Get("type"); typ != eventType {
		return false
	}
	if timestamp, _ := object.Get("timestamp"); !isString(timestamp) {
		return false
	}
	dataValue, _ := object.Get("data")
	data, ok := dataValue.(jsonx.Object)
	if !ok {
		return false
	}
	for _, field := range stringFields {
		if value, _ := data.Get(field); !isString(value) {
			return false
		}
	}
	switch headers, _ := data.Get("headers"); headers.(type) {
	case jsonx.Object, []any:
		return true
	}
	return false
}

func isString(value any) bool {
	_, ok := value.(string)
	return ok
}

// RelayedRequest verifies that a request reached you through webhooks.cc
// forwarding as it was received.
//
// webhooks-cc-signature is v1, and the base64 HMAC-SHA256, keyed with the
// endpoint's whsec_ secret, of the request id, a dot, the received-at time,
// a dot, and the exact body bytes. There is no age limit: a retry a day later
// carries the original received-at time, so remember RequestID to ignore
// repeats. Failures are *Error values with CodeMissingHeaders or
// CodeInvalidSignature; a secret with no key is ErrEmptyKey.
func RelayedRequest(body []byte, headers Headers, secret string) (*Relayed, error) {
	if secret == "" {
		return nil, errors.New("verify: forwarding verification requires a non-empty secret")
	}
	key, err := sigutil.StandardWebhookKey(secret)
	if err != nil {
		return nil, fmt.Errorf("verify: forwarding secret: %w", err)
	}
	requestID := header(headers, "webhooks-cc-request-id")
	receivedAt := header(headers, "webhooks-cc-received-at")
	signatureHeader := header(headers, "webhooks-cc-signature")
	if requestID == "" || receivedAt == "" || signatureHeader == "" {
		return nil, &Error{CodeMissingHeaders, "missing webhooks-cc-request-id, webhooks-cc-received-at or webhooks-cc-signature header"}
	}
	expected := hmacSHA256Base64(key, concat([]byte(requestID+"."+receivedAt+"."), body))
	if !slices.ContainsFunc(standardSignatures(signatureHeader), func(given string) bool { return safeEqual(given, expected) }) {
		return nil, &Error{CodeInvalidSignature, "the webhooks-cc-signature does not match the body and secret"}
	}
	relayed := &Relayed{RequestID: requestID, ReceivedAt: receivedAt, Endpoint: header(headers, "webhooks-cc-endpoint")}
	if attempt := jsNumber(header(headers, "webhooks-cc-attempt")); attempt > 0 && attempt == math.Trunc(attempt) && attempt <= math.MaxInt32 {
		relayed.Attempt = int(attempt)
	}
	return relayed, nil
}
