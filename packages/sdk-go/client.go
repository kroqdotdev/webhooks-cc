package webhookscc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/templates"
)

// Defaults and the environment variables New reads.
const (
	DefaultBaseURL    = "https://webhooks.cc"
	DefaultWebhookURL = "https://go.webhooks.cc"

	APIKeyEnv     = "WHK_API_KEY"
	BaseURLEnv    = "WHK_BASE_URL"
	WebhookURLEnv = "WHK_WEBHOOK_URL"
)

const (
	defaultTimeout = 30 * time.Second
	// maxResponseBody caps what a send reads of the response it gets back.
	maxResponseBody = 10 << 20
)

var allowedMethods = []string{"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"}

// Client is a webhooks.cc API client. It is safe for concurrent use.
type Client struct {
	apiKey      string
	baseURL     string
	webhookURL  string
	timeout     time.Duration
	retry       RetryOptions
	emailDomain string
	http        *http.Client

	// Endpoints creates, reads, changes and deletes endpoints.
	Endpoints *EndpointsService
	// Requests lists, waits for, streams and replays captured requests.
	Requests *RequestsService
	// Emails reads and waits for captured email.
	Emails *EmailsService
	// Forwarding reads and rotates forwarding signing secrets.
	Forwarding *ForwardingService
}

// RetryOptions controls how API calls are retried. By default they are not
// (MaxAttempts 1).
type RetryOptions struct {
	// MaxAttempts is the number of tries, the first included.
	MaxAttempts int
	// Backoff is the wait before the first retry, doubled for each further
	// one (default 1 second). A 429's Retry-After takes precedence.
	Backoff time.Duration
	// RetryOn lists the statuses to retry (default 429, 500, 502, 503 and 504).
	// Network errors and timeouts are always retried.
	RetryOn []int
}

// Option configures a Client.
type Option func(*Client)

// WithAPIKey sets the API key (default: the WHK_API_KEY environment variable).
func WithAPIKey(key string) Option { return func(c *Client) { c.apiKey = key } }

// WithBaseURL sets the API's base URL (default: WHK_BASE_URL, or https://webhooks.cc).
func WithBaseURL(baseURL string) Option { return func(c *Client) { c.baseURL = baseURL } }

// WithWebhookURL sets the capture host (default: WHK_WEBHOOK_URL, or https://go.webhooks.cc).
func WithWebhookURL(webhookURL string) Option {
	return func(c *Client) { c.webhookURL = webhookURL }
}

// WithTimeout sets the timeout of each API call and send (default 30 seconds).
func WithTimeout(timeout time.Duration) Option { return func(c *Client) { c.timeout = timeout } }

// WithRetry turns on retries for API calls.
func WithRetry(retry RetryOptions) Option { return func(c *Client) { c.retry = retry } }

// WithEmailDomain sets the domain of endpoint email addresses (default mailhooks.cc).
func WithEmailDomain(domain string) Option { return func(c *Client) { c.emailDomain = domain } }

// WithHTTPClient sets the HTTP client to send with. The SDK never follows
// redirects, whatever the client's CheckRedirect says, so an API key or a
// signed request only reaches the host it was meant for.
func WithHTTPClient(client *http.Client) Option { return func(c *Client) { c.http = client } }

// New returns a client. Without WithAPIKey it reads WHK_API_KEY, and fails
// when neither is set.
func New(opts ...Option) (*Client, error) {
	c := &Client{
		apiKey:      os.Getenv(APIKeyEnv),
		baseURL:     envOr(BaseURLEnv, DefaultBaseURL),
		webhookURL:  envOr(WebhookURLEnv, DefaultWebhookURL),
		timeout:     defaultTimeout,
		emailDomain: DefaultEmailDomain,
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.apiKey == "" {
		return nil, ErrMissingAPIKey
	}
	if c.timeout <= 0 {
		return nil, errors.New("webhooks.cc: the timeout must be positive")
	}
	c.baseURL = strings.TrimRight(c.baseURL, "/")
	c.webhookURL = strings.TrimRight(c.webhookURL, "/")
	if c.retry.MaxAttempts < 1 {
		c.retry.MaxAttempts = 1
	}
	if c.retry.Backoff <= 0 {
		c.retry.Backoff = time.Second
	}
	if c.retry.RetryOn == nil {
		c.retry.RetryOn = []int{429, 500, 502, 503, 504}
	}
	// A copy that never follows redirects, so the caller's client is left alone.
	var base http.Client
	if c.http != nil {
		base = *c.http
	}
	base.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	c.http = &base

	c.Endpoints = &EndpointsService{c: c}
	c.Requests = &RequestsService{c: c}
	c.Emails = &EmailsService{c: c}
	c.Forwarding = &ForwardingService{c: c}
	return c, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

var userAgent = "webhooks-cc-go/" + Version

// api calls an API route and decodes the JSON response into out (when not nil).
func (c *Client) api(ctx context.Context, method, path string, query url.Values, body, out any) error {
	endpoint := c.baseURL + "/api" + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	for attempt := 1; ; attempt++ {
		backoff := c.retry.Backoff << (attempt - 1)
		more := attempt < c.retry.MaxAttempts
		response, err := c.apiOnce(ctx, method, endpoint, payload)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if more {
				if err := sleep(ctx, backoff); err != nil {
					return err
				}
				continue
			}
			return err
		}
		if response.status >= 300 {
			apiErr := errorFromResponse(response)
			if more && slices.Contains(c.retry.RetryOn, response.status) {
				wait := backoff
				if apiErr.RetryAfter > 0 {
					wait = apiErr.RetryAfter
				}
				if err := sleep(ctx, wait); err != nil {
					return err
				}
				continue
			}
			return apiErr
		}
		if out == nil || response.status == http.StatusNoContent || len(response.body) == 0 {
			return nil
		}
		if contentType := response.header.Get("Content-Type"); contentType != "" && !strings.Contains(contentType, "application/json") {
			return &Error{StatusCode: response.status, Message: "unexpected content type: " + contentType}
		}
		if err := json.Unmarshal(response.body, out); err != nil {
			return fmt.Errorf("webhooks.cc: reading the response: %w", err)
		}
		return nil
	}
}

type apiResponse struct {
	status int
	header http.Header
	body   []byte
}

func (c *Client) apiOnce(ctx context.Context, method, endpoint string, payload []byte) (*apiResponse, error) {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(callCtx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", userAgent)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, c.timeoutOr(ctx, callCtx, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, c.timeoutOr(ctx, callCtx, err)
	}
	return &apiResponse{status: response.StatusCode, header: response.Header, body: data}, nil
}

// timeoutOr turns an error caused by the per-call timeout into a TimeoutError.
func (c *Client) timeoutOr(parent, call context.Context, err error) error {
	if parent.Err() == nil && errors.Is(call.Err(), context.DeadlineExceeded) {
		return &TimeoutError{After: c.timeout}
	}
	return err
}

var leadingDigits = regexp.MustCompile(`^\s*(\d+)`)

func intHeader(header http.Header, name string) (int64, bool) {
	match := leadingDigits.FindStringSubmatch(header.Get(name))
	if match == nil {
		return 0, false
	}
	value, err := strconv.ParseInt(match[1], 10, 64)
	return value, err == nil
}

func errorFromResponse(response *apiResponse) *Error {
	message := string(response.body)
	if utf8.RuneCountInString(message) > 200 {
		message = string([]rune(message)[:200]) + "..."
	}
	generic := len(message) < 30
	apiErr := &Error{StatusCode: response.status, Message: message}
	switch response.status {
	case http.StatusUnauthorized:
		if generic {
			apiErr.Message = strings.TrimSpace(message + " Get an API key at https://webhooks.cc/account/api-keys")
		}
	case http.StatusNotFound:
		if generic {
			apiErr.Message = strings.TrimSpace(message + " Use Endpoints.List to see your endpoints")
		}
	case http.StatusTooManyRequests:
		if seconds, ok := intHeader(response.header, "Retry-After"); ok {
			apiErr.RetryAfter = time.Duration(seconds) * time.Second
		}
		limit, okLimit := intHeader(response.header, "X-RateLimit-Limit")
		remaining, okRemaining := intHeader(response.header, "X-RateLimit-Remaining")
		reset, okReset := intHeader(response.header, "X-RateLimit-Reset")
		if okLimit && okRemaining && okReset {
			apiErr.RateLimit = &RateLimit{Limit: int(limit), Remaining: int(remaining), Reset: reset}
		}
		if apiErr.RetryAfter > 0 {
			apiErr.Message = fmt.Sprintf("rate limited, retry after %s", apiErr.RetryAfter)
		} else {
			apiErr.Message = "rate limited"
		}
	}
	return apiErr
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Usage returns the requests used and left in the current period.
func (c *Client) Usage(ctx context.Context) (*Usage, error) {
	var usage Usage
	if err := c.api(ctx, http.MethodGet, "/usage", nil, nil, &usage); err != nil {
		return nil, err
	}
	return &usage, nil
}

// --- sending -----------------------------------------------------------------------

// SendOptions describes a request for SendTo, BuildRequest and Endpoints.Send.
//
// With Provider, the request is signed the way that provider signs its
// webhooks (Secret is required unless the provider does not sign), and a nil
// Body sends the provider's sample payload for Template (or its default).
type SendOptions struct {
	// Provider is a TemplateProviders name, such as "stripe" or "github".
	Provider string
	Secret   string
	// Body is sent as it is when it is a string, []byte or json.RawMessage,
	// and as JSON otherwise.
	Body any
	// Headers are added last and override the ones the SDK sets.
	Headers map[string]string
	// Method defaults to POST.
	Method string
	// Template picks one of the provider's sample payloads.
	Template string
	// Event sets the event name, for providers that send one.
	Event string
	// Timestamp and MessageID make signatures repeatable in tests. A zero
	// Timestamp means now.
	Timestamp time.Time
	MessageID string
}

// BuiltRequest is a request built but not sent: what SendTo would send.
type BuiltRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
}

// Response is what a send got back. The body is read in full, up to 10 MiB.
type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// BuildRequest returns what SendTo would send, signatures included, without
// sending it.
func BuildRequest(target string, opts SendOptions) (*BuiltRequest, error) {
	if err := validateURL(target, "URL"); err != nil {
		return nil, err
	}
	if opts.Provider != "" {
		info, ok := templates.Lookup(opts.Provider)
		if (!ok || info.SecretRequired) && opts.Secret == "" {
			return nil, fmt.Errorf("webhooks.cc: provider %q needs a non-empty secret", opts.Provider)
		}
		built, err := templates.Build(target, templates.Params{
			Provider:  opts.Provider,
			Secret:    opts.Secret,
			Template:  opts.Template,
			Event:     opts.Event,
			Body:      opts.Body,
			Method:    opts.Method,
			Headers:   opts.Headers,
			Timestamp: opts.Timestamp,
			MessageID: opts.MessageID,
		})
		if err != nil {
			return nil, fmt.Errorf("webhooks.cc: %w", err)
		}
		return &BuiltRequest{Method: built.Method, URL: built.URL, Headers: built.Headers, Body: built.Body}, nil
	}
	method, err := checkMethod(opts.Method)
	if err != nil {
		return nil, err
	}
	headers := maps.Clone(opts.Headers)
	if headers == nil {
		headers = map[string]string{}
	}
	var body []byte
	if opts.Body != nil {
		if body, err = bodyBytes(opts.Body); err != nil {
			return nil, err
		}
		if !hasHeader(headers, "Content-Type") {
			headers["Content-Type"] = "application/json"
		}
	}
	return &BuiltRequest{Method: method, URL: target, Headers: headers, Body: body}, nil
}

// SendTo sends a webhook straight to any URL, signed the way opts.Provider
// signs them: for testing your own handler, on localhost or anywhere else,
// without going through webhooks.cc. Redirects are not followed.
func (c *Client) SendTo(ctx context.Context, target string, opts SendOptions) (*Response, error) {
	built, err := BuildRequest(target, opts)
	if err != nil {
		return nil, err
	}
	return c.send(ctx, built.Method, built.URL, built.Headers, built.Body)
}

// send sends a request as it is and reads the response. It never follows a
// redirect: signatures and captured headers must only reach the host named.
func (c *Client) send(ctx context.Context, method, target string, headers map[string]string, body []byte) (*Response, error) {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(callCtx, method, target, reader)
	if err != nil {
		return nil, err
	}
	for name, value := range headers {
		if strings.EqualFold(name, "Host") {
			request.Host = value
			continue
		}
		request.Header.Set(name, value)
	}
	if request.Header.Get("User-Agent") == "" {
		request.Header.Set("User-Agent", userAgent)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, c.timeoutOr(ctx, callCtx, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody))
	if err != nil {
		return nil, c.timeoutOr(ctx, callCtx, err)
	}
	return &Response{StatusCode: response.StatusCode, Header: response.Header, Body: data}, nil
}

// bodyBytes returns a body to send as it is: strings, []byte and
// json.RawMessage unchanged, anything else as JSON.
func bodyBytes(body any) ([]byte, error) {
	switch body := body.(type) {
	case string:
		return []byte(body), nil
	case []byte:
		return body, nil
	case json.RawMessage:
		return body, nil
	}
	text, err := jsonx.Stringify(body)
	if err != nil {
		return nil, fmt.Errorf("webhooks.cc: encoding the body: %w", err)
	}
	return []byte(text), nil
}

func hasHeader(headers map[string]string, name string) bool {
	for key := range headers {
		if strings.EqualFold(key, name) {
			return true
		}
	}
	return false
}

func checkMethod(method string) (string, error) {
	if method == "" {
		return http.MethodPost, nil
	}
	upper := strings.ToUpper(method)
	if !slices.Contains(allowedMethods, upper) {
		return "", fmt.Errorf("webhooks.cc: invalid HTTP method %q: must be one of %s", method, strings.Join(allowedMethods, ", "))
	}
	return upper, nil
}

var safeSegment = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func validateSegment(value, name string) error {
	if !safeSegment.MatchString(value) {
		return fmt.Errorf("webhooks.cc: invalid %s %q: use only letters, digits, hyphens and underscores", name, value)
	}
	return nil
}

func validateURL(target, name string) error {
	parsed, err := url.Parse(target)
	if err != nil {
		return fmt.Errorf("webhooks.cc: invalid %s %q: %w", name, target, err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("webhooks.cc: invalid %s %q: only http and https URLs are supported", name, target)
	}
	return nil
}

// TemplateProviderInfo describes a provider's sample payloads and how its
// requests are signed.
type TemplateProviderInfo struct {
	Provider string
	// Templates are the sample payloads the provider offers.
	Templates []string
	// DefaultTemplate is used when SendOptions.Template is empty.
	DefaultTemplate string
	// SecretRequired reports whether signing needs a secret.
	SecretRequired bool
	// SignatureHeader carries the signature ("" when it travels in the body).
	SignatureHeader    string
	SignatureAlgorithm string
}

// TemplateProviders returns the providers SendTo and BuildRequest can sign for.
func TemplateProviders() []string { return templates.Providers() }

// TemplateProvider describes a provider, and reports whether it is known.
func TemplateProvider(provider string) (TemplateProviderInfo, bool) {
	info, ok := templates.Lookup(provider)
	if !ok {
		return TemplateProviderInfo{}, false
	}
	return TemplateProviderInfo(info), true
}
