package webhookscc

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Layout is how an endpoint reads the emails of one sender or kind. An
// endpoint has an ordered list; the first enabled layout whose Match holds
// applies, with its fields, line items and attachment parsing. Layouts run
// only on webhooks.cc's servers (RE2, the sandboxed attachment parser), so
// this SDK describes them and reads their results; it never parses.
type Layout struct {
	// ID is 1 to 40 letters, digits, - or _; how alerts and the API refer to it.
	ID   string `json:"id"`
	Name string `json:"name"`
	// Enabled nil means on; a layout that is off is kept but never matched.
	Enabled *bool `json:"enabled,omitempty"`
	// Match is when the layout applies, in the rule language of destination
	// filters (the email's subject, from, to, text and tag, headers, the
	// sender checks, the spam score); nil or no conditions: every email.
	Match *DestinationFilter `json:"match,omitempty"`
	// Fields are named values, as an endpoint's email fields.
	Fields    []EmailField   `json:"fields,omitempty"`
	LineItems *LineItemsSpec `json:"lineItems,omitempty"`
	// ParseAttachments parses CSV, TSV, XLSX, XLS, ODS, PDF text and plain
	// text attachments; each parsed page is metered.
	ParseAttachments bool `json:"parseAttachments,omitempty"`
}

// LineItemsSpec says where a layout's line items come from.
type LineItemsSpec struct {
	// From is "text", "html" or "attachment".
	From string `json:"from"`
	// Pattern, for text and html, is an RE2 pattern with named groups found
	// again and again; each match is a row whose columns are the groups.
	Pattern string `json:"pattern,omitempty"`
	// Start and End limit the search to the text after the first match of
	// Start and before the first match of End after it.
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
	// Attachment, for attachments, picks the file by name (* and ?
	// wildcards); the first parsed spreadsheet or CSV when "".
	Attachment string `json:"attachment,omitempty"`
	// Sheet picks the sheet by name; the first when "".
	Sheet string `json:"sheet,omitempty"`
	// Columns keep these columns, by header text or letter; every column by
	// its header when empty.
	Columns []LineItemColumn `json:"columns,omitempty"`
}

// LineItemColumn maps a spreadsheet column to a line item's field.
type LineItemColumn struct {
	Name string `json:"name"`
	// Column is the header's text (any case) or a column letter (A, B, ...).
	Column string `json:"column"`
}

// ParsedEmail is what an endpoint's layouts found in an email: "parsed" in
// its JSON. Values that were not found are "". It has the JSON shape, so it
// also reads the "parsed" key of an email forwarded to you (the Data of
// verify.ForwardedEmail).
type ParsedEmail struct {
	// Status is "matched", or "no_layout" when no layout's conditions held.
	Status string `json:"status"`
	// Layout is the layout that applied; nil for no_layout.
	Layout    *ParsedLayout       `json:"layout"`
	Fields    map[string]string   `json:"fields"`
	LineItems []map[string]string `json:"lineItems"`
	// LineItemColumns are the line items' columns in order.
	LineItemColumns []string           `json:"lineItemColumns"`
	Attachments     []ParsedAttachment `json:"attachments"`
	// Pages is the billable pages this email used.
	Pages int `json:"pages"`
	// Truncated reports that the result was cut to fit the email's JSON
	// (about 1 MB): attachments' rows and text, then line items from the
	// end. The full parse is kept.
	Truncated bool `json:"truncated,omitempty"`
	// Partial reports a result read from a request list, which leaves out
	// line items and attachments; RequestsService.Get has all of it.
	Partial bool `json:"partial,omitempty"`
}

// ParsedLayout names the layout an email matched.
type ParsedLayout struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ParsedAttachment is one attachment a layout parsed.
type ParsedAttachment struct {
	Index    int    `json:"index"`
	Filename string `json:"filename"`
	// Format is csv, tsv, xlsx, xls, ods, pdf or text.
	Format string `json:"format"`
	// Pages is the billable pages this parse used (0 when an earlier parse
	// was read again).
	Pages int `json:"pages"`
	// Sheets are a spreadsheet's sheets, each with its first 1,000 rows.
	Sheets []ParsedSheet `json:"sheets,omitempty"`
	// Text is a PDF's or text file's text, cut at 256 KB.
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// Error says why it was not parsed: "limit" (no pages left), "not_kept"
	// (the email's attachments were not stored), "not_parsed" (a preview,
	// which never parses), "too_large", "malformed", "encrypted", "zip_bomb"
	// or "empty".
	Error string `json:"error,omitempty"`
}

// ParsedSheet is one sheet of a parsed spreadsheet.
type ParsedSheet struct {
	Name      string     `json:"name"`
	Rows      [][]string `json:"rows"`
	RowCount  int        `json:"rowCount"`
	Truncated bool       `json:"truncated"`
}

// PreviewLayoutsOptions say what EndpointsService.PreviewLayouts runs. All
// are optional.
type PreviewLayoutsOptions struct {
	// RequestID is a captured email on the endpoint; "" uses the newest.
	RequestID string
	// Layouts tries layouts that are not saved; nil uses the saved ones.
	Layouts []Layout
}

// LayoutsPreview is what PreviewLayouts reports. No pages are used:
// attachments show an earlier parse, never a new one.
type LayoutsPreview struct {
	// Problems say what is wrong with the layouts tried, if any.
	Problems   []string `json:"problems"`
	LayoutsCap int      `json:"layoutsCap"`
	// Request is the email it ran on; nil when the endpoint has none yet.
	Request *LayoutsPreviewRequest `json:"request"`
	Parsed  *ParsedEmail           `json:"parsed"`
}

// LayoutsPreviewRequest is the captured email a layouts preview ran on.
type LayoutsPreviewRequest struct {
	ID         string
	Subject    string
	ReceivedAt time.Time
}

// UnmarshalJSON reads the email as the API returns it.
func (r *LayoutsPreviewRequest) UnmarshalJSON(data []byte) error {
	var o rawObject
	if err := json.Unmarshal(data, &o); err != nil {
		return err
	}
	*r = LayoutsPreviewRequest{ID: o.str("id"), Subject: o.str("subject"), ReceivedAt: o.millis("receivedAt")}
	return nil
}

// MarshalJSON writes the email in the API's shape, so UnmarshalJSON reads it
// back.
func (r LayoutsPreviewRequest) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID         string  `json:"id"`
		Subject    *string `json:"subject"`
		ReceivedAt *int64  `json:"receivedAt,omitempty"`
	}{r.ID, nonEmpty(r.Subject), millisOf(r.ReceivedAt)})
}

// PreviewLayouts runs layouts on a captured email without saving anything:
// which one matches, and its fields and line items (owner only).
func (s *EndpointsService) PreviewLayouts(ctx context.Context, slug string, opts PreviewLayoutsOptions) (*LayoutsPreview, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if opts.RequestID != "" {
		body["requestId"] = opts.RequestID
	}
	if opts.Layouts != nil {
		body["layouts"] = opts.Layouts
	}
	var preview LayoutsPreview
	if err := s.c.api(ctx, http.MethodPost, "/endpoints/"+slug+"/layouts/preview", nil, body, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}
