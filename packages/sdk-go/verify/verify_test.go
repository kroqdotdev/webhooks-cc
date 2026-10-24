package verify

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"webhooks.cc/go/internal/sigutil"
)

func verifyVectorNamed(t *testing.T, name string) verifyVector {
	return vectorNamed(t, loadVerifyVectors(t), name, func(v verifyVector) string { return v.Name })
}

func forwardingVectorNamed(t *testing.T, name string) forwardingVector {
	return vectorNamed(t, loadForwardingVectors(t), name, func(v forwardingVector) string { return v.Name })
}

func TestHeadersInAnyShape(t *testing.T) {
	t.Parallel()
	stripe := verifyVectorNamed(t, "stripe")
	const name = "stripe-signature"
	value := stripe.Headers[name]
	canonical := http.Header{}
	canonical.Set(name, value)
	cases := map[string]Headers{
		"Map, upper case":            Map{strings.ToUpper(name): value},
		"http.Header":                canonical,
		"http.Header, not canonical": http.Header{name: {value}},
	}
	for label, headers := range cases {
		valid, err := Signature("stripe", []byte(stripe.Body), headers, Options{Secret: stripe.Secret})
		if err != nil || !valid {
			t.Errorf("%s: Signature = %v, %v", label, valid, err)
		}
	}
	if valid, err := Signature("stripe", []byte(stripe.Body), nil, Options{Secret: stripe.Secret}); valid || err != nil {
		t.Errorf("nil headers: Signature = %v, %v", valid, err)
	}
}

func TestRepeatedHeadersJoinLikeNode(t *testing.T) {
	t.Parallel()
	headers := http.Header{"Webhook-Signature": {"v1,a", "v1,b"}}
	if got := header(headers, "webhook-signature"); got != "v1,a, v1,b" {
		t.Errorf("got %q", got)
	}
}

func TestClerkAndResendReadSvixHeaders(t *testing.T) {
	t.Parallel()
	secret := "whsec_" + sigutil.Base64([]byte("clerk-secret"))
	body := []byte(`{"type":"user.created"}`)
	signature := hmacSHA256Base64([]byte("clerk-secret"), []byte("msg_1.1767225600."+string(body)))
	svix := Map{"svix-id": "msg_1", "svix-timestamp": "1767225600", "svix-signature": "v1," + signature}
	for _, provider := range []string{"clerk", "resend"} {
		if valid, err := Signature(provider, body, svix, Options{Secret: secret}); !valid || err != nil {
			t.Errorf("%s: Signature = %v, %v", provider, valid, err)
		}
	}
	// Standard Webhooks itself does not read svix-* headers.
	if valid, _ := Signature("standard-webhooks", body, svix, Options{Secret: secret}); valid {
		t.Error("standard-webhooks accepted svix-* headers")
	}
}

func TestForwardedEmailReturnsTheEvent(t *testing.T) {
	t.Parallel()
	vector := forwardingVectorNamed(t, "forwarded email")
	event, err := ForwardedEmail([]byte(vector.Body), Map(vector.Headers), vector.Secret, WithNow(time.UnixMilli(int64(vector.Now))))
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != "email.received" || event.Timestamp == "" || event.ID != Map(vector.Headers).Get("webhook-id") {
		t.Errorf("event = %+v", event)
	}
	var data struct {
		Address string `json:"address"`
		Subject string `json:"subject"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(data.Address, "@mailhooks.cc") || data.Subject == "" {
		t.Errorf("data = %+v", data)
	}
}

func TestForwardedRequestReturnsTheEvent(t *testing.T) {
	t.Parallel()
	vector := forwardingVectorNamed(t, "forwarded request")
	event, err := ForwardedRequest([]byte(vector.Body), Map(vector.Headers), vector.Secret, WithNow(time.UnixMilli(int64(vector.Now))))
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Method string `json:"method"`
	}
	if event.Type != "request.received" || json.Unmarshal(event.Data, &data) != nil || data.Method == "" {
		t.Errorf("event = %+v", event)
	}
}

func TestForwardedToleranceIsAdjustable(t *testing.T) {
	t.Parallel()
	vector := forwardingVectorNamed(t, "forwarded email, timestamp more than 300 seconds old")
	now := WithNow(time.UnixMilli(int64(vector.Now)))
	_, err := ForwardedEmail([]byte(vector.Body), Map(vector.Headers), vector.Secret, now)
	var verr *Error
	if !errors.As(err, &verr) || verr.Code != CodeTimestampOutOfRange || verr.Message != "webhook-timestamp is more than 300 seconds from now" {
		t.Fatalf("err = %v", err)
	}
	if _, err := ForwardedEmail([]byte(vector.Body), Map(vector.Headers), vector.Secret, now, WithTolerance(time.Hour)); err != nil {
		t.Errorf("with an hour's tolerance: %v", err)
	}
}

func TestForwardedDuplicateKeysKeepTheLast(t *testing.T) {
	t.Parallel()
	secret := "whsec_" + sigutil.Base64([]byte("forwarding"))
	body := []byte(`{"type":"email.received","timestamp":"2026-01-01T00:00:00.000Z","data":{"x":1},"TYPE":"other","data":{"id":"e1","address":"a+b@mailhooks.cc","headers":{}}}`)
	signature := hmacSHA256Base64([]byte("forwarding"), []byte("msg_1.1767225600."+string(body)))
	headers := Map{"webhook-id": "msg_1", "webhook-timestamp": "1767225600", "webhook-signature": "v1," + signature}
	event, err := ForwardedEmail(body, headers, secret, WithNow(time.Unix(1767225600, 0)))
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != "email.received" || !strings.Contains(string(event.Data), `"e1"`) {
		t.Errorf("event = %+v, data %s", event, event.Data)
	}
}

func TestRelayedRequestReturnsTheMetadata(t *testing.T) {
	t.Parallel()
	vector := forwardingVectorNamed(t, "relayed request")
	headers := Map(vector.Headers)
	relayed, err := RelayedRequest([]byte(vector.Body), headers, vector.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if relayed.RequestID != headers.Get("webhooks-cc-request-id") || relayed.ReceivedAt != headers.Get("webhooks-cc-received-at") || relayed.Endpoint != headers.Get("webhooks-cc-endpoint") {
		t.Errorf("relayed = %+v", relayed)
	}

	for attempt, want := range map[string]int{"2": 2, "0": 0, "1.5": 0, "x": 0, " 3 ": 3, "0x2": 2, "Infinity": 0, "": 0} {
		withAttempt := Map{}
		for key, value := range vector.Headers {
			withAttempt[key] = value
		}
		withAttempt["webhooks-cc-attempt"] = attempt
		relayed, err := RelayedRequest([]byte(vector.Body), withAttempt, vector.Secret)
		if err != nil || relayed.Attempt != want {
			t.Errorf("attempt %q: got %+v, %v; want %d", attempt, relayed, err, want)
		}
	}
}

func TestTwilioReadsFormBodies(t *testing.T) {
	t.Parallel()
	const secret, url = "twilio_secret", "https://example.com/sms"
	payload := url + "BodyHi thereFrom+15557654321To+15551234567"
	signature := sigutil.Base64(sigutil.HMACSHA1([]byte(secret), []byte(payload)))
	form := "To=%2B15551234567&Body=Hi+there&From=%2B15557654321"
	for _, body := range []string{form, "?" + form, form + "&"} {
		valid, err := Signature("twilio", []byte(body), Map{"X-Twilio-Signature": signature}, Options{Secret: secret, URL: url})
		if err != nil || !valid {
			t.Errorf("%q: Signature = %v, %v", body, valid, err)
		}
	}
}

func TestMisuseIsAnError(t *testing.T) {
	t.Parallel()
	cases := []struct {
		provider string
		opts     Options
		want     string
	}{
		{"stripe", Options{}, "non-empty Options.Secret"},
		{"twilio", Options{Secret: "s"}, "requires Options.URL"},
		{"square", Options{Secret: "s"}, "requires Options.URL"},
		{"hubspot", Options{Secret: "s"}, "requires Options.URL"},
		{"discord", Options{}, "non-empty Options.PublicKey"},
		{"sendgrid", Options{Secret: "s"}, "SendGrid"},
		{"plaid", Options{Secret: "s"}, "Plaid"},
		{"acme", Options{Secret: "s"}, `unknown provider "acme"`},
	}
	for _, c := range cases {
		valid, err := Signature(c.provider, nil, Map{}, c.opts)
		if valid || err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: Signature = %v, %v; want an error containing %q", c.provider, valid, err, c.want)
		}
	}
	for _, check := range []func() error{
		func() error { _, err := ForwardedEmail(nil, Map{}, ""); return err },
		func() error { _, err := ForwardedRequest(nil, Map{}, ""); return err },
		func() error { _, err := RelayedRequest(nil, Map{}, ""); return err },
	} {
		err := check()
		var verr *Error
		if err == nil || errors.As(err, &verr) || !strings.Contains(err.Error(), "non-empty secret") {
			t.Errorf("an empty forwarding secret: %v", err)
		}
	}
}

func TestMissingSignatureIsNotAnError(t *testing.T) {
	t.Parallel()
	for _, provider := range Providers() {
		opts := Options{Secret: "s", PublicKey: strings.Repeat("ab", 32), URL: "https://example.com/hook"}
		valid, err := Signature(provider, []byte(`{}`), Map{}, opts)
		if valid || err != nil {
			t.Errorf("%s: Signature = %v, %v; want false, nil", provider, valid, err)
		}
	}
}

func TestProvidersIsACopy(t *testing.T) {
	t.Parallel()
	list := Providers()
	if len(list) != 32 || list[0] != "stripe" || slices.Contains(list, "sendgrid") || slices.Contains(list, "plaid") {
		t.Fatalf("Providers() = %v", list)
	}
	list[0] = "changed"
	if Providers()[0] != "stripe" {
		t.Error("Providers() returned the package's own slice")
	}
}

func TestJSNumber(t *testing.T) {
	t.Parallel()
	cases := map[string]float64{
		"1767225600":     1767225600,
		" 12 ":           12,
		"\u00a012\ufeff": 12,
		"1e3":            1000,
		"+1.5":           1.5,
		".5":             0.5,
		"5.":             5,
		"0x1F":           31,
		"0b101":          5,
		"0o17":           15,
		"":               0,
		"-Infinity":      math.Inf(-1),
	}
	for input, want := range cases {
		if got := jsNumber(input); got != want {
			t.Errorf("jsNumber(%q) = %v, want %v", input, got, want)
		}
	}
	for _, input := range []string{"abc", "1_000", "0x", "-0x1", "1e", "\u0661\u0662", "inf", "NaN", "0xG"} {
		if got := jsNumber(input); !math.IsNaN(got) {
			t.Errorf("jsNumber(%q) = %v, want NaN", input, got)
		}
	}
}

func TestBodyTextDecodesLikeTextDecoder(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"\xEF\xBB\xBFhi":     "hi",
		"a\xE2\x82b":         "a\ufffdb", // one replacement for a truncated sequence
		"a\xFFb":             "a\ufffdb",
		"\xF0\x9F\x98":       "\ufffd",
		"\xED\xA0\x80":       "\ufffd\ufffd\ufffd", // a surrogate is not a maximal subpart
		"caf\xC3\xA9 \ufffd": "caf\u00e9 \ufffd",
	}
	for input, want := range cases {
		if got := bodyText([]byte(input)); got != want {
			t.Errorf("bodyText(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSignatureHeaderPrefixesMatchASCIICaseOnly(t *testing.T) {
	t.Parallel()
	body := []byte("{}")
	signature := hmacSHA256Hex("s", body)
	for prefix, want := range map[string]bool{"sha256=": true, "SHA256=": true, "\u017fha256=": false} {
		valid, _ := Signature("github", body, Map{"x-hub-signature-256": prefix + strings.ToUpper(signature)}, Options{Secret: "s"})
		if valid != want {
			t.Errorf("prefix %q: Signature = %v, want %v", prefix, valid, want)
		}
	}
}
