package webhookscc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// DestinationsService manages where an endpoint's captures go: up to 10
// destinations per endpoint, each with its own URL, what it gets (HTTP
// requests, emails, and a filter of conditions), how it is sent (as
// received, signed JSON, a JSON template with {{ placeholders }}, a chat
// message, or emails in an inbound mail provider's shape), its own signing
// secret and headers, retries, order, and optional throttling and delay.
// Only the endpoint's owner can manage them. Use it as client.Destinations.
type DestinationsService struct{ c *Client }

// ListDestinationsOptions say what DestinationsService.List returns.
type ListDestinationsOptions struct {
	// Summary adds each destination's deliveries of the last 24 hours and
	// what is waiting now.
	Summary bool
}

// List returns the endpoint's destinations in order, header values masked.
func (s *DestinationsService) List(ctx context.Context, slug string, opts ListDestinationsOptions) ([]Destination, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	var query url.Values
	if opts.Summary {
		query = url.Values{"summary": {"true"}}
	}
	var destinations []Destination
	if err := s.c.api(ctx, http.MethodGet, "/endpoints/"+slug+"/destinations", query, nil, &destinations); err != nil {
		return nil, err
	}
	return destinations, nil
}

// Get returns one destination.
func (s *DestinationsService) Get(ctx context.Context, slug, destinationID string) (*Destination, error) {
	path, err := destinationPath(slug, destinationID)
	if err != nil {
		return nil, err
	}
	var destination Destination
	if err := s.c.api(ctx, http.MethodGet, path, nil, nil, &destination); err != nil {
		return nil, err
	}
	return &destination, nil
}

// DestinationInput holds the fields of a destination to create or change.
// Only the fields set with Value or Null are sent. Null clears Name, Filter,
// BodyTemplate, MessageTemplate, SentField and MailgunSigningKey; the others
// only take Value. DestinationsService.Create needs URL.
//
//	client.Destinations.Create(ctx, slug, webhookscc.DestinationInput{
//		URL:   webhookscc.Value("https://hooks.example.com/invoices"),
//		Email: webhookscc.Value(false),
//		Filter: webhookscc.Value(webhookscc.DestinationFilter{
//			Conditions: []webhookscc.ResponseRuleCondition{{Field: "body_path", Path: "type", Op: "eq", Value: "invoice.paid"}},
//		}),
//		Format:       webhookscc.Value(webhookscc.FormatTemplate),
//		BodyTemplate: webhookscc.Value(json.RawMessage(`{"invoice":"{{ json.data.object.id }}"}`)),
//	})
type DestinationInput struct {
	// URL is an https URL on a public host name, or a Slack or Discord
	// webhook.
	URL Field[string]
	// Name names it in the list and the delivery log.
	Name Field[string]
	// Enabled turns it on or off (default on).
	Enabled Field[bool]
	// HTTP and Email say which kinds it takes (default both).
	HTTP  Field[bool]
	Email Field[bool]
	// Format is how it sends (default FormatAuto). FormatPostmark,
	// FormatSendGrid, FormatMailgun and FormatCloudMailin send emails in that
	// provider's shape and HTTP requests as received.
	Format Field[DestinationFormat]
	// Filter sends only the captures its conditions match.
	Filter Field[DestinationFilter]
	// BodyTemplate is the JSON body FormatTemplate sends, its strings
	// holding {{ placeholders }} filled in from each request.
	BodyTemplate Field[json.RawMessage]
	// MessageTemplate is your own message text for FormatChat; Null sends
	// the standard message.
	MessageTemplate Field[string]
	// MailgunSigningKey is, for FormatMailgun, your Mailgun HTTP webhook
	// signing key, so the form's signature verifies. It is stored encrypted
	// and never returned (Destination.HasMailgunSigningKey says whether one
	// is saved); Null removes it.
	MailgunSigningKey Field[string]
	// Headers are your own headers, at most 10 (not for chat). They replace
	// the whole list.
	Headers Field[[]DestinationHeaderInput]
	// AppendPath adds the captured path to the URL for requests sent as
	// received (default true).
	AppendPath Field[bool]
	// Retry is how long failed deliveries are retried: 24 hours (default),
	// 1 hour, or 0 for one try.
	Retry Field[time.Duration]
	// KeepOrder sends one delivery at a time, in capture order.
	KeepOrder Field[bool]
	// SentField is a JSON body field with the sender's own timestamp, such
	// as "data.created".
	SentField Field[string]
	// Throttle sends at most one delivery per period, up to an hour; the
	// rest are not sent.
	Throttle Field[time.Duration]
	// Delay waits this long after a capture before sending, up to an hour.
	Delay Field[time.Duration]
	// Attachments is how the attachments of emails kept in storage travel:
	// AttachmentsLinks (default), AttachmentsInline or AttachmentsNone.
	Attachments Field[DestinationAttachments]
	// Position is its place in the list, from 0.
	Position Field[int]
}

// body is the input as the API takes it: the fields that are set, in
// camelCase. The filter's conditions are checked by the API.
func (in DestinationInput) body() (map[string]any, error) {
	for _, field := range []interface{ isNull() bool }{
		in.URL, in.Enabled, in.HTTP, in.Email, in.Format, in.Headers, in.AppendPath, in.Retry,
		in.KeepOrder, in.Throttle, in.Delay, in.Attachments, in.Position,
	} {
		if field.isNull() {
			return nil, errors.New("webhooks.cc: only Name, Filter, BodyTemplate, MessageTemplate, SentField and MailgunSigningKey can be cleared; set the others with Value")
		}
	}
	if in.Filter.IsSet() && !in.Filter.isNull() {
		if logic := in.Filter.value.Logic; logic != "" && logic != "and" && logic != "or" {
			return nil, fmt.Errorf(`webhooks.cc: the filter's Logic must be "and" or "or", not %q`, logic)
		}
	}
	body := map[string]any{}
	in.URL.put(body, "url")
	in.Name.put(body, "name")
	in.Enabled.put(body, "enabled")
	in.HTTP.put(body, "http")
	in.Email.put(body, "email")
	in.Format.put(body, "format")
	in.Filter.put(body, "filter")
	in.BodyTemplate.put(body, "bodyTemplate")
	in.MessageTemplate.put(body, "messageTemplate")
	in.MailgunSigningKey.put(body, "mailgunSigningKey")
	if in.Headers.IsSet() {
		headers := in.Headers.value
		if headers == nil {
			headers = []DestinationHeaderInput{}
		}
		body["headers"] = headers
	}
	in.AppendPath.put(body, "appendPath")
	in.KeepOrder.put(body, "keepOrder")
	in.SentField.put(body, "sentField")
	for _, setting := range []struct {
		name, key string
		field     Field[time.Duration]
	}{
		{"Retry", "retrySeconds", in.Retry},
		{"Throttle", "throttleSeconds", in.Throttle},
		{"Delay", "delaySeconds", in.Delay},
	} {
		if !setting.field.IsSet() {
			continue
		}
		if d := setting.field.value; d < 0 || d%time.Second != 0 {
			return nil, fmt.Errorf("webhooks.cc: %s must be a whole number of seconds, not %s", setting.name, d)
		}
		body[setting.key] = int64(setting.field.value / time.Second)
	}
	in.Attachments.put(body, "attachments")
	in.Position.put(body, "position")
	return body, nil
}

// Create adds a destination, up to 10 per endpoint. It is on unless Enabled
// is Value(false), and gets a signing secret of its own.
func (s *DestinationsService) Create(ctx context.Context, slug string, input DestinationInput) (*Destination, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	if !input.URL.IsSet() {
		return nil, errors.New("webhooks.cc: a new destination needs a URL")
	}
	body, err := input.body()
	if err != nil {
		return nil, err
	}
	var destination Destination
	if err := s.c.api(ctx, http.MethodPost, "/endpoints/"+slug+"/destinations", nil, body, &destination); err != nil {
		return nil, err
	}
	return &destination, nil
}

// Update changes a destination; only the fields set in input change.
// Switching it off or taking a kind away marks what is waiting for it as
// failed.
func (s *DestinationsService) Update(ctx context.Context, slug, destinationID string, input DestinationInput) (*Destination, error) {
	path, err := destinationPath(slug, destinationID)
	if err != nil {
		return nil, err
	}
	body, err := input.body()
	if err != nil {
		return nil, err
	}
	var destination Destination
	if err := s.c.api(ctx, http.MethodPatch, path, nil, body, &destination); err != nil {
		return nil, err
	}
	return &destination, nil
}

// Delete removes a destination. What is still waiting for it is marked
// failed; its delivery log stays.
func (s *DestinationsService) Delete(ctx context.Context, slug, destinationID string) error {
	path, err := destinationPath(slug, destinationID)
	if err != nil {
		return err
	}
	return s.c.api(ctx, http.MethodDelete, path, nil, nil, nil)
}

// Reorder puts the destinations in this order (every id, once) and returns
// them. Captures are queued for destinations in this order.
func (s *DestinationsService) Reorder(ctx context.Context, slug string, destinationIDs []string) ([]Destination, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	if destinationIDs == nil {
		destinationIDs = []string{}
	}
	var destinations []Destination
	body := map[string]any{"ids": destinationIDs}
	if err := s.c.api(ctx, http.MethodPut, "/endpoints/"+slug+"/destinations/order", nil, body, &destinations); err != nil {
		return nil, err
	}
	return destinations, nil
}

// Secret returns the destination's whsec_ signing secret.
func (s *DestinationsService) Secret(ctx context.Context, slug, destinationID string) (string, error) {
	return s.secret(ctx, http.MethodGet, slug, destinationID)
}

// RotateSecret replaces the destination's signing secret and returns the new
// one. Every delivery from now on uses it.
func (s *DestinationsService) RotateSecret(ctx context.Context, slug, destinationID string) (string, error) {
	return s.secret(ctx, http.MethodPost, slug, destinationID)
}

func (s *DestinationsService) secret(ctx context.Context, method, slug, destinationID string) (string, error) {
	path, err := destinationPath(slug, destinationID)
	if err != nil {
		return "", err
	}
	var response struct {
		Secret string `json:"secret"`
	}
	if err := s.c.api(ctx, method, path+"/secret", nil, nil, &response); err != nil {
		return "", err
	}
	return response.Secret, nil
}

// TestDestinationOptions say what DestinationsService.Test sends. Both are
// optional.
type TestDestinationOptions struct {
	// Kind picks the newest request of that kind (default: a kind the
	// destination takes).
	Kind RequestKind
	// RequestID sends that captured request instead.
	RequestID string
}

// Test sends one delivery to the destination now, as a real one would go
// out: opts.RequestID, or the newest request of opts.Kind, or a sample when
// none has arrived. The filter is reported (FilterPasses), not applied;
// nothing is queued or retried.
func (s *DestinationsService) Test(ctx context.Context, slug, destinationID string, opts TestDestinationOptions) (*DestinationTestResult, error) {
	path, err := destinationPath(slug, destinationID)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if opts.Kind != "" {
		body["kind"] = opts.Kind
	}
	if opts.RequestID != "" {
		body["requestId"] = opts.RequestID
	}
	var result DestinationTestResult
	if err := s.c.api(ctx, http.MethodPost, path+"/test", nil, body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// PreviewDestinationOptions say what DestinationsService.Preview runs.
type PreviewDestinationOptions struct {
	// DestinationID is a saved destination to start from.
	DestinationID string
	// Destination holds unsaved fields, on top of the saved destination or
	// on their own (then with a URL).
	Destination DestinationInput
	// RequestID is a captured request on the endpoint. "" uses the newest of
	// a kind the destination takes, or a sample.
	RequestID string
}

// Preview is a dry run: whether a destination's filter lets a captured
// request through and the exact request it would send, for a saved
// destination, unsaved changes, or both. Nothing is sent.
//
//	preview, err := client.Destinations.Preview(ctx, slug, webhookscc.PreviewDestinationOptions{
//		DestinationID: destination.ID,
//		Destination:   webhookscc.DestinationInput{Format: webhookscc.Value(webhookscc.FormatJSON)},
//	})
func (s *DestinationsService) Preview(ctx context.Context, slug string, opts PreviewDestinationOptions) (*DestinationPreview, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return nil, err
	}
	destination, err := opts.Destination.body()
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if opts.DestinationID != "" {
		body["destinationId"] = opts.DestinationID
	}
	if len(destination) > 0 {
		body["destination"] = destination
	}
	if opts.RequestID != "" {
		body["requestId"] = opts.RequestID
	}
	var preview DestinationPreview
	if err := s.c.api(ctx, http.MethodPost, "/endpoints/"+slug+"/destinations/preview", nil, body, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}

func destinationPath(slug, destinationID string) (string, error) {
	if err := validateSegment(slug, "endpoint slug"); err != nil {
		return "", err
	}
	if err := validateSegment(destinationID, "destination ID"); err != nil {
		return "", err
	}
	return "/endpoints/" + slug + "/destinations/" + destinationID, nil
}
