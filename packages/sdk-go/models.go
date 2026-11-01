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
	// EmailFields are the endpoint's named fields (see EmailField), by name:
	// the text each pattern found, or "" when it found nothing (a value is
	// never empty). Nil when the endpoint has none. Set on emails read
	// through this client.
	EmailFields map[string]string
	// ReplyText is the new text of a reply, without the quoted message and
	// the signature, or "" when the email quotes no earlier message. Set on
	// emails read through this client.
	ReplyText string
	// Parsed is what the endpoint's layouts found, once the parse is done
	// (emails on endpoints with layouts).
	Parsed *ParsedEmail
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
		ReplyText:         o.str("replyText"),
		Raw:               bytes.Clone(data),
	}
	if kind := RequestKind(o.str("kind")); kind == KindHTTP || kind == KindEmail {
		r.Kind = kind
	}
	if fields := o.object("emailFields"); fields != nil {
		r.EmailFields = make(map[string]string, len(fields))
		for name := range fields {
			r.EmailFields[name] = fields.str(name)
		}
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
	if parsed := o.raw("parsed"); isJSONObject(parsed) {
		r.Parsed = new(ParsedEmail)
		if err := json.Unmarshal(parsed, r.Parsed); err != nil {
			return err
		}
	}
	return nil
}

// MarshalJSON writes the request in the API's shape, so UnmarshalJSON reads
// it back.
func (r Request) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID                string             `json:"id"`
		EndpointID        string             `json:"endpointId,omitempty"`
		Slug              string             `json:"slug,omitempty"`
		Method            string             `json:"method"`
		Path              string             `json:"path"`
		Headers           Headers            `json:"headers"`
		Body              string             `json:"body"`
		QueryParams       map[string]string  `json:"queryParams"`
		IP                string             `json:"ip"`
		Size              int                `json:"size"`
		ReceivedAt        *int64             `json:"receivedAt,omitempty"`
		ContentType       string             `json:"contentType,omitempty"`
		BodyRaw           string             `json:"bodyRaw,omitempty"`
		SignatureVerified *bool              `json:"signatureVerified,omitempty"`
		SignatureError    string             `json:"signatureError,omitempty"`
		SigningProvider   string             `json:"signingProvider,omitempty"`
		Kind              RequestKind        `json:"kind,omitempty"`
		Email             *EmailCapture      `json:"email,omitempty"`
		Extracts          *EmailExtracts     `json:"extracts,omitempty"`
		EmailFields       map[string]*string `json:"emailFields,omitempty"`
		ReplyText         string             `json:"replyText,omitempty"`
		Parsed            *ParsedEmail       `json:"parsed,omitempty"`
	}{
		r.ID, r.EndpointID, r.Slug, r.Method, r.Path, r.Headers, r.Body, r.QueryParams, r.IP, r.Size,
		millisOf(r.ReceivedAt), r.ContentType, r.BodyRaw, r.SignatureVerified, r.SignatureError,
		r.SigningProvider, r.Kind, r.Email, r.Extracts, emailFieldValuesJSON(r.EmailFields), r.ReplyText,
		r.Parsed,
	})
}

// emailFieldValuesJSON is a request's field values in the API's shape, null
// for a field that found nothing.
func emailFieldValuesJSON(fields map[string]string) map[string]*string {
	if fields == nil {
		return nil
	}
	out := make(map[string]*string, len(fields))
	for name, value := range fields {
		out[name] = nonEmpty(value)
	}
	return out
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
	// URL is a signed download link, in deliveries whose destination sends links.
	URL string `json:"url,omitempty"`
	// Content is the contents, base64-encoded, in deliveries whose
	// destination sends them inline.
	Content string `json:"content,omitempty"`
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
		URL:         o.str("url"),
		Content:     o.str("content"),
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
	// Stored reports that the exact message and the attachments' contents
	// are kept in storage: RequestsService.Raw downloads the message and
	// RequestsService.Attachment each attachment, whatever their size.
	Stored bool `json:"stored,omitempty"`
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
		Stored:       o.boolean("stored"),
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

// EmailField is a named field an endpoint picks out of every email it
// captures: the part of the email to read and a regular expression in RE2
// syntax whose first group (or whole match, without a group) is the value.
// webhooks.cc runs the patterns, so lookahead, lookbehind and backreferences
// are not available. The values arrive as Request.EmailFields, and as fields
// in the email's JSON, where forwarding templates read them as
// {{ fields.invoice }}.
type EmailField struct {
	// Name is how templates and filters refer to it: letters, digits and _,
	// starting with a letter, at most 40 characters.
	Name string `json:"name"`
	// From is the part it reads: "subject", "text", "html" (the HTML as
	// text), "from", "to" (the To and Cc addresses) or "header".
	From string `json:"from"`
	// Header is the header's name, for From "header".
	Header string `json:"header,omitempty"`
	// Pattern is at most 1,000 characters.
	Pattern string `json:"pattern"`
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

// DestinationFormat is how a destination sends.
type DestinationFormat string

// The formats of a destination. FormatAuto picks from the URL: a chat
// message for Slack and Discord, otherwise HTTP requests as received and
// emails as signed JSON. A delivery's format is never FormatAuto.
//
// FormatPostmark, FormatSendGrid, FormatMailgun and FormatCloudMailin post
// emails in that inbound mail provider's shape: Postmark's inbound JSON,
// SendGrid's Inbound Parse form, a Mailgun route's form and CloudMailin's
// JSON Normalized format. HTTP requests to such a destination go as
// received. EmailsService.Render takes them, and FormatJSON, too.
const (
	FormatAuto        DestinationFormat = "auto"
	FormatAsReceived  DestinationFormat = "as_received"
	FormatJSON        DestinationFormat = "json"
	FormatTemplate    DestinationFormat = "template"
	FormatChat        DestinationFormat = "chat"
	FormatPostmark    DestinationFormat = "postmark"
	FormatSendGrid    DestinationFormat = "sendgrid"
	FormatMailgun     DestinationFormat = "mailgun"
	FormatCloudMailin DestinationFormat = "cloudmailin"
	// FormatSheets adds rows to a Google Sheet, set up in the dashboard.
	FormatSheets DestinationFormat = "sheets"
	// FormatFileDrop writes files to an SFTP, FTP or S3 server (Business),
	// set up in the dashboard.
	FormatFileDrop DestinationFormat = "file_drop"
)

// DestinationAttachments is how a destination's deliveries carry the
// attachments of emails kept in storage (EmailCapture.Stored).
type DestinationAttachments string

// The ways attachments travel. AttachmentsLinks, the default, gives each
// attachment a URL, a signed link that downloads it while the email is kept;
// AttachmentsInline sends each one's Content as base64 while a delivery's
// attachments add up to 1 MB (larger ones get a URL); AttachmentsNone sends
// names, types and sizes only.
const (
	AttachmentsLinks  DestinationAttachments = "links"
	AttachmentsInline DestinationAttachments = "inline"
	AttachmentsNone   DestinationAttachments = "none"
)

// DestinationFilter says which captured requests a destination gets: those
// its conditions match, all of them (Logic "and", the default) or any
// ("or"). The conditions are those of response rules, and may also read:
//
//   - kind: eq, neq, with Value "http" or "email"
//   - email (with Name subject, from, to, text or tag): exists, not_exists
//     and the path ops
//   - spam_score: exists, not_exists, gt, gte, lt, lte
//   - email_auth (with Name spf, dkim or dmarc): eq, neq, with a Value such
//     as "pass" or "fail"
//   - signature: eq, neq, with Value "verified", "failed" or "missing"
type DestinationFilter struct {
	Logic string `json:"logic,omitempty"`
	// Conditions are at most 10 conditions.
	Conditions []ResponseRuleCondition `json:"conditions"`
}

// MarshalJSON writes the filter as the API expects it, no conditions as [].
func (f DestinationFilter) MarshalJSON() ([]byte, error) {
	type wire DestinationFilter
	if f.Conditions == nil {
		f.Conditions = []ResponseRuleCondition{}
	}
	return json.Marshal(wire(f))
}

// DestinationHeader is one of a destination's own headers, its value masked.
type DestinationHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// DestinationHeaderInput is a header to save on a destination. A nil Value
// keeps the value stored under that name.
type DestinationHeaderInput struct {
	Name  string  `json:"name"`
	Value *string `json:"value"`
}

// Destination is where an endpoint's captures go. An endpoint has up to 10:
// every capture is queued once for each one that is on and takes its kind,
// and the destination's Filter decides whether it is sent.
type Destination struct {
	ID string
	// Position is its place in the list, also the order captures are queued in.
	Position int
	Name     string
	Enabled  bool
	URL      string
	// HasSecret reports whether it has a signing secret;
	// DestinationsService.Secret reveals it.
	HasSecret bool
	// HasMailgunSigningKey reports, for FormatMailgun, whether a Mailgun
	// signing key is saved. The key itself is never returned.
	HasMailgunSigningKey bool
	// HTTP and Email say which kinds it takes.
	HTTP   bool
	Email  bool
	Format DestinationFormat
	// Filter is nil when it gets every capture of the kinds it takes.
	Filter *DestinationFilter
	// BodyTemplate is the JSON body a FormatTemplate destination sends, its
	// strings holding {{ placeholders }} filled in from each request; nil
	// when there is none.
	BodyTemplate json.RawMessage
	// MessageTemplate is the text of a FormatChat destination's messages;
	// "" sends the standard message.
	MessageTemplate string
	// Headers are its own headers, values masked.
	Headers []DestinationHeader
	// AppendPath adds the captured path to the URL, for requests sent as
	// received.
	AppendPath bool
	// Retry is how long failed deliveries are retried: 24 hours, 1 hour, or
	// 0 for one try.
	Retry time.Duration
	// KeepOrder sends one delivery at a time, in capture order.
	KeepOrder bool
	// SentField is a JSON body field with the sender's own timestamp.
	SentField string
	// Throttle sends at most one delivery per period (0: every capture); the
	// rest are not sent.
	Throttle time.Duration
	// Delay is how long after a capture the first try waits, like a callback.
	Delay time.Duration
	// Attachments is how its deliveries carry the attachments of emails kept
	// in storage; "" from a server that does not say.
	Attachments DestinationAttachments
	// Role is "forward" for the destination the endpoint's Forward settings
	// stand for, "notify" for its NotificationURL, and "" otherwise.
	Role      string
	CreatedAt time.Time
	UpdatedAt time.Time
	// Summary is set by DestinationsService.List with Summary.
	Summary *DestinationSummary
	// Raw is the JSON the destination was read from.
	Raw json.RawMessage
}

// DestinationSummary is a destination's deliveries of the last 24 hours and
// what is waiting now.
type DestinationSummary struct {
	Last24h DeliveryCounts
	// Pending counts the deliveries queued or retrying now.
	Pending int
}

// DeliveryCounts count deliveries by outcome. Skipped ones were turned down
// by the destination's filter.
type DeliveryCounts struct {
	Delivered int
	Failed    int
	Skipped   int
}

// seconds reads a number of seconds as a duration.
func (o rawObject) seconds(key string) time.Duration {
	return time.Duration(o.num(key) * float64(time.Second))
}

// UnmarshalJSON reads a destination as the API returns it.
func (d *Destination) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*d = Destination{
		ID:                   o.str("id"),
		Position:             int(o.num("position")),
		Name:                 o.str("name"),
		Enabled:              o.boolean("enabled"),
		URL:                  o.str("url"),
		HasSecret:            o.boolean("hasSecret"),
		HasMailgunSigningKey: o.boolean("hasMailgunSigningKey"),
		HTTP:                 o.boolean("http"),
		Email:                o.boolean("email"),
		Format:               DestinationFormat(o.str("format")),
		MessageTemplate:      o.str("messageTemplate"),
		AppendPath:           o.boolean("appendPath"),
		Retry:                o.seconds("retrySeconds"),
		KeepOrder:            o.boolean("keepOrder"),
		SentField:            o.str("sentField"),
		Throttle:             o.seconds("throttleSeconds"),
		Delay:                o.seconds("delaySeconds"),
		Attachments:          DestinationAttachments(o.str("attachments")),
		CreatedAt:            o.millis("createdAt"),
		UpdatedAt:            o.millis("updatedAt"),
		Raw:                  bytes.Clone(data),
	}
	if role := o.str("role"); role == "forward" || role == "notify" {
		d.Role = role
	}
	if filter := o.raw("filter"); isJSONObject(filter) {
		var parsed DestinationFilter
		if json.Unmarshal(filter, &parsed) == nil {
			d.Filter = &parsed
		}
	}
	if template := bytes.TrimSpace(o.raw("bodyTemplate")); len(template) > 0 && !bytes.Equal(template, []byte("null")) {
		d.BodyTemplate = bytes.Clone(template)
	}
	for _, item := range o.array("headers") {
		var header rawObject
		if json.Unmarshal(item, &header) != nil || header == nil {
			continue
		}
		if name, ok := header.strOK("name"); ok {
			d.Headers = append(d.Headers, DestinationHeader{Name: name, Value: header.str("value")})
		}
	}
	if summary := o.object("summary"); summary != nil {
		counts := summary.object("last24h")
		d.Summary = &DestinationSummary{
			Last24h: DeliveryCounts{
				Delivered: int(counts.num("delivered")),
				Failed:    int(counts.num("failed")),
				Skipped:   int(counts.num("skipped")),
			},
			Pending: int(summary.num("pending")),
		}
	}
	return nil
}

// MarshalJSON writes the destination in the API's shape, so UnmarshalJSON
// reads it back.
func (d Destination) MarshalJSON() ([]byte, error) {
	type wireCounts struct {
		Delivered int `json:"delivered"`
		Failed    int `json:"failed"`
		Skipped   int `json:"skipped"`
	}
	type wireSummary struct {
		Last24h wireCounts `json:"last24h"`
		Pending int        `json:"pending"`
	}
	var summary *wireSummary
	if d.Summary != nil {
		summary = &wireSummary{Last24h: wireCounts(d.Summary.Last24h), Pending: d.Summary.Pending}
	}
	headers := d.Headers
	if headers == nil {
		headers = []DestinationHeader{}
	}
	return json.Marshal(struct {
		ID                   string                 `json:"id"`
		Position             int                    `json:"position"`
		Name                 *string                `json:"name"`
		Enabled              bool                   `json:"enabled"`
		URL                  string                 `json:"url"`
		HasSecret            bool                   `json:"hasSecret"`
		HasMailgunSigningKey bool                   `json:"hasMailgunSigningKey"`
		HTTP                 bool                   `json:"http"`
		Email                bool                   `json:"email"`
		Format               DestinationFormat      `json:"format"`
		Filter               *DestinationFilter     `json:"filter"`
		BodyTemplate         json.RawMessage        `json:"bodyTemplate"`
		MessageTemplate      *string                `json:"messageTemplate"`
		Headers              []DestinationHeader    `json:"headers"`
		AppendPath           bool                   `json:"appendPath"`
		RetrySeconds         int64                  `json:"retrySeconds"`
		KeepOrder            bool                   `json:"keepOrder"`
		SentField            *string                `json:"sentField"`
		ThrottleSeconds      int64                  `json:"throttleSeconds"`
		DelaySeconds         int64                  `json:"delaySeconds"`
		Attachments          DestinationAttachments `json:"attachments,omitempty"`
		Role                 *string                `json:"role"`
		CreatedAt            *int64                 `json:"createdAt,omitempty"`
		UpdatedAt            *int64                 `json:"updatedAt,omitempty"`
		Summary              *wireSummary           `json:"summary,omitempty"`
	}{
		d.ID, d.Position, nonEmpty(d.Name), d.Enabled, d.URL, d.HasSecret, d.HasMailgunSigningKey, d.HTTP, d.Email, d.Format,
		d.Filter, d.BodyTemplate, nonEmpty(d.MessageTemplate), headers, d.AppendPath,
		int64(d.Retry / time.Second), d.KeepOrder, nonEmpty(d.SentField), int64(d.Throttle / time.Second),
		int64(d.Delay / time.Second), d.Attachments, nonEmpty(d.Role), millisOf(d.CreatedAt), millisOf(d.UpdatedAt), summary,
	})
}

// DestinationRequest is the captured request a destination preview or test
// delivery used.
type DestinationRequest struct {
	// ID is "" when nothing of the kind was captured yet and a sample was used.
	ID     string
	Kind   RequestKind
	Method string
	Path   string
	// Subject is the email's subject, for emails.
	Subject    string
	ReceivedAt time.Time
	// Sample is true when a sample was used.
	Sample bool
}

// destinationRequest reads the request of a preview or test result. A test
// result carries kind and sample beside it, in outer.
func (o rawObject) destinationRequest(outer rawObject) DestinationRequest {
	kind, ok := o.strOK("kind")
	if !ok {
		kind = outer.str("kind")
	}
	sample := o.optBool("sample")
	if sample == nil {
		sample = outer.optBool("sample")
	}
	request := DestinationRequest{
		ID:         o.str("id"),
		Method:     o.str("method"),
		Path:       o.str("path"),
		Subject:    o.str("subject"),
		ReceivedAt: o.millis("receivedAt"),
		Sample:     sample != nil && *sample,
	}
	if kind := RequestKind(kind); kind == KindHTTP || kind == KindEmail {
		request.Kind = kind
	}
	return request
}

// destinationRequestJSON is a DestinationRequest in the API's shape.
type destinationRequestJSON struct {
	ID         *string     `json:"id"`
	Kind       RequestKind `json:"kind,omitempty"`
	Method     string      `json:"method"`
	Path       string      `json:"path"`
	Subject    *string     `json:"subject"`
	ReceivedAt *int64      `json:"receivedAt"`
	Sample     bool        `json:"sample"`
}

func (r DestinationRequest) wire() destinationRequestJSON {
	return destinationRequestJSON{
		ID: nonEmpty(r.ID), Kind: r.Kind, Method: r.Method, Path: r.Path, Subject: nonEmpty(r.Subject),
		ReceivedAt: millisOf(r.ReceivedAt), Sample: r.Sample,
	}
}

// PreviewedDelivery is the request a destination would send. Header values
// it stores stay masked.
type PreviewedDelivery struct {
	Method  string
	URL     string
	Headers map[string]string
	// Body is the body as text, "" when there is none or it is not UTF-8.
	Body string
	// BodyBase64 holds the body's bytes, base64-encoded, when they are not
	// UTF-8. BodyBytes decodes it.
	BodyBase64 string
}

// BodyBytes returns the body's exact bytes, decoding BodyBase64 when it is set.
func (p *PreviewedDelivery) BodyBytes() []byte {
	if p.BodyBase64 != "" {
		if raw, err := base64.StdEncoding.DecodeString(p.BodyBase64); err == nil {
			return raw
		}
	}
	return []byte(p.Body)
}

// DestinationPreview is what DestinationsService.Preview reports: what a
// destination would send for a captured request, without sending it.
type DestinationPreview struct {
	Request DestinationRequest
	// TakesKind reports whether the destination takes this kind of request
	// at all.
	TakesKind bool
	// FilterPasses reports whether its filter lets the request through.
	FilterPasses bool
	// Format is how it would go out.
	Format DestinationFormat
	// Delivery is the request it would send, or nil when nothing would be
	// sent; Error says why.
	Delivery *PreviewedDelivery
	// Error says why nothing would be sent, such as a template that cannot
	// be filled in.
	Error string
	// Raw is the JSON the preview was read from.
	Raw json.RawMessage
}

// UnmarshalJSON reads a preview as the API returns it.
func (p *DestinationPreview) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*p = DestinationPreview{
		Request:      o.object("request").destinationRequest(nil),
		TakesKind:    o.boolean("takesKind"),
		FilterPasses: o.boolean("filterPasses"),
		Format:       DestinationFormat(o.str("format")),
		Error:        o.str("error"),
		Raw:          bytes.Clone(data),
	}
	if delivery := o.object("delivery"); delivery != nil {
		p.Delivery = &PreviewedDelivery{
			Method:     delivery.str("method"),
			URL:        delivery.str("url"),
			Headers:    delivery.strMap("headers"),
			Body:       delivery.str("body"),
			BodyBase64: delivery.str("bodyBase64"),
		}
	}
	return nil
}

// MarshalJSON writes the preview in the API's shape, so UnmarshalJSON reads
// it back.
func (p DestinationPreview) MarshalJSON() ([]byte, error) {
	type wireDelivery struct {
		Method     string            `json:"method"`
		URL        string            `json:"url"`
		Headers    map[string]string `json:"headers"`
		Body       *string           `json:"body"`
		BodyBase64 *string           `json:"bodyBase64"`
	}
	var delivery *wireDelivery
	if p.Delivery != nil {
		delivery = &wireDelivery{
			Method: p.Delivery.Method, URL: p.Delivery.URL, Headers: p.Delivery.Headers,
			Body: nonEmpty(p.Delivery.Body), BodyBase64: nonEmpty(p.Delivery.BodyBase64),
		}
		if delivery.Headers == nil {
			delivery.Headers = map[string]string{}
		}
	}
	return json.Marshal(struct {
		Request      destinationRequestJSON `json:"request"`
		TakesKind    bool                   `json:"takesKind"`
		FilterPasses bool                   `json:"filterPasses"`
		Format       DestinationFormat      `json:"format"`
		Delivery     *wireDelivery          `json:"delivery"`
		Error        *string                `json:"error"`
	}{p.Request.wire(), p.TakesKind, p.FilterPasses, p.Format, delivery, nonEmpty(p.Error)})
}

// SenderTime is the sender's own timestamp, as read from a request.
type SenderTime struct {
	At time.Time
	// Source is where it was read: the body field, or a header such as
	// webhook-timestamp.
	Source string
	// WholeSeconds is true when the timestamp has whole seconds only.
	WholeSeconds bool
}

// DestinationTestResult is what DestinationsService.Test reports: one
// delivery, sent now, and the answer it got.
type DestinationTestResult struct {
	// Status is the HTTP status the URL answered, or 0 when no answer arrived.
	Status   int
	Duration time.Duration
	// Excerpt is the start of the response body.
	Excerpt string
	// Error says why no answer arrived (a timeout, a refused connection, a
	// TLS problem).
	Error string
	// Delivered reports whether the URL answered with a 2xx status.
	Delivered bool
	// Sample is true when nothing of the kind was captured yet, so a sample
	// was sent.
	Sample bool
	// FilterPasses reports whether the destination's filter would have let
	// the request through; a test sends either way.
	FilterPasses bool
	Kind         RequestKind
	Format       DestinationFormat
	// URL is where it went, path appended.
	URL string
	// Target is the host and path, as the delivery log records them.
	Target  string
	Request DestinationRequest
	// Sender is the sender's own timestamp, when the request had one.
	Sender *SenderTime
	// Raw is the JSON the result was read from.
	Raw json.RawMessage
}

// UnmarshalJSON reads a test result as the API returns it.
func (r *DestinationTestResult) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*r = DestinationTestResult{
		Status:       int(o.num("status")),
		Duration:     time.Duration(o.num("durationMs") * float64(time.Millisecond)),
		Excerpt:      o.str("excerpt"),
		Error:        o.str("error"),
		Delivered:    o.boolean("delivered"),
		Sample:       o.boolean("sample"),
		FilterPasses: o.boolean("filterPasses"),
		Format:       DestinationFormat(o.str("format")),
		URL:          o.str("url"),
		Target:       o.str("target"),
		Request:      o.object("request").destinationRequest(o),
		Raw:          bytes.Clone(data),
	}
	if kind := RequestKind(o.str("kind")); kind == KindHTTP || kind == KindEmail {
		r.Kind = kind
	}
	if sender := o.object("sender"); sender != nil {
		r.Sender = &SenderTime{At: sender.millis("at"), Source: sender.str("source"), WholeSeconds: sender.boolean("wholeSeconds")}
	}
	return nil
}

// MarshalJSON writes the result in the API's shape, so UnmarshalJSON reads
// it back.
func (r DestinationTestResult) MarshalJSON() ([]byte, error) {
	type wireSender struct {
		At           *int64 `json:"at"`
		Source       string `json:"source"`
		WholeSeconds bool   `json:"wholeSeconds"`
	}
	var sender *wireSender
	if r.Sender != nil {
		sender = &wireSender{At: millisOf(r.Sender.At), Source: r.Sender.Source, WholeSeconds: r.Sender.WholeSeconds}
	}
	var status *int
	if r.Status != 0 {
		status = &r.Status
	}
	return json.Marshal(struct {
		Status       *int                   `json:"status"`
		DurationMs   int64                  `json:"durationMs"`
		Excerpt      *string                `json:"excerpt"`
		Error        *string                `json:"error"`
		Delivered    bool                   `json:"delivered"`
		Sample       bool                   `json:"sample"`
		FilterPasses bool                   `json:"filterPasses"`
		Kind         RequestKind            `json:"kind,omitempty"`
		Format       DestinationFormat      `json:"format,omitempty"`
		URL          string                 `json:"url,omitempty"`
		Target       *string                `json:"target"`
		Request      destinationRequestJSON `json:"request"`
		Sender       *wireSender            `json:"sender"`
	}{
		status, r.Duration.Milliseconds(), nonEmpty(r.Excerpt), nonEmpty(r.Error), r.Delivered, r.Sample,
		r.FilterPasses, r.Kind, r.Format, r.URL, nonEmpty(r.Target), r.Request.wire(), sender,
	})
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
	// EmailFields are the named fields picked out of every email the
	// endpoint captures (owner only).
	EmailFields []EmailField
	// RetentionDays is the days requests are kept here; nil keeps them as
	// long as the plan does (owner only).
	RetentionDays *int
	// RetentionCapDays is the longest retention this endpoint may have: its
	// plan's (owner only).
	RetentionCapDays int
	// DeleteAfterDelivery deletes requests once every delivery is settled
	// (owner only).
	DeleteAfterDelivery *bool
	// Layouts are how the endpoint reads its emails; the first that matches
	// applies (owner only).
	Layouts []Layout
	// LayoutsCap is how many layouts the plan uses; later ones are kept but
	// not used (owner only).
	LayoutsCap     int
	ForwardEnabled *bool
	ForwardURL     string
	SharedWith     []TeamShare
	FromTeams      []TeamShare
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
	for _, item := range o.array("emailFields") {
		var field EmailField
		if isJSONObject(item) && json.Unmarshal(item, &field) == nil {
			e.EmailFields = append(e.EmailFields, field)
		}
	}
	if days, ok := o.numOK("retentionDays"); ok {
		value := int(days)
		e.RetentionDays = &value
	}
	e.RetentionCapDays = int(o.num("retentionCapDays"))
	e.DeleteAfterDelivery = o.optBool("deleteAfterDelivery")
	for _, item := range o.array("layouts") {
		var layout Layout
		if isJSONObject(item) && json.Unmarshal(item, &layout) == nil {
			e.Layouts = append(e.Layouts, layout)
		}
	}
	e.LayoutsCap = int(o.num("layoutsCap"))
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
		EmailFields       []EmailField   `json:"emailFields,omitempty"`
		RetentionDays     *int           `json:"retentionDays,omitempty"`
		RetentionCapDays  int            `json:"retentionCapDays,omitempty"`
		DeleteAfter       *bool          `json:"deleteAfterDelivery,omitempty"`
		Layouts           []Layout       `json:"layouts,omitempty"`
		LayoutsCap        int            `json:"layoutsCap,omitempty"`
		ForwardEnabled    *bool          `json:"forwardEnabled,omitempty"`
		ForwardURL        string         `json:"forwardUrl,omitempty"`
		SharedWith        []TeamShare    `json:"sharedWith,omitempty"`
		FromTeams         []TeamShare    `json:"fromTeams,omitempty"`
	}{
		e.ID, e.Slug, e.Name, e.URL, e.EmailAddress, millisOf(e.CreatedAt), e.IsEphemeral, millisOf(e.ExpiresAt),
		e.NotificationURL, e.MockResponse, e.ResponseRules, e.SigningProvider, e.HasSigningSecret,
		e.ShowEmailExtracts, e.EmailFields, e.RetentionDays, e.RetentionCapDays, e.DeleteAfterDelivery,
		e.Layouts, e.LayoutsCap, e.ForwardEnabled, e.ForwardURL, e.SharedWith, e.FromTeams,
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

// RenderedEmail is a captured email in an inbound provider's shape, as
// EmailsService.Render returns it: post Body with Headers to the handler you
// wrote for that provider.
type RenderedEmail struct {
	Format DestinationFormat `json:"format"`
	// Method is always "POST".
	Method string `json:"method"`
	// Headers are the content-type and user-agent to send it with.
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	// Raw is the JSON the result was read from.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a rendered email as the API returns it.
func (e *RenderedEmail) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	method := o.str("method")
	if method == "" {
		method = "POST"
	}
	*e = RenderedEmail{
		Format:  DestinationFormat(o.str("format")),
		Method:  method,
		Headers: o.strMap("headers"),
		Body:    o.str("body"),
		Raw:     bytes.Clone(data),
	}
	return nil
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
