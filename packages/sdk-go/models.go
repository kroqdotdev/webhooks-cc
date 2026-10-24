package webhookscc

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// RequestKind tells a captured HTTP request from a captured email.
type RequestKind string

// The kinds of captured request.
const (
	KindHTTP  RequestKind = "http"
	KindEmail RequestKind = "email"
)

// Headers are a captured request's headers. Get matches names in any case.
type Headers map[string]string

// Get returns the value of the header name, in any case, or "".
func (h Headers) Get(name string) string {
	if value, ok := h[name]; ok {
		return value
	}
	for key, value := range h {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

// Lookup returns the value of the header name, in any case, and whether it is present.
func (h Headers) Lookup(name string) (string, bool) {
	if value, ok := h[name]; ok {
		return value, true
	}
	for key, value := range h {
		if strings.EqualFold(key, name) {
			return value, true
		}
	}
	return "", false
}

// Request is a captured request: an HTTP webhook, or an email when Kind is
// KindEmail. For emails Method is "EMAIL" and Path is the address it was
// delivered to.
type Request struct {
	ID         string
	EndpointID string
	// Slug is the endpoint's slug, on search results (which carry no EndpointID).
	Slug        string
	Method      string
	Path        string
	Headers     Headers
	Body        string
	QueryParams map[string]string
	IP          string
	Size        int
	ReceivedAt  time.Time
	ContentType string
	// BodyRaw holds the body's exact bytes, base64-encoded, when they are not
	// valid UTF-8. BodyBytes decodes it.
	BodyRaw string
	// SignatureVerified is nil when webhooks.cc did not check a signature.
	SignatureVerified *bool
	SignatureError    string
	SigningProvider   string
	Kind              RequestKind
	// Email is the parsed message of a captured email.
	Email *EmailCapture
	// Extracts are the codes and links found in an email. They are set on
	// emails read through this client, unless the endpoint's "Show codes and
	// links found in emails" setting is off.
	Extracts *EmailExtracts
	// Raw is the JSON the request was read from.
	Raw json.RawMessage
}

// UnmarshalJSON reads a request as the API returns it.
func (r *Request) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	id := o.str("id")
	if id == "" {
		id = o.str("_id")
	}
	path, ok := o.strOK("path")
	if !ok {
		path = "/"
	}
	ip, ok := o.strOK("ip")
	if !ok {
		ip = "unknown"
	}
	*r = Request{
		ID:                id,
		EndpointID:        o.str("endpointId"),
		Slug:              o.str("slug"),
		Method:            o.str("method"),
		Path:              path,
		Headers:           Headers(o.strMap("headers")),
		Body:              o.str("body"),
		QueryParams:       o.strMap("queryParams"),
		IP:                ip,
		Size:              int(o.num("size")),
		ReceivedAt:        o.millis("receivedAt"),
		ContentType:       o.str("contentType"),
		BodyRaw:           o.str("bodyRaw"),
		SignatureVerified: o.optBool("signatureVerified"),
		SignatureError:    o.str("signatureError"),
		SigningProvider:   o.str("signingProvider"),
		Raw:               bytes.Clone(data),
	}
	if kind := RequestKind(o.str("kind")); kind == KindHTTP || kind == KindEmail {
		r.Kind = kind
	}
	if email := o.raw("email"); isJSONObject(email) {
		r.Email = new(EmailCapture)
		if err := json.Unmarshal(email, r.Email); err != nil {
			return err
		}
	}
	if extracts := o.raw("extracts"); isJSONObject(extracts) {
		r.Extracts = new(EmailExtracts)
		if err := json.Unmarshal(extracts, r.Extracts); err != nil {
			return err
		}
	}
	return nil
}

// MarshalJSON writes the request in the API's shape, so UnmarshalJSON reads
// it back.
func (r Request) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID                string            `json:"id"`
		EndpointID        string            `json:"endpointId,omitempty"`
		Slug              string            `json:"slug,omitempty"`
		Method            string            `json:"method"`
		Path              string            `json:"path"`
		Headers           Headers           `json:"headers"`
		Body              string            `json:"body"`
		QueryParams       map[string]string `json:"queryParams"`
		IP                string            `json:"ip"`
		Size              int               `json:"size"`
		ReceivedAt        *int64            `json:"receivedAt,omitempty"`
		ContentType       string            `json:"contentType,omitempty"`
		BodyRaw           string            `json:"bodyRaw,omitempty"`
		SignatureVerified *bool             `json:"signatureVerified,omitempty"`
		SignatureError    string            `json:"signatureError,omitempty"`
		SigningProvider   string            `json:"signingProvider,omitempty"`
		Kind              RequestKind       `json:"kind,omitempty"`
		Email             *EmailCapture     `json:"email,omitempty"`
		Extracts          *EmailExtracts    `json:"extracts,omitempty"`
	}{
		r.ID, r.EndpointID, r.Slug, r.Method, r.Path, r.Headers, r.Body, r.QueryParams, r.IP, r.Size,
		millisOf(r.ReceivedAt), r.ContentType, r.BodyRaw, r.SignatureVerified, r.SignatureError,
		r.SigningProvider, r.Kind, r.Email, r.Extracts,
	})
}

// millisOf is t in milliseconds since the epoch, or nil for the zero time.
func millisOf(t time.Time) *int64 {
	if t.IsZero() {
		return nil
	}
	ms := t.UnixMilli()
	return &ms
}

// Header returns the value of a header, in any case, or "".
func (r *Request) Header(name string) string { return r.Headers.Get(name) }

// BodyBytes returns the body's exact bytes, decoding BodyRaw when it is set.
func (r *Request) BodyBytes() []byte {
	if r.BodyRaw != "" {
		if raw, err := base64.StdEncoding.DecodeString(r.BodyRaw); err == nil {
			return raw
		}
	}
	return []byte(r.Body)
}

// JSON unmarshals the body into v.
func (r *Request) JSON(v any) error { return json.Unmarshal([]byte(r.Body), v) }

// IsEmail reports whether the request is a captured email, whether or not it
// carries its parsed message.
func (r *Request) IsEmail() bool {
	return r.Kind == KindEmail || (r.Kind == "" && r.Method == "EMAIL" && !strings.HasPrefix(r.Path, "/"))
}

// EmailAddress is a name and address from an email's headers.
type EmailAddress struct {
	Name    string `json:"name,omitempty"`
	Address string `json:"address"`
}

// UnmarshalJSON reads an address as the API returns it.
func (a *EmailAddress) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*a = EmailAddress{Name: o.str("name"), Address: o.str("address")}
	return nil
}

func (a EmailAddress) String() string {
	if a.Name != "" {
		return a.Name + " <" + a.Address + ">"
	}
	return a.Address
}

// EmailAttachment describes an attachment of a captured email.
type EmailAttachment struct {
	Filename    string `json:"filename,omitempty"`
	ContentType string `json:"contentType"`
	Size        int    `json:"size"`
	ContentID   string `json:"contentId,omitempty"`
	Inline      bool   `json:"inline"`
}

// UnmarshalJSON reads an attachment as the API returns it.
func (a *EmailAttachment) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	contentType := o.str("contentType")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	*a = EmailAttachment{
		Filename:    o.str("filename"),
		ContentType: contentType,
		Size:        int(o.num("size")),
		ContentID:   o.str("contentId"),
		Inline:      o.boolean("inline"),
	}
	return nil
}

// EmailCapture is the parsed message of a captured email. Auth (SPF, DKIM,
// DMARC), Spam (rspamd's verdict) and SMTP are kept as the API sends them.
type EmailCapture struct {
	Subject   string         `json:"subject,omitempty"`
	From      []EmailAddress `json:"from"`
	To        []EmailAddress `json:"to"`
	Cc        []EmailAddress `json:"cc"`
	ReplyTo   []EmailAddress `json:"replyTo"`
	Sender    []EmailAddress `json:"sender"`
	Date      string         `json:"date,omitempty"`
	MessageID string         `json:"messageId,omitempty"`
	InReplyTo []string       `json:"inReplyTo"`
	// Tag is the +tag of the address it was sent to, or "".
	Tag          string            `json:"tag,omitempty"`
	Text         string            `json:"text,omitempty"`
	HTML         string            `json:"html,omitempty"`
	TextFromHTML bool              `json:"textFromHtml"`
	Attachments  []EmailAttachment `json:"attachments"`
	Auth         json.RawMessage   `json:"auth,omitempty"`
	Spam         json.RawMessage   `json:"spam,omitempty"`
	SMTP         json.RawMessage   `json:"smtp,omitempty"`
	ParseError   bool              `json:"parseError"`
	Truncated    map[string]bool   `json:"truncated"`
	// Raw is the JSON the email was read from.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads an email as the API returns it.
func (e *EmailCapture) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*e = EmailCapture{
		Subject:      o.str("subject"),
		From:         o.addresses("from"),
		To:           o.addresses("to"),
		Cc:           o.addresses("cc"),
		ReplyTo:      o.addresses("replyTo"),
		Sender:       o.addresses("sender"),
		Date:         o.str("date"),
		MessageID:    o.str("messageId"),
		InReplyTo:    o.strList("inReplyTo"),
		Tag:          o.str("tag"),
		Text:         o.str("text"),
		HTML:         o.str("html"),
		TextFromHTML: o.boolean("textFromHtml"),
		ParseError:   o.boolean("parseError"),
		Truncated:    map[string]bool{},
		Raw:          bytes.Clone(data),
	}
	for _, item := range o.array("attachments") {
		if isJSONObject(item) {
			var attachment EmailAttachment
			if err := json.Unmarshal(item, &attachment); err == nil {
				e.Attachments = append(e.Attachments, attachment)
			}
		}
	}
	for _, key := range []string{"auth", "spam", "smtp"} {
		if value := o.raw(key); isJSONObject(value) {
			switch key {
			case "auth":
				e.Auth = bytes.Clone(value)
			case "spam":
				e.Spam = bytes.Clone(value)
			case "smtp":
				e.SMTP = bytes.Clone(value)
			}
		}
	}
	if truncated := o.object("truncated"); truncated != nil {
		for key := range truncated {
			e.Truncated[key] = truncated.boolean(key)
		}
	}
	return nil
}

// ExtractedLink is a link found in an email.
type ExtractedLink struct {
	URL string `json:"url"`
	// Label is the link text, when the link came from HTML.
	Label string `json:"label,omitempty"`
	// Action reports whether the link looks like what the email asks you to
	// click (confirm, verify, reset, sign in).
	Action bool `json:"action"`
}

// EmailExtracts are the one-time codes and links found in an email, at most
// 20 of each. Codes are in order of appearance, subject first; links come best
// first.
type EmailExtracts struct {
	Codes []string        `json:"codes"`
	Links []ExtractedLink `json:"links"`
}

// UnmarshalJSON reads extracts as the API returns them.
func (x *EmailExtracts) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*x = EmailExtracts{Codes: o.strList("codes")}
	for _, item := range o.array("links") {
		var link rawObject
		if json.Unmarshal(item, &link) != nil || link == nil {
			continue
		}
		url, ok := link.strOK("url")
		if !ok {
			continue
		}
		x.Links = append(x.Links, ExtractedLink{URL: url, Label: link.str("label"), Action: link.boolean("action")})
	}
	return nil
}

// TeamShare is a team an endpoint is shared with or through.
type TeamShare struct {
	TeamID   string `json:"teamId"`
	TeamName string `json:"teamName"`
}

// UnmarshalJSON reads a team share as the API returns it.
func (s *TeamShare) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*s = TeamShare{TeamID: o.str("teamId"), TeamName: o.str("teamName")}
	return nil
}

// MockResponse is what an endpoint answers instead of the default 200 OK.
type MockResponse struct {
	// Status is the HTTP status (100 to 599).
	Status int
	// Body may hold {{ placeholders }} the receiver fills in from the request,
	// such as {{ json.id }}, {{ headers.user-agent }} or {{ uuid }}; see
	// https://webhooks.cc/docs/mock-responses#placeholders.
	Body string
	// Headers are sent with the response; their values may hold placeholders
	// too.
	Headers map[string]string
	// Delay holds the response back, up to 30 seconds.
	Delay time.Duration
}

type mockResponseJSON struct {
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"`
	Delay   *int64            `json:"delay,omitempty"`
}

// MarshalJSON writes the mock response as the API expects it, the delay in milliseconds.
func (m MockResponse) MarshalJSON() ([]byte, error) {
	wire := mockResponseJSON{Status: m.Status, Body: m.Body, Headers: m.Headers}
	if wire.Headers == nil {
		wire.Headers = map[string]string{}
	}
	if m.Delay > 0 {
		delay := m.Delay.Milliseconds()
		wire.Delay = &delay
	}
	return json.Marshal(wire)
}

// UnmarshalJSON reads a mock response as the API returns it.
func (m *MockResponse) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*m = MockResponse{
		Status:  int(o.num("status")),
		Body:    o.str("body"),
		Headers: o.strMap("headers"),
		Delay:   time.Duration(o.num("delay") * float64(time.Millisecond)),
	}
	return nil
}

// ResponseRule answers with Response when its conditions match. An
// endpoint's rules are tried in order and the first match wins (at most 50
// rules).
type ResponseRule struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Enabled *bool  `json:"enabled,omitempty"`
	// Logic is "and" (every condition, the default) or "or" (any).
	Logic string `json:"logic,omitempty"`
	// Conditions are 1 to 10 conditions.
	Conditions []ResponseRuleCondition `json:"conditions"`
	Response   MockResponse            `json:"response"`
}

// ResponseRuleCondition is one condition of a response rule: it reads Field
// of the request and compares it with Value using Op. The fields and the ops
// each one takes:
//
//   - method: eq, neq
//   - path: eq, neq, contains, not_contains, starts_with, ends_with, matches
//     (a glob, as in MatchPath) and regex (RE2 syntax)
//   - header and query (with Name), body_path (with Path): exists,
//     not_exists, the path ops, and gt, gte, lt, lte
//   - body: contains, not_contains, regex
//   - body_contains: contains
//   - content_type: eq, neq, contains, not_contains, starts_with, regex
//   - size (in bytes): eq, neq, gt, gte, lt, lte
//
// gt, gte, lt and lte compare numbers, so their Value must be one; matches
// and regex patterns are at most 500 characters. The API refuses rules that
// break these limits; try rules before saving them with
// EndpointsService.PreviewResponse.
type ResponseRuleCondition struct {
	// Field is the part of the request the condition reads.
	Field string `json:"field"`
	// Op is how it compares.
	Op string `json:"op"`
	// Value is sent for every op, since all but exists and not_exists
	// require one (even "").
	Value string `json:"value"`
	// Name is the header or query parameter, for header and query conditions.
	Name string `json:"name,omitempty"`
	// Path is the dot path into the JSON (or form) body, such as
	// data.items.0.id, for body_path conditions.
	Path string `json:"path,omitempty"`
}

// ResponsePreview is what EndpointsService.PreviewResponse reports: what a
// sender would get back for a request.
type ResponsePreview struct {
	// Rule is the rule that answers, or nil when the default response does.
	Rule *PreviewRule
	// Response is the response with its placeholders filled in; nil means
	// the receiver's plain 200 OK.
	Response *MockResponse
	// UnknownPlaceholders are placeholders the request has no field for;
	// they are sent as written.
	UnknownPlaceholders []string
	// Email is true for an email: emails get a standard mail-server reply,
	// never a mock response.
	Email bool
	// Request is the request the preview ran against.
	Request PreviewRequest
	// Raw is the JSON the preview was read from.
	Raw json.RawMessage
}

// PreviewRule is the response rule that answers a preview.
type PreviewRule struct {
	// Index is the rule's position in the rules, from 0.
	Index int
	Name  string
}

// PreviewRequest is the request a preview ran against.
type PreviewRequest struct {
	// ID is "" when no request was captured yet and a sample was used.
	ID         string
	Method     string
	Path       string
	ReceivedAt time.Time
	// Sample is true when no request was captured yet, so a sample was used.
	Sample bool
}

// UnmarshalJSON reads a preview as the API returns it.
func (p *ResponsePreview) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	request := o.object("request")
	*p = ResponsePreview{
		UnknownPlaceholders: o.strList("unknownPlaceholders"),
		Email:               o.boolean("email"),
		Request: PreviewRequest{
			ID:         request.str("id"),
			Method:     request.str("method"),
			Path:       request.str("path"),
			ReceivedAt: request.millis("receivedAt"),
			Sample:     request.boolean("sample"),
		},
		Raw: bytes.Clone(data),
	}
	if rule := o.object("rule"); rule != nil {
		p.Rule = &PreviewRule{Index: int(rule.num("index")), Name: rule.str("name")}
	}
	if response := o.raw("response"); isJSONObject(response) {
		p.Response = new(MockResponse)
		if err := json.Unmarshal(response, p.Response); err != nil {
			return err
		}
	}
	return nil
}

// MarshalJSON writes the preview in the API's shape, so UnmarshalJSON reads
// it back.
func (p ResponsePreview) MarshalJSON() ([]byte, error) {
	type wireRule struct {
		Index int     `json:"index"`
		Name  *string `json:"name"`
	}
	type wireRequest struct {
		ID         *string `json:"id"`
		Method     string  `json:"method"`
		Path       string  `json:"path"`
		ReceivedAt *int64  `json:"receivedAt"`
		Sample     bool    `json:"sample"`
	}
	var rule *wireRule
	if p.Rule != nil {
		rule = &wireRule{Index: p.Rule.Index, Name: nonEmpty(p.Rule.Name)}
	}
	placeholders := p.UnknownPlaceholders
	if placeholders == nil {
		placeholders = []string{}
	}
	return json.Marshal(struct {
		Rule                *wireRule     `json:"rule"`
		Response            *MockResponse `json:"response"`
		UnknownPlaceholders []string      `json:"unknownPlaceholders"`
		Email               bool          `json:"email"`
		Request             wireRequest   `json:"request"`
	}{rule, p.Response, placeholders, p.Email, wireRequest{
		ID: nonEmpty(p.Request.ID), Method: p.Request.Method, Path: p.Request.Path,
		ReceivedAt: millisOf(p.Request.ReceivedAt), Sample: p.Request.Sample,
	}})
}

// nonEmpty is s, or nil (JSON null) for "".
func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Endpoint is a webhook endpoint. It captures requests at URL and email at
// EmailAddress.
type Endpoint struct {
	ID           string
	Slug         string
	Name         string
	URL          string
	EmailAddress string
	CreatedAt    time.Time
	IsEphemeral  bool
	// ExpiresAt is zero for an endpoint that does not expire.
	ExpiresAt         time.Time
	NotificationURL   string
	MockResponse      *MockResponse
	ResponseRules     []ResponseRule
	SigningProvider   string
	HasSigningSecret  bool
	ShowEmailExtracts *bool
	ForwardEnabled    *bool
	ForwardURL        string
	SharedWith        []TeamShare
	FromTeams         []TeamShare
	// Raw is the JSON the endpoint was read from.
	Raw json.RawMessage
}

// UnmarshalJSON reads an endpoint as the API returns it.
func (e *Endpoint) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*e = Endpoint{
		ID:                o.str("id"),
		Slug:              o.str("slug"),
		Name:              o.str("name"),
		URL:               o.str("url"),
		EmailAddress:      o.str("emailAddress"),
		CreatedAt:         o.millis("createdAt"),
		IsEphemeral:       o.boolean("isEphemeral"),
		ExpiresAt:         o.millis("expiresAt"),
		NotificationURL:   o.str("notificationUrl"),
		SigningProvider:   o.str("signingProvider"),
		HasSigningSecret:  o.boolean("hasSigningSecret"),
		ShowEmailExtracts: o.optBool("showEmailExtracts"),
		ForwardEnabled:    o.optBool("forwardEnabled"),
		ForwardURL:        o.str("forwardUrl"),
		SharedWith:        o.teams("sharedWith"),
		FromTeams:         o.teams("fromTeams"),
		Raw:               bytes.Clone(data),
	}
	if e.FromTeams == nil {
		if team := o.raw("fromTeam"); isJSONObject(team) {
			var share TeamShare
			if json.Unmarshal(team, &share) == nil {
				e.FromTeams = []TeamShare{share}
			}
		}
	}
	if mock := o.raw("mockResponse"); isJSONObject(mock) {
		e.MockResponse = new(MockResponse)
		if err := json.Unmarshal(mock, e.MockResponse); err != nil {
			return err
		}
	}
	for _, item := range o.array("responseRules") {
		var rule ResponseRule
		if isJSONObject(item) && json.Unmarshal(item, &rule) == nil {
			e.ResponseRules = append(e.ResponseRules, rule)
		}
	}
	return nil
}

// MarshalJSON writes the endpoint in the API's shape, so UnmarshalJSON reads
// it back.
func (e Endpoint) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID                string         `json:"id"`
		Slug              string         `json:"slug"`
		Name              string         `json:"name,omitempty"`
		URL               string         `json:"url,omitempty"`
		EmailAddress      string         `json:"emailAddress,omitempty"`
		CreatedAt         *int64         `json:"createdAt,omitempty"`
		IsEphemeral       bool           `json:"isEphemeral"`
		ExpiresAt         *int64         `json:"expiresAt,omitempty"`
		NotificationURL   string         `json:"notificationUrl,omitempty"`
		MockResponse      *MockResponse  `json:"mockResponse,omitempty"`
		ResponseRules     []ResponseRule `json:"responseRules,omitempty"`
		SigningProvider   string         `json:"signingProvider,omitempty"`
		HasSigningSecret  bool           `json:"hasSigningSecret"`
		ShowEmailExtracts *bool          `json:"showEmailExtracts,omitempty"`
		ForwardEnabled    *bool          `json:"forwardEnabled,omitempty"`
		ForwardURL        string         `json:"forwardUrl,omitempty"`
		SharedWith        []TeamShare    `json:"sharedWith,omitempty"`
		FromTeams         []TeamShare    `json:"fromTeams,omitempty"`
	}{
		e.ID, e.Slug, e.Name, e.URL, e.EmailAddress, millisOf(e.CreatedAt), e.IsEphemeral, millisOf(e.ExpiresAt),
		e.NotificationURL, e.MockResponse, e.ResponseRules, e.SigningProvider, e.HasSigningSecret,
		e.ShowEmailExtracts, e.ForwardEnabled, e.ForwardURL, e.SharedWith, e.FromTeams,
	})
}

// Usage is the requests used and left in the current period.
type Usage struct {
	Used      int
	Limit     int
	Remaining int
	Plan      string
	// PeriodEnd is zero until the period starts.
	PeriodEnd time.Time
	Raw       json.RawMessage
}

// UnmarshalJSON reads usage as the API returns it.
func (u *Usage) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*u = Usage{
		Used:      int(o.num("used")),
		Limit:     int(o.num("limit")),
		Remaining: int(o.num("remaining")),
		Plan:      o.str("plan"),
		PeriodEnd: o.millis("periodEnd"),
		Raw:       bytes.Clone(data),
	}
	return nil
}

// MarshalJSON writes usage in the API's shape, so UnmarshalJSON reads it back.
func (u Usage) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Used      int    `json:"used"`
		Limit     int    `json:"limit"`
		Remaining int    `json:"remaining"`
		Plan      string `json:"plan"`
		PeriodEnd *int64 `json:"periodEnd"`
	}{u.Used, u.Limit, u.Remaining, u.Plan, millisOf(u.PeriodEnd)})
}

// RequestPage is one page of captured requests. Pass Cursor to get the next.
type RequestPage struct {
	Items   []Request
	Cursor  string
	HasMore bool
}

// SendTestEmailResult is what Emails.SendTest delivered.
type SendTestEmailResult struct {
	Status string
	// RequestID is the captured email's id, or "" when the server could not tell.
	RequestID string
	Raw       json.RawMessage
}

// --- lenient JSON reading ----------------------------------------------------------

// rawObject reads fields leniently, like the other SDKs: a field of the
// wrong type reads as missing instead of failing the whole response.
type rawObject map[string]json.RawMessage

func (o rawObject) raw(key string) json.RawMessage { return o[key] }

func (o rawObject) strOK(key string) (string, bool) {
	var value string
	if raw, ok := o[key]; ok && len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil {
		return value, true
	}
	return "", false
}

func (o rawObject) str(key string) string {
	value, _ := o.strOK(key)
	return value
}

func (o rawObject) numOK(key string) (float64, bool) {
	var value float64
	if raw, ok := o[key]; ok && json.Unmarshal(raw, &value) == nil && !bytes.Equal(raw, []byte("null")) {
		return value, true
	}
	return 0, false
}

func (o rawObject) num(key string) float64 {
	value, _ := o.numOK(key)
	return value
}

func (o rawObject) millis(key string) time.Time {
	if value, ok := o.numOK(key); ok {
		return time.UnixMilli(int64(value))
	}
	return time.Time{}
}

func (o rawObject) boolean(key string) bool {
	return bytes.Equal(bytes.TrimSpace(o[key]), []byte("true"))
}

func (o rawObject) optBool(key string) *bool {
	switch string(bytes.TrimSpace(o[key])) {
	case "true":
		value := true
		return &value
	case "false":
		value := false
		return &value
	}
	return nil
}

func (o rawObject) object(key string) rawObject {
	var value rawObject
	if raw := o[key]; isJSONObject(raw) && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return nil
}

func (o rawObject) array(key string) []json.RawMessage {
	var value []json.RawMessage
	if raw := bytes.TrimSpace(o[key]); len(raw) > 0 && raw[0] == '[' && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return nil
}

func (o rawObject) strMap(key string) map[string]string {
	out := map[string]string{}
	for name, raw := range o.object(key) {
		var value string
		if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil {
			out[name] = value
		}
	}
	return out
}

func (o rawObject) strList(key string) []string {
	var out []string
	for _, raw := range o.array(key) {
		var value string
		if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil {
			out = append(out, value)
		}
	}
	return out
}

func (o rawObject) addresses(key string) []EmailAddress {
	var out []EmailAddress
	for _, raw := range o.array(key) {
		var address EmailAddress
		if isJSONObject(raw) && json.Unmarshal(raw, &address) == nil {
			out = append(out, address)
		}
	}
	return out
}

func (o rawObject) teams(key string) []TeamShare {
	items := o.array(key)
	if items == nil {
		return nil
	}
	out := []TeamShare{}
	for _, raw := range items {
		var share TeamShare
		if isJSONObject(raw) && json.Unmarshal(raw, &share) == nil {
			out = append(out, share)
		}
	}
	return out
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}
