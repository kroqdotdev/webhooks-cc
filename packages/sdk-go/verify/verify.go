package verify

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"

	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/sigutil"
	"webhooks.cc/go/internal/webtext"
)

// Options carries what a provider's check needs besides the body and headers.
type Options struct {
	// Secret is the signing secret; for PayPal, the webhook id.
	Secret string
	// PublicKey is the application's hex Ed25519 public key, for Discord.
	PublicKey string
	// URL is the URL the request was sent to. Twilio, Square and HubSpot
	// sign it, so they need it.
	URL string
	// Method is the request's method, which HubSpot signs. The default is POST.
	Method string
	// Now is HubSpot's clock (its signatures expire after five minutes). The
	// zero value means time.Now().
	Now time.Time
	// FetchCertificate returns the PEM a PayPal certificate URL serves,
	// instead of downloading it (and skips the download cache).
	FetchCertificate func(ctx context.Context, url string) (string, error)
}

var providers = []string{
	"stripe", "github", "shopify", "twilio", "slack", "paddle", "linear", "clerk",
	"discord", "vercel", "gitlab", "typeform", "standard-webhooks", "meta",
	"lemonsqueezy", "coinbase-commerce", "razorpay", "cal", "intercom", "telegram",
	"square", "hubspot", "mailgun", "calendly", "mux", "sentry", "bitbucket",
	"docusign", "adyen", "paypal", "resend", "workos",
}

// Providers returns every provider whose signatures Signature checks: all
// that webhooks.cc knows except SendGrid and Plaid.
func Providers() []string { return slices.Clone(providers) }

// Signature checks a request's signature with the provider's scheme.
//
// Pass the body as the exact bytes received, before any JSON parsing. A
// missing or invalid signature is (false, nil); an error means the check
// could not run: an unknown provider, a missing option, or a PayPal
// certificate that could not be downloaded.
func Signature(provider string, body []byte, headers Headers, opts Options) (bool, error) {
	return SignatureContext(context.Background(), provider, body, headers, opts)
}

// SignatureContext is Signature with a context, which PayPal's certificate
// download uses.
func SignatureContext(ctx context.Context, provider string, body []byte, headers Headers, opts Options) (bool, error) {
	switch provider {
	case "sendgrid":
		return false, errors.New("verify: SendGrid does not use signature verification; SendGrid webhooks are verified via IP allowlisting")
	case "plaid":
		return false, errors.New("verify: Plaid webhook verification requires Plaid JWT/JWK lookup credentials and is not supported yet")
	}
	if !slices.Contains(providers, provider) {
		return false, fmt.Errorf("verify: unknown provider %q", provider)
	}
	switch provider {
	case "twilio", "square", "hubspot":
		if opts.URL == "" {
			return false, fmt.Errorf("verify: provider %q requires Options.URL", provider)
		}
	case "discord":
		if opts.PublicKey == "" {
			return false, errors.New(`verify: provider "discord" requires a non-empty Options.PublicKey`)
		}
		return discord(body, headers, opts.PublicKey), nil
	}
	if opts.Secret == "" {
		return false, fmt.Errorf("verify: provider %q requires a non-empty Options.Secret", provider)
	}

	secret := opts.Secret
	h := func(name string) string { return header(headers, name) }
	switch provider {
	case "stripe":
		return timestampedHex(body, h("stripe-signature"), secret), nil
	case "calendly":
		return timestampedHex(body, h("calendly-webhook-signature"), secret), nil
	case "mux":
		return timestampedHex(body, h("mux-signature"), secret), nil
	case "workos":
		return timestampedHex(body, h("workos-signature"), secret), nil
	case "github", "meta":
		return prefixedHex(body, h("x-hub-signature-256"), "sha256=", secret), nil
	case "bitbucket":
		return prefixedHex(body, h("x-hub-signature"), "sha256=", secret), nil
	case "intercom":
		return prefixedHex(body, h("x-hub-signature"), "sha1=", secret), nil
	case "shopify":
		return bodyBase64(body, h("x-shopify-hmac-sha256"), secret), nil
	case "docusign":
		return bodyBase64(body, h("x-docusign-signature-1"), secret), nil
	case "twilio":
		return twilio(opts.URL, body, h("x-twilio-signature"), secret), nil
	case "slack":
		return slack(body, h("x-slack-signature"), h("x-slack-request-timestamp"), secret), nil
	case "paddle":
		return paddle(body, h("paddle-signature"), secret), nil
	case "linear":
		return linear(body, h("linear-signature"), secret), nil
	case "lemonsqueezy":
		return hexMatches(body, h("x-signature"), secret), nil
	case "coinbase-commerce":
		return hexMatches(body, h("x-cc-webhook-signature"), secret), nil
	case "razorpay":
		return hexMatches(body, h("x-razorpay-signature"), secret), nil
	case "cal":
		return hexMatches(body, h("x-cal-signature-256"), secret), nil
	case "sentry":
		return hexMatches(body, h("sentry-hook-signature"), secret), nil
	case "vercel":
		return vercel(body, h("x-vercel-signature"), secret), nil
	case "gitlab":
		return token(h("x-gitlab-token"), secret), nil
	case "telegram":
		return token(h("x-telegram-bot-api-secret-token"), secret), nil
	case "typeform":
		return typeform(body, h("typeform-signature"), secret), nil
	case "standard-webhooks":
		return standardWebhook(body, headers, secret), nil
	case "clerk", "resend":
		return standardWebhook(body, svixHeaders{headers}, secret), nil
	case "square":
		return square(opts.URL, body, h("x-square-hmacsha256-signature"), secret), nil
	case "hubspot":
		method := opts.Method
		if method == "" {
			method = "POST"
		}
		now := opts.Now
		if now.IsZero() {
			now = time.Now()
		}
		return hubspot(method, opts.URL, body, h("x-hubspot-signature-v3"), h("x-hubspot-request-timestamp"), secret, now), nil
	case "mailgun":
		return mailgun(body, secret), nil
	case "adyen":
		return adyen(body, secret), nil
	case "paypal":
		return paypal(ctx, body, headers, secret, opts.FetchCertificate)
	}
	return false, fmt.Errorf("verify: unknown provider %q", provider)
}

// stripeHeader reads t=<timestamp>,v1=<hex>[,v1=<hex>], as Stripe, Calendly,
// Mux and WorkOS send it.
func stripeHeader(value string) (string, []string, bool) {
	var timestamp string
	var signatures []string
	for _, part := range strings.Split(value, ",") {
		trimmed := jsTrim(part)
		key, val, found := strings.Cut(trimmed, "=")
		if trimmed == "" || !found {
			continue
		}
		key, val = jsTrim(key), jsTrim(val)
		if val == "" {
			continue
		}
		switch key {
		case "t":
			timestamp = val
		case "v1":
			signatures = append(signatures, strings.ToLower(val))
		}
	}
	return timestamp, signatures, timestamp != "" && len(signatures) > 0
}

func timestampedHex(body []byte, signatureHeader, secret string) bool {
	timestamp, signatures, ok := stripeHeader(signatureHeader)
	if !ok {
		return false
	}
	expected := hmacSHA256Hex(secret, concat([]byte(timestamp), []byte("."), body))
	return slices.ContainsFunc(signatures, func(signature string) bool { return safeEqual(signature, expected) })
}

// prefixedHex checks <prefix><hex HMAC of the body>, the prefix in any case:
// GitHub, Meta and Bitbucket with sha256=, Intercom with sha1=.
func prefixedHex(body []byte, signatureHeader, prefix, secret string) bool {
	signature, ok := cutPrefixFold(jsTrim(signatureHeader), prefix)
	if !ok {
		return false
	}
	var expected string
	if prefix == "sha1=" {
		expected = hmacSHA1Hex(secret, body)
	} else {
		expected = hmacSHA256Hex(secret, body)
	}
	return safeEqual(strings.ToLower(signature), expected)
}

// bodyBase64 checks the base64 HMAC-SHA256 of the body: Shopify, Docusign.
func bodyBase64(body []byte, signatureHeader, secret string) bool {
	if signatureHeader == "" {
		return false
	}
	return safeEqual(jsTrim(signatureHeader), hmacSHA256Base64([]byte(secret), body))
}

// hexMatches checks a hex HMAC-SHA256 of the body, optionally as prefix=<hex>.
func hexMatches(body []byte, signatureHeader, secret string) bool {
	received := jsTrim(signatureHeader)
	if _, after, found := strings.Cut(received, "="); found {
		received = after
	}
	if received == "" {
		return false
	}
	return safeEqual(strings.ToLower(received), hmacSHA256Hex(secret, body))
}

func twilio(url string, body []byte, signatureHeader, secret string) bool {
	if signatureHeader == "" {
		return false
	}
	payload := sigutil.TwilioPayload(url, webtext.FormParams(bodyText(body)))
	expected := sigutil.Base64(sigutil.HMACSHA1([]byte(secret), []byte(payload)))
	return safeEqual(jsTrim(signatureHeader), expected)
}

func slack(body []byte, signatureHeader, timestamp, secret string) bool {
	if signatureHeader == "" || timestamp == "" {
		return false
	}
	signature, ok := cutPrefixFold(jsTrim(signatureHeader), "v0=")
	if !ok {
		return false
	}
	expected := hmacSHA256Hex(secret, concat([]byte("v0:"+timestamp+":"), body))
	return safeEqual(strings.ToLower(signature), expected)
}

var paddleSeparators = regexp.MustCompile(`[;,]`)

func paddle(body []byte, signatureHeader, secret string) bool {
	var timestamp string
	var signatures []string
	for _, part := range paddleSeparators.Split(signatureHeader, -1) {
		trimmed := jsTrim(part)
		key, val, found := strings.Cut(trimmed, "=")
		if trimmed == "" || !found {
			continue
		}
		key, val = strings.ToLower(jsTrim(key)), jsTrim(val)
		if val == "" {
			continue
		}
		switch key {
		case "ts":
			timestamp = val
		case "h1":
			signatures = append(signatures, strings.ToLower(val))
		}
	}
	if timestamp == "" || len(signatures) == 0 {
		return false
	}
	expected := hmacSHA256Hex(secret, concat([]byte(timestamp+":"), body))
	return slices.ContainsFunc(signatures, func(signature string) bool { return safeEqual(signature, expected) })
}

func linear(body []byte, signatureHeader, secret string) bool {
	received := jsTrim(signatureHeader)
	if received == "" {
		return false
	}
	if rest, ok := cutPrefixFold(received, "sha256="); ok {
		received = rest
	}
	return safeEqual(strings.ToLower(received), hmacSHA256Hex(secret, body))
}

func vercel(body []byte, signatureHeader, secret string) bool {
	if signatureHeader == "" {
		return false
	}
	return safeEqual(strings.ToLower(jsTrim(signatureHeader)), hmacSHA1Hex(secret, body))
}

// token checks a header that carries the secret itself: GitLab, Telegram.
func token(value, secret string) bool {
	return value != "" && safeEqual(value, secret)
}

func typeform(body []byte, signatureHeader, secret string) bool {
	received := jsTrim(signatureHeader)
	signature := strings.TrimPrefix(received, "sha256=")
	if signature == "" {
		return false
	}
	return safeEqual(signature, hmacSHA256Base64([]byte(secret), body))
}

func square(url string, body []byte, signatureHeader, secret string) bool {
	if signatureHeader == "" {
		return false
	}
	expected := hmacSHA256Base64([]byte(secret), concat([]byte(url), body))
	return safeEqual(jsTrim(signatureHeader), expected)
}

const hubspotMaxAge = 5 * 60 * 1000 // milliseconds

func hubspot(method, url string, body []byte, signatureHeader, timestamp, secret string, now time.Time) bool {
	if signatureHeader == "" || timestamp == "" {
		return false
	}
	clock := float64(now.UnixNano()) / 1e6
	ts := jsNumber(timestamp)
	if math.IsNaN(ts) || math.IsInf(ts, 0) || math.Abs(clock-ts) > hubspotMaxAge {
		return false
	}
	base := concat([]byte(strings.ToUpper(method)+sigutil.HubSpotDecodeURI(url)), body, []byte(timestamp))
	return safeEqual(jsTrim(signatureHeader), hmacSHA256Base64([]byte(secret), base))
}

// parseJSON reads a body as JSON.parse reads its text.
func parseJSON(body []byte) (any, bool) {
	value, err := jsonx.Parse([]byte(bodyText(body)))
	return value, err == nil
}

func mailgun(body []byte, secret string) bool {
	if len(body) == 0 {
		return false
	}
	parsed, ok := parseJSON(body)
	if !ok {
		return false
	}
	object, _ := parsed.(jsonx.Object)
	signatureValue, _ := object.Get("signature")
	signatureObject, ok := signatureValue.(jsonx.Object)
	if !ok {
		return false
	}
	text := func(key string) string {
		value, _ := signatureObject.Get(key)
		s, _ := value.(string)
		return s
	}
	timestamp, tokenValue, signature := text("timestamp"), text("token"), text("signature")
	if timestamp == "" || tokenValue == "" || signature == "" {
		return false
	}
	return safeEqual(strings.ToLower(signature), hmacSHA256Hex(secret, []byte(timestamp+tokenValue)))
}

// adyen requires every notification item to carry its own valid signature:
// one genuine item must not vouch for forged or unsigned ones in the batch.
func adyen(body []byte, hexKey string) bool {
	if len(body) == 0 {
		return false
	}
	parsed, ok := parseJSON(body)
	if !ok {
		return false
	}
	object, _ := parsed.(jsonx.Object)
	itemsValue, _ := object.Get("notificationItems")
	items, ok := itemsValue.([]any)
	if !ok || len(items) == 0 {
		return false
	}
	signed := 0
	for _, notification := range items {
		notificationObject, _ := notification.(jsonx.Object)
		itemValue, _ := notificationObject.Get("NotificationRequestItem")
		if _, isArray := itemValue.([]any); isArray {
			return false // an object, but without the signature
		}
		item, ok := itemValue.(jsonx.Object)
		if !ok {
			continue
		}
		additional, _ := item.Get("additionalData")
		additionalObject, _ := additional.(jsonx.Object)
		signatureValue, _ := additionalObject.Get("hmacSignature")
		signature, _ := signatureValue.(string)
		if signature == "" {
			return false
		}
		expected, err := sigutil.AdyenHMAC(item, hexKey)
		if err != nil || !safeEqual(signature, expected) {
			return false
		}
		signed++
	}
	return signed > 0
}

func discordHex(value string) ([]byte, bool) {
	normalized := strings.ToLower(jsTrim(value))
	if normalized == "" || len(normalized)%2 != 0 || strings.Trim(normalized, "0123456789abcdef") != "" {
		return nil, false
	}
	decoded, err := hex.DecodeString(normalized)
	return decoded, err == nil
}

// discord checks Ed25519 over timestamp + body with the application's key.
func discord(body []byte, headers Headers, publicKey string) bool {
	signatureHeader := header(headers, "x-signature-ed25519")
	timestamp := header(headers, "x-signature-timestamp")
	if signatureHeader == "" || timestamp == "" {
		return false
	}
	key, ok := discordHex(publicKey)
	if !ok || len(key) != ed25519.PublicKeySize {
		return false
	}
	signature, ok := discordHex(signatureHeader)
	if !ok || len(signature) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(key), concat([]byte(timestamp), body), signature)
}

var standardSignature = regexp.MustCompile(`v1,([A-Za-z0-9+/=]+)`)

// standardSignatures returns the base64 signatures of a space-separated
// v1,<base64> list.
func standardSignatures(value string) []string {
	if value == "" {
		return nil
	}
	var signatures []string
	for _, match := range standardSignature.FindAllStringSubmatch(value, -1) {
		signatures = append(signatures, match[1])
	}
	if len(signatures) > 0 {
		return signatures
	}
	parts := strings.SplitN(value, ",", 3)
	if len(parts) >= 2 && jsTrim(parts[0]) == "v1" && jsTrim(parts[1]) != "" {
		return []string{jsTrim(parts[1])}
	}
	return nil
}

// standardWebhook checks Standard Webhooks: each v1 signature is the base64
// HMAC-SHA256 of id.timestamp.body, keyed with the decoded whsec_ secret.
func standardWebhook(body []byte, headers Headers, secret string) bool {
	messageID := header(headers, "webhook-id")
	timestamp := header(headers, "webhook-timestamp")
	signatureHeader := header(headers, "webhook-signature")
	if messageID == "" || timestamp == "" || signatureHeader == "" {
		return false
	}
	expected := hmacSHA256Base64(sigutil.StandardWebhookKey(secret), concat([]byte(messageID+"."+timestamp+"."), body))
	return slices.ContainsFunc(standardSignatures(signatureHeader), func(signature string) bool { return safeEqual(signature, expected) })
}
