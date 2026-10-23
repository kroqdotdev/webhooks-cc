package templates

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"webhooks.cc/go/internal/conformance"
	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/sigutil"
)

const adyenKey = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"

type signingVector struct {
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Secret    string `json:"secret"`
	Method    string `json:"method"`
	URL       string `json:"url"`
	Body      string `json:"body"`
	Timestamp int64  `json:"timestamp"`
	MessageID string `json:"messageId"`
	Expected  struct {
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"expected"`
}

func TestSigningVectors(t *testing.T) {
	var file struct {
		Version int             `json:"version"`
		Vectors []signingVector `json:"vectors"`
	}
	conformance.Load(t, "signing.json", &file)
	if file.Version != 1 {
		t.Fatalf("signing.json version %d, this port reads version 1", file.Version)
	}
	if len(file.Vectors) == 0 {
		t.Fatal("signing.json has no vectors")
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			t.Parallel()
			built, err := Build(v.URL, Params{
				Provider:  v.Provider,
				Secret:    v.Secret,
				Method:    v.Method,
				Body:      v.Body,
				Timestamp: time.Unix(v.Timestamp, 0),
				MessageID: v.MessageID,
			})
			if err != nil {
				t.Fatal(err)
			}
			for name, want := range v.Expected.Headers {
				if got := built.Headers[name]; got != want {
					t.Errorf("header %s = %q, want %q", name, got, want)
				}
			}
			if got := string(built.Body); got != v.Expected.Body {
				t.Errorf("body =\n%s\nwant\n%s", got, v.Expected.Body)
			}
			if built.Method != strings.ToUpper(v.Method) {
				t.Errorf("method = %q", built.Method)
			}
			if built.URL != v.URL {
				t.Errorf("url = %q", built.URL)
			}
		})
	}
}

// readTypeScript returns the TypeScript SDK's templates.ts, the catalog this
// port must match.
func readTypeScript(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(conformance.Dir(), "..", "src", "templates.ts"))
	if errors.Is(err, fs.ErrNotExist) && os.Getenv("CI") == "" {
		t.Skipf("templates.ts not found (%v); run the tests from the webhooks-cc repository", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

var quoted = regexp.MustCompile(`"([^"]+)"`)

func quotedStrings(text string) []string {
	var out []string
	for _, match := range quoted.FindAllStringSubmatch(text, -1) {
		out = append(out, match[1])
	}
	return out
}

func tsBlock(t *testing.T, source, pattern string) string {
	t.Helper()
	match := regexp.MustCompile(pattern).FindStringSubmatch(source)
	if match == nil {
		t.Fatalf("templates.ts has no match for %s", pattern)
	}
	return match[1]
}

func TestCatalogMatchesTypeScript(t *testing.T) {
	source := readTypeScript(t)
	want := quotedStrings(tsBlock(t, source, `(?s)export const TEMPLATE_PROVIDERS = \[(.*?)\] as const`))
	if got := Providers(); !slices.Equal(got, want) {
		t.Errorf("Providers() = %v\nwant %v", got, want)
	}
	for _, provider := range want {
		if _, ok := Lookup(provider); !ok {
			t.Errorf("Lookup(%q) failed", provider)
		}
	}
	if len(signingByProvider) != len(want) {
		t.Errorf("%d providers have metadata, want %d", len(signingByProvider), len(want))
	}

	templates := map[string][]string{}
	block := tsBlock(t, source, `(?s)const PROVIDER_TEMPLATES = \{(.*?)\n\} as const;`)
	for _, match := range regexp.MustCompile(`(?ms)^\s+("[\w-]+"|\w+): \[(.*?)\] as const`).FindAllStringSubmatch(block, -1) {
		templates[strings.Trim(match[1], `"`)] = quotedStrings(match[2])
	}
	defaults := map[string]string{}
	block = tsBlock(t, source, `(?s)const DEFAULT_TEMPLATE_BY_PROVIDER = \{(.*?)\n\} as const;`)
	for _, match := range regexp.MustCompile(`(?m)^\s+("[\w-]+"|\w+): "([^"]+)",`).FindAllStringSubmatch(block, -1) {
		defaults[strings.Trim(match[1], `"`)] = match[2]
	}
	if len(templates) != len(want)-1 { // standard-webhooks has none
		t.Errorf("templates.ts lists templates for %d providers, want %d", len(templates), len(want)-1)
	}
	for _, provider := range want {
		info, _ := Lookup(provider)
		if !slices.Equal(info.Templates, templates[provider]) {
			t.Errorf("%s templates = %v, want %v", provider, info.Templates, templates[provider])
		}
		if info.DefaultTemplate != defaults[provider] {
			t.Errorf("%s default template = %q, want %q", provider, info.DefaultTemplate, defaults[provider])
		}
	}
}

func TestLookupReturnsCopies(t *testing.T) {
	info, _ := Lookup("stripe")
	info.Templates[0] = "changed"
	if again, _ := Lookup("stripe"); again.Templates[0] != "payment_intent.succeeded" {
		t.Error("Lookup shares its templates slice")
	}
	providers := Providers()
	providers[0] = "changed"
	if Providers()[0] != "stripe" {
		t.Error("Providers shares its slice")
	}
	if _, ok := Lookup("acme"); ok {
		t.Error("Lookup found an unknown provider")
	}
}

func TestEveryTemplateBuilds(t *testing.T) {
	for _, provider := range Providers() {
		info, _ := Lookup(provider)
		templates := info.Templates
		if len(templates) == 0 {
			templates = []string{""}
		}
		for _, template := range templates {
			t.Run(provider+"/"+template, func(t *testing.T) {
				t.Parallel()
				secret := "test_secret"
				if provider == "adyen" {
					secret = adyenKey
				}
				built, err := Build("https://example.com/hooks", Params{Provider: provider, Secret: secret, Template: template})
				if err != nil {
					t.Fatal(err)
				}
				if built.Method != "POST" {
					t.Errorf("method = %q", built.Method)
				}
				if len(built.Body) == 0 {
					t.Fatal("empty body")
				}
				switch contentType := built.Headers["content-type"]; contentType {
				case contentJSON:
					if !json.Valid(built.Body) {
						t.Errorf("body is not JSON: %s", built.Body)
					}
				case contentForm:
					values, err := url.ParseQuery(string(built.Body))
					if err != nil || len(values) == 0 {
						t.Errorf("body is not a form: %s (%v)", built.Body, err)
					}
				default:
					t.Errorf("content-type = %q", contentType)
				}
				if info.SignatureHeader != "" && built.Headers[info.SignatureHeader] == "" {
					t.Errorf("no %s header", info.SignatureHeader)
				}
				if template != "" && built.Headers["x-webhooks-cc-template-template"] != template {
					t.Errorf("template header = %q", built.Headers["x-webhooks-cc-template-template"])
				}
			})
		}
	}
}

func TestSecretlessProvidersBuildWithoutASecret(t *testing.T) {
	for _, provider := range []string{"sendgrid", "discord", "plaid"} {
		info, _ := Lookup(provider)
		if info.SecretRequired {
			t.Errorf("%s requires a secret", provider)
		}
		built, err := Build("https://example.com/", Params{Provider: provider})
		if err != nil || len(built.Body) == 0 {
			t.Errorf("%s: %v", provider, err)
		}
	}
	built, _ := Build("https://example.com/", Params{Provider: "plaid", Timestamp: time.Unix(1767225600, 0)})
	parts := strings.Split(built.Headers["plaid-verification"], ".")
	if len(parts) != 3 || parts[2] != "mock-signature" {
		t.Fatalf("plaid-verification = %q", built.Headers["plaid-verification"])
	}
	payload, _ := sigutil.DecodeBase64(strings.NewReplacer("-", "+", "_", "/").Replace(parts[1]))
	if want := `{"iat":1767225600,"request_body_sha256":"mock-template-not-verifiable"}`; string(payload) != want {
		t.Errorf("plaid JWT payload = %s", payload)
	}
	built, _ = Build("https://example.com/", Params{Provider: "discord", Timestamp: time.Unix(1767225600, 0)})
	if built.Headers["x-signature-timestamp"] != "1767225600" {
		t.Errorf("x-signature-timestamp = %q", built.Headers["x-signature-timestamp"])
	}
}

func TestErrors(t *testing.T) {
	cases := []struct {
		params Params
		want   string
	}{
		{Params{Provider: "stripe"}, `provider "stripe" templates require a non-empty secret`},
		{Params{Provider: "standard-webhooks"}, `provider "standard-webhooks" templates require a non-empty secret`},
		{Params{Provider: "github", Secret: "s", Template: "nope"}, `unsupported template "nope" for provider "github" (supported: push, pull_request.opened, ping)`},
		{Params{Provider: "sendgrid", Template: "nope"}, `unsupported template "nope" for provider "sendgrid" (supported: delivered, open, bounce, spam_report)`},
		{Params{Provider: "acme", Secret: "s"}, `unsupported provider "acme"`},
		{Params{Provider: "github", Secret: "s", Body: []byte{0xff, 0xfe}}, "a signed body given as bytes must be UTF-8 text"},
		{Params{Provider: "github", Secret: "s", Body: func() {}}, "json: unsupported type: func()"},
		{Params{Provider: "mailgun", Secret: "s", Body: "not json"}, "mailgun template body: invalid character 'o' in literal null (expecting 'u')"},
		{Params{Provider: "mailgun", Secret: "s", Body: "5"}, "mailgun template body must be a JSON object"},
		{Params{Provider: "adyen", Secret: adyenKey, Body: "null"}, "adyen template body must be a JSON object"},
		{Params{Provider: "adyen", Secret: adyenKey, Body: `{"notificationItems":5}`}, "adyen notificationItems must be an array"},
	}
	for _, c := range cases {
		_, err := Build("https://example.com/", c.params)
		if err == nil || err.Error() != c.want {
			t.Errorf("Build(%+v) error = %v, want %q", c.params, err, c.want)
		}
	}
}

func TestBodiesSerializeLikeJSONStringify(t *testing.T) {
	built, err := Build("https://example.com/", Params{
		Provider: "github",
		Secret:   "s",
		Body:     o("amount", 20.0, "note", "café ✓ <b>", "items", list{1, nil, true}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"amount":20,"note":"café ✓ <b>","items":[1,null,true]}`; string(built.Body) != want {
		t.Errorf("body = %s, want %s", built.Body, want)
	}
	if want := "sha256=" + sigutil.Hex(sigutil.HMACSHA256([]byte("s"), built.Body)); built.Headers["x-hub-signature-256"] != want {
		t.Errorf("signature = %s, want %s", built.Headers["x-hub-signature-256"], want)
	}

	type order struct {
		ID    string `json:"id"`
		Total int    `json:"total"`
	}
	for _, c := range []struct {
		body any
		want string
	}{
		{order{ID: "o_1", Total: 5}, `{"id":"o_1","total":5}`},
		{map[string]any{"b": 1, "a": "<&>"}, `{"a":"<&>","b":1}`},
		{json.RawMessage(`{ "kept": "as is" }`), `{ "kept": "as is" }`},
		{[]byte(`raw text`), `raw text`},
		{"", ""},
	} {
		built, err := Build("https://example.com/", Params{Provider: "github", Secret: "s", Body: c.body})
		if err != nil {
			t.Fatal(err)
		}
		if string(built.Body) != c.want {
			t.Errorf("body for %#v = %s, want %s", c.body, built.Body, c.want)
		}
	}
}

func TestHeadersAreAddedLastAndOverride(t *testing.T) {
	built, err := Build("https://example.com/", Params{
		Provider: "stripe",
		Secret:   "s",
		Method:   "put",
		Headers:  map[string]string{"user-agent": "acme-test", "x-extra": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if built.Method != "PUT" || built.Headers["user-agent"] != "acme-test" || built.Headers["x-extra"] != "1" {
		t.Errorf("method %q, headers %v", built.Method, built.Headers)
	}
	built, _ = Build("https://example.com/", Params{
		Provider: "standard-webhooks",
		Secret:   "whsec_dGVzdA==",
		Headers:  map[string]string{"webhook-id": "msg_override"},
	})
	if built.Headers["webhook-id"] != "msg_override" {
		t.Errorf("webhook-id = %q", built.Headers["webhook-id"])
	}
}

func TestEventOverridesTheTemplateEvent(t *testing.T) {
	built, _ := Build("https://example.com/", Params{Provider: "github", Secret: "s", Template: "pull_request.opened"})
	if built.Headers["x-github-event"] != "pull_request" {
		t.Errorf("x-github-event = %q", built.Headers["x-github-event"])
	}
	built, _ = Build("https://example.com/", Params{Provider: "stripe", Secret: "s", Event: "charge.refunded"})
	var body struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(built.Body, &body); err != nil || body.Type != "charge.refunded" {
		t.Errorf("type = %q (%v)", body.Type, err)
	}
	if built.Headers["x-webhooks-cc-template-event"] != "charge.refunded" {
		t.Errorf("event header = %q", built.Headers["x-webhooks-cc-template-event"])
	}
	built, _ = Build("https://example.com/", Params{Provider: "sentry", Secret: "s", Template: "error.created"})
	if built.Headers["sentry-hook-resource"] != "error" {
		t.Errorf("sentry-hook-resource = %q", built.Headers["sentry-hook-resource"])
	}
}

func TestStandardWebhooksMessageIDs(t *testing.T) {
	built, _ := Build("https://example.com/", Params{Provider: "standard-webhooks", Secret: "whsec_dGVzdA==", Event: "order.paid"})
	if !regexp.MustCompile(`^msg_order\.paid_[0-9a-f]{8}$`).MatchString(built.Headers["webhook-id"]) {
		t.Errorf("webhook-id = %q", built.Headers["webhook-id"])
	}
	if string(built.Body) != "{}" {
		t.Errorf("body = %s", built.Body)
	}
	built, _ = Build("https://example.com/", Params{Provider: "standard-webhooks", Secret: "x"})
	if !regexp.MustCompile(`^msg_[0-9a-f]{16}$`).MatchString(built.Headers["webhook-id"]) {
		t.Errorf("webhook-id = %q", built.Headers["webhook-id"])
	}
	built, _ = Build("https://example.com/", Params{Provider: "resend", Secret: "whsec_dGVzdA=="})
	if !regexp.MustCompile(`^msg_[0-9a-f]{24}$`).MatchString(built.Headers["svix-id"]) {
		t.Errorf("svix-id = %q", built.Headers["svix-id"])
	}
}

func TestSlackSlashCommandIsFormEncodedLikeURLSearchParams(t *testing.T) {
	built, err := Build("https://example.com/", Params{
		Provider:  "slack",
		Secret:    "s",
		Template:  "slash_command",
		Body:      o("text", "a b~*'!", "count", 1, "empty", nil, "flag", false, "list", list{1, nil, "x"}, "nested", o("a", 1)),
		Timestamp: time.Unix(1767225600, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if built.Headers["content-type"] != contentForm {
		t.Errorf("content-type = %q", built.Headers["content-type"])
	}
	if want := "text=a+b%7E*%27%21&count=1&empty=&flag=false&list=1%2C%2Cx&nested=%5Bobject+Object%5D"; string(built.Body) != want {
		t.Errorf("body = %s\nwant   %s", built.Body, want)
	}
	digest := sigutil.Hex(sigutil.HMACSHA256([]byte("s"), []byte("v0:1767225600:"+string(built.Body))))
	if built.Headers["x-slack-signature"] != "v0="+digest {
		t.Errorf("x-slack-signature = %q", built.Headers["x-slack-signature"])
	}
	for _, body := range []any{list{1}, 5, true} {
		_, err := Build("https://example.com/", Params{Provider: "slack", Secret: "s", Template: "slash_command", Body: body})
		if err == nil || err.Error() != "slack slash_command body override must be a string or an object" {
			t.Errorf("body %v: error = %v", body, err)
		}
	}
	built, _ = Build("https://example.com/", Params{Provider: "slack", Secret: "s", Template: "slash_command", Body: "text=as+is"})
	if string(built.Body) != "text=as+is" {
		t.Errorf("body = %s", built.Body)
	}
}

func TestFormEncodingMatchesURLSearchParams(t *testing.T) {
	got := formEncode([][2]string{{"a b", "é/?&=+"}, {"~", "*-._"}, {"bad", "\xff"}})
	if want := "a+b=%C3%A9%2F%3F%26%3D%2B&%7E=*-._&bad=%EF%BF%BD"; got != want {
		t.Errorf("formEncode = %s\nwant        %s", got, want)
	}
	decoded := formDecode("?a=1&&b&c=x+y%2Bz&a=%zz%4&d=%E2%82&e=%F0%9F%98%80=")
	want := [][2]string{{"a", "1"}, {"b", ""}, {"c", "x y+z"}, {"a", "%zz%4"}, {"d", "�"}, {"e", "😀="}}
	if !slices.Equal(decoded, want) {
		t.Errorf("formDecode = %q\nwant %q", decoded, want)
	}
	if got := decodeUTF8([]byte("a\xff\xfeb\xed\xa0\x80c")); got != "a��b���c" {
		t.Errorf("decodeUTF8 = %q", got)
	}
}

func TestTwilioSignsObjectOverridesBySortedParameters(t *testing.T) {
	const target = "https://example.com/sms"
	built, err := Build(target, Params{Provider: "twilio", Secret: "s", Body: o("To", "+1 555", "Body", "Hi")})
	if err != nil {
		t.Fatal(err)
	}
	if string(built.Body) != "To=%2B1+555&Body=Hi" {
		t.Errorf("body = %s", built.Body)
	}
	want := sigutil.Base64(sigutil.HMACSHA1([]byte("s"), []byte(target+"BodyHiTo+1 555")))
	if built.Headers["x-twilio-signature"] != want {
		t.Errorf("x-twilio-signature = %q, want %q", built.Headers["x-twilio-signature"], want)
	}
	built, _ = Build(target, Params{Provider: "twilio", Secret: "s", Body: "To=%2B1+555&Body=Hi"})
	if built.Headers["x-twilio-signature"] != want {
		t.Errorf("string override: x-twilio-signature = %q, want %q", built.Headers["x-twilio-signature"], want)
	}
	_, err = Build(target, Params{Provider: "twilio", Secret: "s", Body: 5})
	if err == nil || err.Error() != "twilio template body override must be a string or an object" {
		t.Errorf("error = %v", err)
	}
	built, _ = Build(target, Params{Provider: "twilio", Secret: "s", Template: "voice.incoming_call"})
	values, _ := url.ParseQuery(string(built.Body))
	if values.Get("CallStatus") != "ringing" {
		t.Errorf("body = %s", built.Body)
	}
}

func TestMailgunTemplateSignsItsOwnTimestampAndToken(t *testing.T) {
	built, err := Build("https://example.com/", Params{Provider: "mailgun", Secret: "key"})
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Signature struct {
			Timestamp string `json:"timestamp"`
			Token     string `json:"token"`
			Signature string `json:"signature"`
		} `json:"signature"`
	}
	if err := json.Unmarshal(built.Body, &body); err != nil {
		t.Fatal(err)
	}
	signature := body.Signature
	if want := sigutil.Hex(sigutil.HMACSHA256([]byte("key"), []byte(signature.Timestamp+signature.Token))); signature.Signature != want {
		t.Errorf("signature = %q, want %q", signature.Signature, want)
	}
	if len(signature.Token) != 50 {
		t.Errorf("token %q has %d characters", signature.Token, len(signature.Token))
	}
}

func TestMailgunBodyWithoutASignatureGetsOne(t *testing.T) {
	built, err := Build("https://example.com/", Params{
		Provider:  "mailgun",
		Secret:    "key",
		Body:      o("a", 1),
		Timestamp: time.Unix(1700000000, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := jsonx.Parse(built.Body)
	object := parsed.(jsonx.Object)
	if len(object) != 2 || object[0].Key != "a" || object[1].Key != "signature" {
		t.Fatalf("body = %s", built.Body)
	}
	if timestamp, _ := object[1].Value.(jsonx.Object).Get("timestamp"); timestamp != "1700000000" {
		t.Errorf("timestamp = %v", timestamp)
	}
	// An array keeps its items: JSON.stringify drops a property set on an array.
	built, _ = Build("https://example.com/", Params{Provider: "mailgun", Secret: "key", Body: "[1, 2]"})
	if string(built.Body) != "[1,2]" {
		t.Errorf("body = %s", built.Body)
	}
}

func TestAdyenSignsEveryItem(t *testing.T) {
	body := o(
		"live", "false",
		"notificationItems", list{
			o("NotificationRequestItem", o("pspReference", "1", "success", "true")),
			o("NotificationRequestItem", o(
				"pspReference", "2",
				"additionalData", o("hmacSignature", "old", "other", "x"),
				"amount", o("value", 500, "currency", "EUR"),
			)),
			o("NotificationRequestItem", "not an item"),
		},
	)
	built, err := Build("https://example.com/", Params{Provider: "adyen", Secret: adyenKey, Body: body})
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := jsonx.Parse(built.Body)
	itemsValue, _ := parsed.(jsonx.Object).Get("notificationItems")
	var items []jsonx.Object
	for _, wrapper := range itemsValue.([]any) {
		if item, _ := wrapper.(jsonx.Object).Get("NotificationRequestItem"); item != nil {
			if object, ok := item.(jsonx.Object); ok {
				items = append(items, object)
			}
		}
	}
	if len(items) != 2 {
		t.Fatalf("body = %s", built.Body)
	}
	for _, item := range items {
		want, _ := sigutil.AdyenHMAC(item, adyenKey)
		additional, _ := item.Get("additionalData")
		if got, _ := additional.(jsonx.Object).Get("hmacSignature"); got != want {
			t.Errorf("hmacSignature = %v, want %s", got, want)
		}
	}
	additional, _ := items[1].Get("additionalData")
	if keys := []string{additional.(jsonx.Object)[0].Key, additional.(jsonx.Object)[1].Key}; !slices.Equal(keys, []string{"hmacSignature", "other"}) {
		t.Errorf("additionalData keys = %v", keys)
	}
	_, err = Build("https://example.com/", Params{Provider: "adyen", Secret: "not-hex"})
	if err == nil || !strings.Contains(err.Error(), "hex") {
		t.Errorf("error = %v", err)
	}
	// A body without notification items is sent as it is.
	built, _ = Build("https://example.com/", Params{Provider: "adyen", Secret: adyenKey, Body: `{ "live": "false" }`})
	if string(built.Body) != `{ "live": "false" }` {
		t.Errorf("body = %s", built.Body)
	}
}

func TestHubSpotAndWorkOSUseMilliseconds(t *testing.T) {
	built, _ := Build("https://example.com/", Params{Provider: "hubspot", Secret: "s", Timestamp: time.Unix(1767225600, 0)})
	if built.Headers["x-hubspot-request-timestamp"] != "1767225600000" {
		t.Errorf("x-hubspot-request-timestamp = %q", built.Headers["x-hubspot-request-timestamp"])
	}
	built, _ = Build("https://example.com/", Params{Provider: "workos", Secret: "s", Timestamp: time.Unix(1767225600, 0)})
	if !strings.HasPrefix(built.Headers["workos-signature"], "t=1767225600000, v1=") {
		t.Errorf("workos-signature = %q", built.Headers["workos-signature"])
	}
}

func TestPayPalPlaceholderHeaders(t *testing.T) {
	built, _ := Build("https://example.com/", Params{Provider: "paypal", Secret: "WH-1", Timestamp: time.Unix(1767225600, 0)})
	if built.Headers["paypal-transmission-time"] != "2026-01-01T00:00:00.000Z" {
		t.Errorf("paypal-transmission-time = %q", built.Headers["paypal-transmission-time"])
	}
	if built.Headers["paypal-auth-algo"] != "SHA256withRSA" {
		t.Errorf("paypal-auth-algo = %q", built.Headers["paypal-auth-algo"])
	}
	if !strings.HasPrefix(built.Headers["paypal-cert-url"], "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-") {
		t.Errorf("paypal-cert-url = %q", built.Headers["paypal-cert-url"])
	}
}

func TestRandomValuesHaveTheirShape(t *testing.T) {
	if got := randomHex(7); !regexp.MustCompile(`^[0-9a-f]{7}$`).MatchString(got) {
		t.Errorf("randomHex(7) = %q", got)
	}
	if got := randomDigits(12); !regexp.MustCompile(`^[0-9]{12}$`).MatchString(got) {
		t.Errorf("randomDigits(12) = %q", got)
	}
	if got := randomUUID(); !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(got) {
		t.Errorf("randomUUID() = %q", got)
	}
	if got := isoTime(1767225600123); got != "2026-01-01T00:00:00.123Z" {
		t.Errorf("isoTime = %q", got)
	}
}
