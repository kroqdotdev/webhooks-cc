package webhookscc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// EndpointsService creates, reads, changes and deletes endpoints, and sends
// test requests to them. Use it as client.Endpoints.
type EndpointsService struct{ c *Client }

// EndpointSite is which site's dashboard lists an endpoint. Only the
// listing: every endpoint keeps its HTTP URL and email address and captures
// both.
type EndpointSite string

const (
	SiteWebhooks  EndpointSite = "webhooks"
	SiteMailhooks EndpointSite = "mailhooks"
	SiteBoth      EndpointSite = "both"
)

// CreateEndpointOptions are the settings of a new endpoint. All are optional.
type CreateEndpointOptions struct {
	Name string
	// Site is which site's dashboard lists it; empty means both.
	Site EndpointSite
	// Ephemeral makes the endpoint temporary; ExpiresIn sets when it expires.
	Ephemeral       bool
	ExpiresIn       time.Duration
	MockResponse    *MockResponse
	NotificationURL string
	ResponseRules   []ResponseRule
}

// Create creates an endpoint.
func (s *EndpointsService) Create(ctx context.Context, opts CreateEndpointOptions) (*Endpoint, error) {
	body := map[string]any{}
	if opts.Name != "" {
		body["name"] = opts.Name
	}
	if opts.MockResponse != nil {
		body["mockResponse"] = opts.MockResponse
	}
	if opts.NotificationURL != "" {
		body["notificationUrl"] = opts.NotificationURL
	}
	if opts.ResponseRules != nil {
		body["responseRules"] = opts.ResponseRules
	}
	if opts.Site != "" {
		body["site"] = opts.Site
	}
	if opts.ExpiresIn < 0 {
		return nil, errors.New("webhooks.cc: ExpiresIn must not be negative")
	}
	if opts.Ephemeral || opts.ExpiresIn > 0 {
		body["isEphemeral"] = true
	}
	if opts.ExpiresIn > 0 {
		body["expiresAt"] = time.Now().Add(opts.ExpiresIn).UnixMilli()
	}
	var endpoint Endpoint
	if err := s.c.api(ctx, http.MethodPost, "/endpoints", nil, body, &endpoint); err != nil {
		return nil, err
	}
	return &endpoint, nil
}

// List returns your endpoints, then those shared with you through teams.
func (s *EndpointsService) List(ctx context.Context) ([]Endpoint, error) {
	var response struct {
		Owned  []Endpoint `json:"owned"`
		Shared []Endpoint `json:"shared"`
	}
	if err := s.c.api(ctx, http.MethodGet, "/endpoints", nil, nil, &response); err != nil {
		return nil, err
	}
	return append(response.Owned, response.Shared...), nil
}

// Get returns one endpoint.
func (s *EndpointsService) Get(ctx context.Context, slug string) (*Endpoint, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return nil, err
	}
	var endpoint Endpoint
	if err := s.c.api(ctx, http.MethodGet, "/endpoints/"+slug, nil, nil, &endpoint); err != nil {
		return nil, err
	}
	return &endpoint, nil
}

// UpdateEndpointOptions are the settings an update changes. Only the fields
// set with Value or Null change. Null clears a setting; Name,
// ShowEmailExtracts and ForwardEnabled always have a value, so they only take
// Value.
type UpdateEndpointOptions struct {
	Name            Field[string]
	MockResponse    Field[MockResponse]
	NotificationURL Field[string]
	ResponseRules   Field[[]ResponseRule]
	// SigningProvider, SigningSecret and SigningHeader configure the
	// signature webhooks.cc checks on each capture.
	SigningProvider Field[string]
	SigningSecret   Field[string]
	SigningHeader   Field[string]
	// ShowEmailExtracts turns the codes and links found in emails on or off.
	ShowEmailExtracts Field[bool]
	// Site is which site's dashboard lists it (owner only).
	Site Field[EndpointSite]
	// EmailFields replaces the named fields picked out of every email the
	// endpoint captures, at most 20 (owner only); Null removes them all. A
	// list EmailFieldIssues finds fault with is refused before anything is
	// sent.
	EmailFields    Field[[]EmailField]
	ForwardEnabled Field[bool]
	ForwardURL     Field[string]
	// RetentionDays keeps requests fewer days than the plan does; Null keeps
	// them as long as the plan does (owner only).
	RetentionDays Field[int]
	// DeleteAfterDelivery deletes each request once every delivery is
	// settled (owner only).
	DeleteAfterDelivery Field[bool]
	// Layouts replaces how the endpoint reads its emails, at most 50; Null
	// removes them all (owner only). The server checks them, RE2 included.
	Layouts Field[[]Layout]
}

// Update changes an endpoint's settings.
func (s *EndpointsService) Update(ctx context.Context, slug string, opts UpdateEndpointOptions) (*Endpoint, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return nil, err
	}
	if opts.Name.isNull() || opts.ShowEmailExtracts.isNull() || opts.Site.isNull() || opts.ForwardEnabled.isNull() || opts.DeleteAfterDelivery.isNull() {
		return nil, errors.New("webhooks.cc: Name, ShowEmailExtracts, Site, ForwardEnabled and DeleteAfterDelivery cannot be cleared; set them with Value")
	}
	if opts.EmailFields.IsSet() && !opts.EmailFields.isNull() {
		if issues := EmailFieldIssues(opts.EmailFields.value); len(issues) > 0 {
			return nil, fmt.Errorf("webhooks.cc: EmailFields: %s", issues[0])
		}
	}
	body := map[string]any{}
	opts.Name.put(body, "name")
	opts.MockResponse.put(body, "mockResponse")
	opts.NotificationURL.put(body, "notificationUrl")
	opts.ResponseRules.put(body, "responseRules")
	opts.SigningProvider.put(body, "signingProvider")
	opts.SigningSecret.put(body, "signingSecret")
	opts.SigningHeader.put(body, "signingHeader")
	opts.ShowEmailExtracts.put(body, "showEmailExtracts")
	opts.Site.put(body, "site")
	opts.EmailFields.put(body, "emailFields")
	opts.ForwardEnabled.put(body, "forwardEnabled")
	opts.ForwardURL.put(body, "forwardUrl")
	opts.RetentionDays.put(body, "retentionDays")
	opts.DeleteAfterDelivery.put(body, "deleteAfterDelivery")
	opts.Layouts.put(body, "layouts")
	var endpoint Endpoint
	if err := s.c.api(ctx, http.MethodPatch, "/endpoints/"+slug, nil, body, &endpoint); err != nil {
		return nil, err
	}
	return &endpoint, nil
}

// PreviewResponseOptions say what EndpointsService.PreviewResponse runs. All
// are optional.
type PreviewResponseOptions struct {
	// RequestID is a captured request on the endpoint. "" uses the newest
	// HTTP request, or a sample when there is none.
	RequestID string
	// MockResponse and ResponseRules try settings that are not saved: Value
	// tries one, Null tries none at all, and leaving them unset uses the
	// saved ones.
	MockResponse  Field[MockResponse]
	ResponseRules Field[[]ResponseRule]
}

// PreviewResponse reports what a sender would get back for a captured
// request, without sending anything: which response rule matches and the
// response with its placeholders filled in.
//
//	preview, err := client.Endpoints.PreviewResponse(ctx, endpoint.Slug, webhookscc.PreviewResponseOptions{
//		ResponseRules: webhookscc.Value([]webhookscc.ResponseRule{{
//			Conditions: []webhookscc.ResponseRuleCondition{{Field: "header", Name: "x-event", Op: "eq", Value: "ping"}},
//			Response:   webhookscc.MockResponse{Status: 202, Body: `{"id":"{{ json.id }}"}`},
//		}}),
//	})
func (s *EndpointsService) PreviewResponse(ctx context.Context, slug string, opts PreviewResponseOptions) (*ResponsePreview, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if opts.RequestID != "" {
		body["requestId"] = opts.RequestID
	}
	opts.MockResponse.put(body, "mockResponse")
	opts.ResponseRules.put(body, "responseRules")
	var preview ResponsePreview
	if err := s.c.api(ctx, http.MethodPost, "/endpoints/"+slug+"/responses/preview", nil, body, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}

// Delete deletes an endpoint and everything it captured.
func (s *EndpointsService) Delete(ctx context.Context, slug string) error {
	if err := validateSegment(slug, "slug"); err != nil {
		return err
	}
	return s.c.api(ctx, http.MethodDelete, "/endpoints/"+slug, nil, nil, nil)
}

// Favorite marks an endpoint one of your favourites and returns its
// favourite state afterwards, true. It is your own choice, on your own
// endpoints and those shared with you through teams alike, and marking one
// again changes nothing. ErrNotFound means you cannot open the endpoint. It
// needs an account: a sandbox or pre-claim agent token gets an *Error with
// StatusCode 403.
func (s *EndpointsService) Favorite(ctx context.Context, slug string) (bool, error) {
	return s.setFavorite(ctx, slug, http.MethodPut)
}

// Unfavorite removes an endpoint from your favourites and returns its
// favourite state afterwards, false; one that is not a favourite stays as it
// is.
func (s *EndpointsService) Unfavorite(ctx context.Context, slug string) (bool, error) {
	return s.setFavorite(ctx, slug, http.MethodDelete)
}

func (s *EndpointsService) setFavorite(ctx context.Context, slug, method string) (bool, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return false, err
	}
	var response struct {
		Favorite bool `json:"favorite"`
	}
	if err := s.c.api(ctx, method, "/endpoints/"+slug+"/favorite", nil, nil, &response); err != nil {
		return false, err
	}
	return response.Favorite, nil
}

// Send sends a request to an endpoint's capture URL. With opts.Provider it is
// signed like that provider's webhooks, as SendTo does.
func (s *EndpointsService) Send(ctx context.Context, slug string, opts SendOptions) (*Response, error) {
	if err := validateSegment(slug, "slug"); err != nil {
		return nil, err
	}
	return s.c.SendTo(ctx, s.c.webhookURL+"/w/"+slug, opts)
}
