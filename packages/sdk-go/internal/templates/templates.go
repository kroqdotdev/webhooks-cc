// Package templates builds webhook requests signed the way each provider signs
// them, with realistic sample payloads. It is a port of the TypeScript SDK's
// templates.ts; the conformance vectors in packages/sdk/conformance/signing.json
// check the signatures byte for byte.
package templates

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/sigutil"
)

// Info describes what a provider's templates offer and how its requests are
// signed.
type Info struct {
	Provider string
	// Templates are the presets the provider supports.
	Templates []string
	// DefaultTemplate is the preset used when none is given ("" when the
	// provider has none).
	DefaultTemplate string
	// SecretRequired reports whether signing needs a shared secret.
	SecretRequired bool
	// SignatureHeader carries the signature ("" when it travels in the body).
	SignatureHeader string
	// SignatureAlgorithm is hmac-sha256, hmac-sha1, token, rsa-sha256 or
	// jwt-es256 ("" when the provider does not sign).
	SignatureAlgorithm string
}

var providers = []string{
	"stripe", "github", "shopify", "twilio", "slack", "paddle", "linear", "sendgrid",
	"clerk", "discord", "vercel", "gitlab", "typeform", "standard-webhooks", "meta",
	"lemonsqueezy", "coinbase-commerce", "razorpay", "cal", "intercom", "telegram",
	"square", "hubspot", "mailgun", "calendly", "mux", "sentry", "bitbucket", "docusign",
	"adyen", "paypal", "plaid", "resend", "workos",
}

var defaultTemplates = map[string]string{
	"stripe":            "payment_intent.succeeded",
	"github":            "push",
	"shopify":           "orders/create",
	"twilio":            "messaging.inbound",
	"slack":             "event_callback",
	"paddle":            "transaction.completed",
	"linear":            "issue.create",
	"sendgrid":          "delivered",
	"clerk":             "user.created",
	"discord":           "interaction_create",
	"vercel":            "deployment.created",
	"gitlab":            "push",
	"typeform":          "form_response",
	"meta":              "whatsapp.messages",
	"lemonsqueezy":      "order_created",
	"coinbase-commerce": "charge:confirmed",
	"razorpay":          "payment.captured",
	"cal":               "BOOKING_CREATED",
	"intercom":          "conversation.user.created",
	"telegram":          "message",
	"square":            "payment.created",
	"hubspot":           "contact.creation",
	"mailgun":           "delivered",
	"calendly":          "invitee.created",
	"mux":               "video.asset.created",
	"sentry":            "issue.created",
	"bitbucket":         "repo:push",
	"docusign":          "envelope-completed",
	"adyen":             "AUTHORISATION",
	"paypal":            "PAYMENT.CAPTURE.COMPLETED",
	"plaid":             "TRANSACTIONS",
	"resend":            "email.sent",
	"workos":            "user.created",
}

var providerTemplates = map[string][]string{
	"stripe":            {"payment_intent.succeeded", "checkout.session.completed", "invoice.paid"},
	"github":            {"push", "pull_request.opened", "ping"},
	"shopify":           {"orders/create", "orders/paid", "products/update", "app/uninstalled"},
	"twilio":            {"messaging.inbound", "messaging.status_callback", "voice.incoming_call"},
	"slack":             {"event_callback", "slash_command", "url_verification"},
	"paddle":            {"transaction.completed", "subscription.created", "subscription.updated"},
	"linear":            {"issue.create", "issue.update", "comment.create"},
	"sendgrid":          {"delivered", "open", "bounce", "spam_report"},
	"clerk":             {"user.created", "user.updated", "user.deleted", "session.created"},
	"discord":           {"interaction_create", "message_component", "ping"},
	"vercel":            {"deployment.created", "deployment.succeeded", "deployment.error"},
	"gitlab":            {"push", "merge_request"},
	"typeform":          {"form_response", "partial_response", "payment"},
	"meta":              {"whatsapp.messages", "page.messages", "instagram.comments"},
	"lemonsqueezy":      {"order_created", "subscription_created", "subscription_payment_success"},
	"coinbase-commerce": {"charge:confirmed", "charge:failed", "charge:pending"},
	"razorpay":          {"payment.captured", "payment.failed", "order.paid"},
	"cal":               {"BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"},
	"intercom":          {"conversation.user.created", "conversation.admin.replied", "contact.created"},
	"telegram":          {"message", "callback_query", "edited_message"},
	"square":            {"payment.created", "payment.updated", "refund.created"},
	"hubspot":           {"contact.creation", "contact.propertyChange", "deal.creation"},
	"mailgun":           {"delivered", "failed", "opened"},
	"calendly":          {"invitee.created", "invitee.canceled", "routing_form_submission.created"},
	"mux":               {"video.asset.created", "video.asset.ready", "video.upload.asset_created"},
	"sentry":            {"issue.created", "issue.resolved", "error.created"},
	"bitbucket":         {"repo:push", "pullrequest:created", "pullrequest:fulfilled"},
	"docusign":          {"envelope-completed", "envelope-declined", "recipient-completed"},
	"adyen":             {"AUTHORISATION", "CAPTURE", "REFUND"},
	"paypal":            {"PAYMENT.CAPTURE.COMPLETED", "CHECKOUT.ORDER.APPROVED", "BILLING.SUBSCRIPTION.CREATED"},
	"plaid":             {"TRANSACTIONS", "ITEM", "AUTH"},
	"resend":            {"email.sent", "email.delivered", "email.bounced", "email.clicked", "contact.created"},
	"workos":            {"user.created", "dsync.user.created", "connection.activated", "session.created", "organization.created"},
}

type signing struct {
	secretRequired bool
	header         string
	algorithm      string
}

var signingByProvider = map[string]signing{
	"stripe":            {true, "stripe-signature", "hmac-sha256"},
	"github":            {true, "x-hub-signature-256", "hmac-sha256"},
	"shopify":           {true, "x-shopify-hmac-sha256", "hmac-sha256"},
	"twilio":            {true, "x-twilio-signature", "hmac-sha1"},
	"slack":             {true, "x-slack-signature", "hmac-sha256"},
	"paddle":            {true, "paddle-signature", "hmac-sha256"},
	"linear":            {true, "linear-signature", "hmac-sha256"},
	"sendgrid":          {false, "", ""},
	"clerk":             {true, "webhook-signature", "hmac-sha256"},
	"discord":           {false, "", ""},
	"vercel":            {true, "x-vercel-signature", "hmac-sha1"},
	"gitlab":            {true, "x-gitlab-token", "token"},
	"typeform":          {true, "typeform-signature", "hmac-sha256"},
	"standard-webhooks": {true, "webhook-signature", "hmac-sha256"},
	"meta":              {true, "x-hub-signature-256", "hmac-sha256"},
	"lemonsqueezy":      {true, "x-signature", "hmac-sha256"},
	"coinbase-commerce": {true, "x-cc-webhook-signature", "hmac-sha256"},
	"razorpay":          {true, "x-razorpay-signature", "hmac-sha256"},
	"cal":               {true, "x-cal-signature-256", "hmac-sha256"},
	"intercom":          {true, "x-hub-signature", "hmac-sha1"},
	"telegram":          {true, "x-telegram-bot-api-secret-token", "token"},
	"square":            {true, "x-square-hmacsha256-signature", "hmac-sha256"},
	"hubspot":           {true, "x-hubspot-signature-v3", "hmac-sha256"},
	// Mailgun signs fields in the body (signature.{timestamp,token,signature}).
	"mailgun":   {true, "", "hmac-sha256"},
	"calendly":  {true, "calendly-webhook-signature", "hmac-sha256"},
	"mux":       {true, "mux-signature", "hmac-sha256"},
	"sentry":    {true, "sentry-hook-signature", "hmac-sha256"},
	"bitbucket": {true, "x-hub-signature", "hmac-sha256"},
	"docusign":  {true, "x-docusign-signature-1", "hmac-sha256"},
	// Adyen standard notifications carry additionalData.hmacSignature in the body.
	"adyen":  {true, "", "hmac-sha256"},
	"paypal": {true, "paypal-transmission-sig", "rsa-sha256"},
	"plaid":  {false, "plaid-verification", "jwt-es256"},
	// Resend delivers through Svix and sends only the svix-* headers.
	"resend": {true, "svix-signature", "hmac-sha256"},
	"workos": {true, "workos-signature", "hmac-sha256"},
}

// Providers returns every provider Build can imitate, in the TypeScript SDK's
// order.
func Providers() []string { return slices.Clone(providers) }

// Lookup returns what a provider's templates offer.
func Lookup(provider string) (Info, bool) {
	sign, ok := signingByProvider[provider]
	if !ok {
		return Info{}, false
	}
	return Info{
		Provider:           provider,
		Templates:          slices.Clone(providerTemplates[provider]),
		DefaultTemplate:    defaultTemplates[provider],
		SecretRequired:     sign.secretRequired,
		SignatureHeader:    sign.header,
		SignatureAlgorithm: sign.algorithm,
	}, true
}

// Params says what to build.
type Params struct {
	Provider string
	// Secret signs the request; providers that do not sign ignore it.
	Secret string
	// Template picks a sample payload ("" for the provider's default).
	Template string
	// Event overrides the event name the template implies.
	Event string
	// Body replaces the sample payload: a string or []byte (UTF-8 text) or a
	// json.RawMessage is sent as it is, anything else as JSON.
	Body any
	// Method defaults to POST.
	Method string
	// Headers are added last and override the built ones.
	Headers map[string]string
	// Timestamp signs with a fixed time (Unix seconds); zero means now.
	Timestamp time.Time
	// MessageID fixes the message id of Standard Webhooks, Clerk and Resend.
	MessageID string
}

// Request is a built request, ready to send.
type Request struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
}

const (
	contentJSON = "application/json"
	contentForm = "application/x-www-form-urlencoded"
)

// override is a caller's body: text sent as it is, or a value sent as JSON.
type override struct {
	present bool
	isText  bool
	text    string
	value   any
}

func newOverride(body any) (override, error) {
	switch body := body.(type) {
	case nil:
		return override{}, nil
	case string:
		return override{present: true, isText: true, text: body}, nil
	case json.RawMessage:
		return override{present: true, isText: true, text: string(body)}, nil
	case []byte:
		// Providers sign text; bytes are taken as the UTF-8 text they hold.
		if !utf8.Valid(body) {
			return override{}, errors.New("a signed body given as bytes must be UTF-8 text")
		}
		return override{present: true, isText: true, text: string(body)}, nil
	default:
		return override{present: true, value: body}, nil
	}
}

// payload is the body to send: the override when given, else the sample.
func (o override) payload(sample any) (string, error) {
	if !o.present {
		return jsonx.Stringify(sample)
	}
	if o.isText {
		return o.text, nil
	}
	return jsonx.Stringify(o.value)
}

// Build builds a webhook request the way p.Provider sends it, signed with
// p.Secret. It fails for an unknown provider or template, a missing secret for
// a provider that signs with one, and a body that cannot be serialized.
func Build(url string, p Params) (*Request, error) {
	provider := p.Provider
	if _, ok := signingByProvider[provider]; !ok {
		return nil, fmt.Errorf("unsupported provider %q", provider)
	}
	body, err := newOverride(p.Body)
	if err != nil {
		return nil, err
	}
	method := "POST"
	if p.Method != "" {
		method = strings.ToUpper(p.Method)
	}
	requireSecret := func() (string, error) {
		if p.Secret == "" {
			return "", fmt.Errorf("provider %q templates require a non-empty secret", provider)
		}
		return p.Secret, nil
	}
	seconds := func() int64 {
		if p.Timestamp.IsZero() {
			return time.Now().Unix()
		}
		return p.Timestamp.Unix()
	}
	finish := func(headers map[string]string, payload string) *Request {
		for name, value := range p.Headers {
			headers[name] = value
		}
		return &Request{Method: method, URL: url, Headers: headers, Body: []byte(payload)}
	}

	switch provider {
	case "standard-webhooks":
		secret, err := requireSecret()
		if err != nil {
			return nil, err
		}
		payload, err := body.payload(jsonx.Object{})
		if err != nil {
			return nil, err
		}
		messageID := p.MessageID
		if messageID == "" {
			if p.Event != "" {
				messageID = "msg_" + p.Event + "_" + randomHex(8)
			} else {
				messageID = "msg_" + randomHex(16)
			}
		}
		ts := strconv.FormatInt(seconds(), 10)
		signature := sigutil.Base64(sigutil.HMACSHA256(sigutil.StandardWebhookKey(secret), []byte(messageID+"."+ts+"."+payload)))
		return finish(map[string]string{
			"content-type":      contentJSON,
			"webhook-id":        messageID,
			"webhook-timestamp": ts,
			"webhook-signature": "v1," + signature,
		}, payload), nil

	case "sendgrid", "discord", "plaid":
		template, err := ensureTemplate(provider, p.Template)
		if err != nil {
			return nil, err
		}
		headers := templateHeaders(provider, template)
		headers["content-type"] = contentJSON
		var sample any
		switch provider {
		case "sendgrid":
			headers["user-agent"] = "SendGrid/1.0"
			sample = sendgridPayload(template, time.Now().Unix())
		case "discord":
			headers["x-signature-timestamp"] = strconv.FormatInt(seconds(), 10)
			sample = discordPayload(template)
		case "plaid":
			sample = plaidPayload(template)
		}
		payload, err := body.payload(sample)
		if err != nil {
			return nil, err
		}
		if provider == "plaid" {
			// Real Plaid verification fetches Plaid's JWK with API credentials,
			// so generated payloads carry a JWT-shaped placeholder and are not signed.
			jwtHeader, _ := jsonx.Stringify(o("alg", "ES256", "kid", "mock-"+randomHex(8), "typ", "JWT"))
			jwtPayload, _ := jsonx.Stringify(o("iat", seconds(), "request_body_sha256", "mock-template-not-verifiable"))
			headers["plaid-verification"] = sigutil.Base64URL([]byte(jwtHeader)) + "." + sigutil.Base64URL([]byte(jwtPayload)) + ".mock-signature"
		}
		return finish(headers, payload), nil
	}

	secret, err := requireSecret()
	if err != nil {
		return nil, err
	}
	template, err := ensureTemplate(provider, p.Template)
	if err != nil {
		return nil, err
	}
	event := p.Event
	if event == "" {
		event = defaultEvent(provider, template)
	}
	nowMS := time.Now().UnixMilli()
	built, err := buildPayload(payloadContext{
		provider: provider,
		template: template,
		event:    event,
		nowSec:   nowMS / 1000,
		nowISO:   isoTime(nowMS),
		body:     body,
	})
	if err != nil {
		return nil, err
	}

	out := map[string]string{
		"content-type":                    built.contentType,
		"x-webhooks-cc-template-provider": provider,
		"x-webhooks-cc-template-template": template,
		"x-webhooks-cc-template-event":    event,
	}
	for name, value := range built.headers {
		out[name] = value
	}
	payload := built.body
	key := []byte(secret)
	hexSHA256 := func(data string) string { return sigutil.Hex(sigutil.HMACSHA256(key, []byte(data))) }
	b64SHA256 := func(data string) string { return sigutil.Base64(sigutil.HMACSHA256(key, []byte(data))) }
	ts := func() string { return strconv.FormatInt(seconds(), 10) }

	switch provider {
	case "stripe":
		t := ts()
		out["stripe-signature"] = "t=" + t + ",v1=" + hexSHA256(t+"."+payload)
	case "github":
		out["x-github-event"] = event
		out["x-github-delivery"] = randomUUID()
		out["x-hub-signature-256"] = "sha256=" + hexSHA256(payload)
	case "shopify":
		out["x-shopify-topic"] = event
		out["x-shopify-hmac-sha256"] = b64SHA256(payload)
	case "twilio":
		signed := url + payload
		if built.twilioParams != nil {
			signed = sigutil.TwilioPayload(url, built.twilioParams)
		}
		out["x-twilio-signature"] = sigutil.Base64(sigutil.HMACSHA1(key, []byte(signed)))
	case "slack":
		t := ts()
		out["x-slack-request-timestamp"] = t
		out["x-slack-signature"] = "v0=" + hexSHA256("v0:"+t+":"+payload)
	case "paddle":
		t := ts()
		out["paddle-signature"] = "ts=" + t + ";h1=" + hexSHA256(t+":"+payload)
	case "linear":
		out["linear-signature"] = "sha256=" + hexSHA256(payload)
	case "clerk":
		messageID := p.MessageID
		if messageID == "" {
			messageID = "msg_" + randomHex(16)
		}
		t := ts()
		signature := "v1," + sigutil.Base64(sigutil.HMACSHA256(sigutil.StandardWebhookKey(secret), []byte(messageID+"."+t+"."+payload)))
		out["webhook-id"] = messageID
		out["webhook-timestamp"] = t
		out["webhook-signature"] = signature
		out["svix-id"] = messageID
		out["svix-timestamp"] = t
		out["svix-signature"] = signature
	case "vercel":
		out["x-vercel-signature"] = sigutil.Hex(sigutil.HMACSHA1(key, []byte(payload)))
	case "gitlab":
		out["x-gitlab-token"] = secret
		if template == "merge_request" {
			out["x-gitlab-event"] = "Merge Request Hook"
		} else {
			out["x-gitlab-event"] = "Push Hook"
		}
	case "typeform":
		out["typeform-signature"] = "sha256=" + b64SHA256(payload)
	case "meta":
		out["x-hub-signature-256"] = "sha256=" + hexSHA256(payload)
	case "lemonsqueezy":
		out["x-signature"] = hexSHA256(payload)
	case "coinbase-commerce":
		out["x-cc-webhook-signature"] = hexSHA256(payload)
	case "razorpay":
		out["x-razorpay-signature"] = hexSHA256(payload)
	case "cal":
		out["x-cal-signature-256"] = hexSHA256(payload)
	case "intercom":
		out["x-hub-signature"] = "sha1=" + sigutil.Hex(sigutil.HMACSHA1(key, []byte(payload)))
	case "telegram":
		out["x-telegram-bot-api-secret-token"] = secret
	case "square":
		// Square signs the notification URL followed by the raw body.
		out["x-square-hmacsha256-signature"] = b64SHA256(url + payload)
	case "hubspot":
		// HubSpot v3 signs method + decoded URI + body + timestamp in milliseconds.
		t := strconv.FormatInt(seconds()*1000, 10)
		out["x-hubspot-request-timestamp"] = t
		out["x-hubspot-signature-v3"] = b64SHA256(method + sigutil.HubSpotDecodeURI(url) + payload + t)
	case "mailgun":
		payload, err = signMailgun(payload, key, seconds)
		if err != nil {
			return nil, err
		}
	case "calendly":
		t := ts()
		out["calendly-webhook-signature"] = "t=" + t + ",v1=" + hexSHA256(t+"."+payload)
	case "mux":
		t := ts()
		out["mux-signature"] = "t=" + t + ",v1=" + hexSHA256(t+"."+payload)
	case "resend":
		messageID := p.MessageID
		if messageID == "" {
			messageID = "msg_" + randomHex(24)
		}
		t := ts()
		out["svix-id"] = messageID
		out["svix-timestamp"] = t
		out["svix-signature"] = "v1," + sigutil.Base64(sigutil.HMACSHA256(sigutil.StandardWebhookKey(secret), []byte(messageID+"."+t+"."+payload)))
	case "workos":
		// WorkOS signs `${t}.${body}` with t in milliseconds, and the header puts a
		// space after the comma.
		ms := time.Now().UnixMilli()
		if !p.Timestamp.IsZero() {
			ms = p.Timestamp.Unix() * 1000
		}
		t := strconv.FormatInt(ms, 10)
		out["workos-signature"] = "t=" + t + ", v1=" + hexSHA256(t+"."+payload)
	case "sentry":
		out["sentry-hook-signature"] = hexSHA256(payload)
		resource, _, _ := strings.Cut(event, ".")
		out["sentry-hook-resource"] = resource
	case "bitbucket":
		out["x-event-key"] = event
		out["x-hub-signature"] = "sha256=" + hexSHA256(payload)
	case "docusign":
		out["x-docusign-signature-1"] = b64SHA256(payload)
		out["x-authorization-digest"] = "HMACSHA256"
	case "adyen":
		payload, err = signAdyen(payload, secret)
		if err != nil {
			return nil, err
		}
	case "paypal":
		transmitted := time.Now().UnixMilli()
		if !p.Timestamp.IsZero() {
			transmitted = p.Timestamp.Unix() * 1000
		}
		out["paypal-transmission-id"] = randomUUID()
		out["paypal-transmission-time"] = isoTime(transmitted)
		out["paypal-cert-url"] = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-" + randomHex(16)
		out["paypal-auth-algo"] = "SHA256withRSA"
		// PayPal signs with its own private key, which a test cannot hold. This
		// placeholder keeps generated requests provider-shaped for detection.
		out["paypal-transmission-sig"] = sigutil.Base64URL([]byte("mock:" + secret + ":" + payload))
	}

	return finish(out, payload), nil
}

func ensureTemplate(provider, template string) (string, error) {
	if template == "" {
		template = defaultTemplates[provider]
	}
	supported := providerTemplates[provider]
	if !slices.Contains(supported, template) {
		return "", fmt.Errorf("unsupported template %q for provider %q (supported: %s)", template, provider, strings.Join(supported, ", "))
	}
	return template, nil
}

func defaultEvent(provider, template string) string {
	switch {
	case provider == "github" && template == "pull_request.opened":
		return "pull_request"
	case provider == "typeform" && template == "payment":
		return "form_response"
	}
	return template
}

func templateHeaders(provider, template string) map[string]string {
	return map[string]string{
		"x-webhooks-cc-template-provider": provider,
		"x-webhooks-cc-template-template": template,
		"x-webhooks-cc-template-event":    template,
	}
}

// signMailgun signs the body's timestamp and token and writes the signature
// object back into it.
func signMailgun(body string, key []byte, seconds func() int64) (string, error) {
	parsed, err := jsonx.Parse([]byte(body))
	if err != nil {
		return "", fmt.Errorf("mailgun template body: %w", err)
	}
	object, isObject := parsed.(jsonx.Object)
	if _, isArray := parsed.([]any); !isObject && !isArray {
		return "", errors.New("mailgun template body must be a JSON object")
	}
	var signature jsonx.Object
	if isObject {
		value, _ := object.Get("signature")
		signature, _ = value.(jsonx.Object)
	}
	timestamp, _ := signature.Get("timestamp")
	if timestamp == nil {
		timestamp = strconv.FormatInt(seconds(), 10)
	}
	token, _ := signature.Get("token")
	if token == nil {
		token = randomHex(50)
	}
	digest := sigutil.Hex(sigutil.HMACSHA256(key, []byte(jsonx.String(timestamp)+jsonx.String(token))))
	if !isObject {
		// JSON.stringify drops a property set on an array: the items stay as they are.
		return jsonx.Stringify(parsed)
	}
	object.Set("signature", o("timestamp", timestamp, "token", token, "signature", digest))
	return jsonx.Stringify(object)
}

// spread is {...value} for the values JSON can hold.
func spread(value any) jsonx.Object {
	switch value := value.(type) {
	case jsonx.Object:
		return slices.Clone(value)
	case []any:
		out := make(jsonx.Object, len(value))
		for i, item := range value {
			out[i] = jsonx.Member{Key: strconv.Itoa(i), Value: item}
		}
		return out
	case string:
		out := jsonx.Object{}
		for i, r := range []rune(value) {
			out = append(out, jsonx.Member{Key: strconv.Itoa(i), Value: string(r)})
		}
		return out
	}
	return jsonx.Object{}
}

// signAdyen signs every notification item in the body; each must carry its
// own signature.
func signAdyen(body, hexKey string) (string, error) {
	parsed, err := jsonx.Parse([]byte(body))
	if err != nil {
		return "", fmt.Errorf("adyen template body: %w", err)
	}
	if parsed == nil {
		return "", errors.New("adyen template body must be a JSON object")
	}
	root, ok := parsed.(jsonx.Object)
	if !ok {
		return body, nil
	}
	itemsValue, _ := root.Get("notificationItems")
	switch itemsValue.(type) {
	case nil, string:
		return body, nil
	}
	items, ok := itemsValue.([]any)
	if !ok {
		return "", errors.New("adyen notificationItems must be an array")
	}
	signedAny := false
	for i, wrapperValue := range items {
		wrapper, ok := wrapperValue.(jsonx.Object)
		if !ok {
			continue
		}
		itemValue, _ := wrapper.Get("NotificationRequestItem")
		if _, isArray := itemValue.([]any); isArray {
			// JSON.stringify drops the property TypeScript sets on an array;
			// the key is still checked.
			if _, err := sigutil.AdyenHMAC(jsonx.Object{}, hexKey); err != nil {
				return "", fmt.Errorf("adyen hmac key: %w", err)
			}
			signedAny = true
			continue
		}
		item, ok := itemValue.(jsonx.Object)
		if !ok {
			continue
		}
		signature, err := sigutil.AdyenHMAC(item, hexKey)
		if err != nil {
			return "", fmt.Errorf("adyen hmac key: %w", err)
		}
		previous, _ := item.Get("additionalData")
		additional := spread(previous)
		additional.Set("hmacSignature", signature)
		item.Set("additionalData", additional)
		wrapper.Set("NotificationRequestItem", item)
		items[i] = wrapper
		signedAny = true
	}
	if !signedAny {
		return body, nil
	}
	root.Set("notificationItems", items)
	return jsonx.Stringify(root)
}
